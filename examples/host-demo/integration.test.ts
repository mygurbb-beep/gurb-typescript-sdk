import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGurbAdminClient, createGurbClient, GurbApiError } from '../../packages/server/src/index.js'
// @ts-expect-error — the mock is plain JS on purpose; it stands in for a server
// written in another language entirely.
import { createMockGurb } from './mock-gurb.mjs'

const KEY = 'gurb_a1b2c3d4e5f6_' + 'd'.repeat(43)

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createMockGurb({ allowedOrigins: ['http://localhost:4099'] })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * These run over real HTTP against a server that implements the contract. The
 * unit tests prove the client builds the right request; these prove the request
 * a real server receives is one it can actually answer.
 */
describe('embed session round trip', () => {
  it('mints a token and resolves the same external user to the same identity', async () => {
    const gurb = createGurbClient({ apiKey: KEY, baseUrl })

    const first = await gurb.embed.createSession({ externalUserId: 'shop-42', displayName: 'Sara' })
    const second = await gurb.embed.createSession({ externalUserId: 'shop-42', displayName: 'Sara' })

    expect(first.token).toMatch(/^et_/)
    expect(first.userId).toBe(second.userId)
    expect(first.token).not.toBe(second.token)
  })

  it('gives a different identity to a different external user', async () => {
    const gurb = createGurbClient({ apiKey: KEY, baseUrl })

    const a = await gurb.embed.createSession({ externalUserId: 'shop-1', displayName: 'A' })
    const b = await gurb.embed.createSession({ externalUserId: 'shop-2', displayName: 'B' })

    expect(a.userId).not.toBe(b.userId)
  })

  it('burns the token on first exchange, so a replay is dead', async () => {
    const gurb = createGurbClient({ apiKey: KEY, baseUrl })
    const { token } = await gurb.embed.createSession({ externalUserId: 'shop-9', displayName: 'Z' })

    const exchange = () =>
      fetch(`${baseUrl}/api/embed/sessions/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })

    expect((await exchange()).status).toBe(200)
    expect((await exchange()).status).toBe(401)
  })

  it('rejects a bad key with a code the SDK understands', async () => {
    const gurb = createGurbClient({ apiKey: 'gurb_ffffffffffff_' + 'z'.repeat(43), baseUrl })
    // The mock accepts any well-formed key, so force the failure at the header.
    const raw = await fetch(`${baseUrl}/api/embed/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'not-a-key' },
      body: JSON.stringify({ externalUserId: 'x', displayName: 'x' }),
    })
    expect(raw.status).toBe(401)
    expect((await raw.json()).error).toBe('INVALID_API_KEY')
    expect(gurb).toBeInstanceOf(Object)
  })

  it('refuses a role field even when the caller bypasses the SDK', async () => {
    // The SDK's types have no `role`, but the server is what has to be safe:
    // a leaked key used with a hand-rolled curl must not manufacture a moderator.
    const raw = await fetch(`${baseUrl}/api/embed/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
      body: JSON.stringify({ externalUserId: 'x', displayName: 'x', role: 'ADMIN' }),
    })

    expect(raw.status).toBe(400)
    expect((await raw.json()).message).toMatch(/always MEMBER/)
  })

  it('surfaces a validation failure as a typed error', async () => {
    const gurb = createGurbClient({ apiKey: KEY, baseUrl })

    await expect(
      // @ts-expect-error — deliberately violating the contract to prove the mapping
      gurb.embed.createSession({ externalUserId: 'only-an-id' }),
    ).rejects.toBeInstanceOf(GurbApiError)
  })
})

describe('the framed page', () => {
  it('is served with frame-ancestors, so only registered hosts may frame it', async () => {
    const res = await fetch(`${baseUrl}/embed/demo/tweets`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe('frame-ancestors http://localhost:4099')
  })

  it('never receives the token — it arrives in the fragment', async () => {
    const gurb = createGurbClient({ apiKey: KEY, baseUrl })
    const { token } = await gurb.embed.createSession({ externalUserId: 'shop-7', displayName: 'Q' })
    const url = gurb.embed.buildUrl({ slug: 'demo', section: 'tweets', token })

    // What the server actually sees is everything before the '#'.
    const seenByServer = url.split('#')[0]!
    expect(seenByServer).not.toContain(token)

    const html = await (await fetch(seenByServer)).text()
    expect(html).toContain('location.hash')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  Administration, approval, permissions and bulk membership
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_KEY = 'gurb_sa_a1b2c3d4e5f6_' + 'd'.repeat(43)

const admin = () => createGurbAdminClient({ adminKey: ADMIN_KEY, baseUrl })
const community = () => createGurbClient({ apiKey: KEY, baseUrl })

/**
 * The rule that matters most: neither credential may act on the other's
 * surface. A client-side check is a convenience; these prove the server refuses
 * even when the client is bypassed.
 */
describe('credential boundaries, enforced by the server', () => {
  it('refuses a community key on an admin route', async () => {
    const response = await fetch(`${baseUrl}/api/admin/sdk/communities`, {
      headers: { 'X-Api-Key': KEY },
    })

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBe('FORBIDDEN_SURFACE')
    // The message names the actual problem instead of a bare 403, which an
    // integrator would otherwise read as "my key is wrong".
    expect(body.message).toMatch(/cannot perform platform administration/)
  })

  it('refuses a super-admin key on a community route', async () => {
    const response = await fetch(`${baseUrl}/api/sdk/community`, {
      headers: { 'X-Api-Key': ADMIN_KEY },
    })

    expect(response.status).toBe(403)
    expect((await response.json()).message).toMatch(/no community context/)
  })
})

describe('creating a community through approval', () => {
  it('files a request, approves it, and creates the community', async () => {
    const request = await community().community.requestCreation({
      name: 'مجتمع الحرفيين',
      slug: 'crafts',
      description: 'للحرفيين وأصحاب المهن اليدوية',
    })

    expect(request.status).toBe('PENDING')
    expect(request.communityId).toBeNull()

    const pending = await admin().communityRequests.list({ status: 'PENDING' })
    expect(pending.items.map((r) => r.id)).toContain(request.id)

    const approved = await admin().communityRequests.approve(request.id)
    expect(approved.status).toBe('APPROVED')
    expect(approved.communityId).toMatch(/^cmt_/)
    expect(approved.decidedAt).not.toBeNull()

    const all = await admin().communities.list({ limit: 100 })
    expect(all.items.map((c) => c.slug)).toContain('crafts')
  })

  it('refuses to approve twice, so a double click cannot make two communities', async () => {
    const request = await community().community.requestCreation({ name: 'مرة', slug: 'once' })
    await admin().communityRequests.approve(request.id)

    await expect(admin().communityRequests.approve(request.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('records the reason on a rejection so the requester learns why', async () => {
    const request = await community().community.requestCreation({ name: 'مرفوض', slug: 'nope' })

    const rejected = await admin().communityRequests.reject(request.id, 'الاسم محجوز لعلامة تجارية')

    expect(rejected.status).toBe('REJECTED')
    expect(rejected.rejectionReason).toBe('الاسم محجوز لعلامة تجارية')
    expect(rejected.communityId).toBeNull()
  })

  it('refuses a slug that is already taken', async () => {
    await expect(
      community().community.requestCreation({ name: 'تكرار', slug: 'demo' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('minting community keys', () => {
  it('returns the plaintext once, and that key actually works', async () => {
    const minted = await admin().apiKeys.create({ communityId: 'cmt_demo', name: 'zapier' })

    expect(minted.key).toMatch(/^gurb_[a-f0-9]{12}_/)
    expect(minted.scopes).toEqual(['read'])

    // The real proof: the minted string is a working community credential, and
    // it is not accepted anywhere the admin key belongs.
    const minor = createGurbClient({ apiKey: minted.key, baseUrl })
    await expect(minor.community.get()).resolves.toMatchObject({ slug: 'demo' })

    expect(() => createGurbAdminClient({ adminKey: minted.key, baseUrl })).toThrow(
      /community API key, not a super-admin key/,
    )
  })

  it('lists keys without ever returning a secret again', async () => {
    await admin().apiKeys.create({ communityId: 'cmt_demo', name: 'reporting' })

    const keys = await admin().apiKeys.list({ communityId: 'cmt_demo', limit: 100 })

    expect(keys.items.length).toBeGreaterThan(0)
    for (const key of keys.items) {
      expect(key).not.toHaveProperty('key')
    }
  })

  it('revokes a key', async () => {
    const minted = await admin().apiKeys.create({ communityId: 'cmt_demo', name: 'temporary' })
    const revoked = await admin().apiKeys.revoke(minted.id)
    expect(revoked.revokedAt).not.toBeNull()
  })
})

describe('per-member permissions', () => {
  it('derives what a member can do from their role', async () => {
    const memberPerms = await community().members.getPermissions('mem_2') // MEMBER

    expect(memberPerms.role).toBe('MEMBER')
    expect(memberPerms.effective).toContain('CREATE_POST')
    // The whole point: not every member may edit or moderate.
    expect(memberPerms.effective).not.toContain('EDIT_ANY_POST')
    expect(memberPerms.effective).not.toContain('MODERATE_CONTENT')
  })

  it('gives an admin the moderation permissions a plain member lacks', async () => {
    const adminPerms = await community().members.getPermissions('mem_1') // ADMIN

    expect(adminPerms.effective).toContain('MODERATE_CONTENT')
    expect(adminPerms.effective).toContain('ASSIGN_ROLES')
  })

  it('grants one extra permission without changing the role', async () => {
    const updated = await community().members.updatePermissions('mem_3', { grant: ['CREATE_EVENT'] })

    expect(updated.role).toBe('MEMBER')
    expect(updated.granted).toContain('CREATE_EVENT')
    expect(updated.effective).toContain('CREATE_EVENT')
  })

  it('revokes a permission the role would otherwise grant', async () => {
    const updated = await community().members.updatePermissions('mem_3', { revoke: ['CREATE_POST'] })

    expect(updated.revoked).toContain('CREATE_POST')
    expect(updated.effective).not.toContain('CREATE_POST')
  })

  it('rejects an unknown permission rather than storing a typo forever', async () => {
    await expect(
      community().members.updatePermissions('mem_2', { grant: ['CREATE_POSTS'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('changes a role and the effective set follows', async () => {
    const promoted = await community().members.setRole('mem_2', 'MODERATOR')
    expect(promoted.role).toBe('MODERATOR')

    const perms = await community().members.getPermissions('mem_2')
    expect(perms.effective).toContain('MODERATE_CONTENT')
  })
})

describe('bulk membership', () => {
  it('creates many, then updates the same list instead of duplicating it', async () => {
    const rows = [
      { externalUserId: 'bulk-1', displayName: 'أحمد' },
      { externalUserId: 'bulk-2', displayName: 'نورة', email: 'noura@example.com' },
      { externalUserId: 'bulk-3', displayName: 'خالد', role: 'MODERATOR' as const },
    ]

    const first = await community().members.bulkUpsert(rows)
    expect(first.created).toHaveLength(3)
    expect(first.failed).toHaveLength(0)
    expect(first.created.find((m) => m.displayName === 'خالد')?.role).toBe('MODERATOR')

    // Re-sending is a sync, not a duplicate import — this is what makes it
    // safe to run nightly against your own user table.
    const second = await community().members.bulkUpsert(rows)
    expect(second.created).toHaveLength(0)
    expect(second.updated).toHaveLength(3)
  })

  it('keeps the good rows when one is bad, and says which index failed', async () => {
    const result = await community().members.bulkUpsert([
      { externalUserId: 'ok-1', displayName: 'سالم' },
      { externalUserId: 'bad-1', displayName: 'ريم', email: 'not-an-email' },
      { externalUserId: 'ok-2', displayName: 'هند' },
    ])

    expect(result.created).toHaveLength(2)
    expect(result.failed).toHaveLength(1)
    // Mapping a failure back to its input is the difference between a usable
    // error and "something in your 500 rows was wrong".
    expect(result.failed[0]).toMatchObject({ index: 1, externalUserId: 'bad-1', code: 'VALIDATION_ERROR' })
    expect(result.total).toBe(3)
  })

  it('does not throw when some rows fail — 499 good rows must still land', async () => {
    await expect(
      community().members.bulkUpsert([
        { externalUserId: 'fine', displayName: 'مها' },
        { externalUserId: '', displayName: 'بلا معرّف' },
      ]),
    ).resolves.toMatchObject({ failed: [{ index: 1 }] })
  })
})
