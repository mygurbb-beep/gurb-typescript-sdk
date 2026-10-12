import { describe, expect, it, vi } from 'vitest'
import { GurbPartnerEvents, signPartnerEvent } from './partner-events.js'
import { GurbApiError, toApiError } from './errors.js'

/** Every local refusal is the SDK's usual shape: GurbApiError, VALIDATION_ERROR, status 0. */
function expectLocalRefusal(fn: () => unknown, message?: RegExp) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(GurbApiError)
    expect((e as GurbApiError).code).toBe('VALIDATION_ERROR')
    expect((e as GurbApiError).status).toBe(0)
    if (message) expect((e as GurbApiError).message).toMatch(message)
    return
  }
  throw new Error('expected a local refusal')
}

const COMMUNITY = '00000000-0000-4000-8000-000000000001'
const SECRET = 'whsec_Z3VyYi1zZGstdGVzdC12ZWN0b3Itc2VjcmV0LTMyYnl0ZXMhIQ=='
const SUB = 'riyadah_46ed90e0612a692ced18fcb7f2711d6e422238e041639abd2b036566ba50ddd5'

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

const client = (fetch?: typeof globalThis.fetch) =>
  new GurbPartnerEvents({ communityId: COMMUNITY, secret: SECRET, baseUrl: 'https://community.example.com/', ...(fetch ? { fetch } : {}) })

const data = (evt: { body: string }) => JSON.parse(evt.body) as { id: string; type: string; community: string; created_at: string; data: Record<string, unknown> }

describe('signing is Standard Webhooks, byte-for-byte what Gurb verifies', () => {
  it('matches a vector produced by the `standardwebhooks` library Gurb\'s receiver uses', () => {
    // Computed with `new Webhook(secret).sign(id, new Date(ts * 1000), body)` from
    // the backend's own dependency — so this pins the SDK to the receiver, not to itself.
    const id = 'evt_0123456789abcdef0123456789abcdef'
    const body = JSON.stringify({ id, type: 'ping', created_at: '2026-10-12T00:00:00.000Z', community: COMMUNITY, data: { sub: null, state_version: 0, message: 'ping' } })
    expect(signPartnerEvent([SECRET], id, 1790000000, body)).toBe('v1,mO6Ip3mTmriAFclHsH7jq2M6KbaI2UCWOR1hqAXdouw=')
  })

  it('signs with every secret during a rotation, space-separated', () => {
    const other = 'whsec_' + Buffer.alloc(32, 9).toString('base64')
    const sig = signPartnerEvent([other, SECRET], 'evt_x', 1, '{}')
    expect(sig.split(' ')).toHaveLength(2)
    expect(sig.split(' ').every((s) => s.startsWith('v1,'))).toBe(true)
  })
})

describe('construction refuses the wrong credentials', () => {
  it('a Gurb API key is not an events secret', () => {
    expectLocalRefusal(() => new GurbPartnerEvents({ communityId: COMMUNITY, secret: 'gurb_a1b2c3d4e5f6_' + 'x'.repeat(43) }), /separate credentials/)
  })
  it('anything that is not whsec_<base64 of ≥ 24 bytes>', () => {
    for (const secret of ['', 'whsec_', 'whsec_abc', 'sk_live_123', 'whsec_' + Buffer.alloc(8).toString('base64')]) {
      expectLocalRefusal(() => new GurbPartnerEvents({ communityId: COMMUNITY, secret }))
    }
  })
  it('more than two secrets, or a community that is not a UUID', () => {
    expectLocalRefusal(() => new GurbPartnerEvents({ communityId: COMMUNITY, secret: [SECRET, SECRET, SECRET] }))
    expectLocalRefusal(() => new GurbPartnerEvents({ communityId: 'demo-riyadh-readers', secret: SECRET }))
  })
  it('the endpoint is the community\'s partner-events receiver', () => {
    expect(client().endpoint).toBe(`https://community.example.com/api/webhooks/inbound/${COMMUNITY}/host`)
  })
})

describe('builders produce the contract envelope', () => {
  it('access.changed', () => {
    const evt = client().accessChanged({ sub: `  ${SUB}  `, stateVersion: 1790000400000, access: 'blocked' })
    const body = data(evt)
    expect(evt.type).toBe('access.changed')
    expect(evt.id).toMatch(/^evt_[0-9a-f]{32}$/)
    expect(body).toMatchObject({ id: evt.id, type: 'access.changed', community: COMMUNITY })
    expect(body.data).toEqual({ sub: SUB, state_version: 1790000400000, access: 'blocked' })
    expect(Number.isNaN(Date.parse(body.created_at))).toBe(false)
  })

  it('member.updated sends only what is given (omitted = empty on Gurb)', () => {
    const evt = client().memberUpdated({ sub: SUB, stateVersion: 7, name: ' سارة   العتيبي ', email: 'sara@example.com', avatarUrl: 'https://cdn.example.com/a.png', locale: 'ar' })
    expect(data(evt).data).toEqual({ sub: SUB, state_version: 7, name: 'سارة العتيبي', email: 'sara@example.com', avatar_url: 'https://cdn.example.com/a.png', locale: 'ar' })
    expect(data(client().memberUpdated({ sub: SUB, stateVersion: 8, name: null, email: '' })).data).toEqual({ sub: SUB, state_version: 8 })
  })

  it('member.session_revoked, member.deleted, ping', () => {
    expect(data(client().sessionRevoked({ sub: SUB, stateVersion: 3 })).data).toEqual({ sub: SUB, state_version: 3, reason: 'credentials_changed' })
    const deleted = data(client().memberDeleted({ sub: SUB, stateVersion: 9, requestedAt: new Date('2026-10-07T08:00:00Z') })).data
    expect(deleted).toEqual({ sub: SUB, state_version: 9, requested_at: '2026-10-07T08:00:00.000Z' })
    expect(data(client().ping()).data).toEqual({ sub: null, state_version: 0, message: 'ping' })
  })

  it('every built event has its own id', () => {
    const c = client()
    const ids = new Set(Array.from({ length: 50 }, () => c.ping().id))
    expect(ids.size).toBe(50)
  })
})

describe('builders refuse what Gurb would refuse (fail here, not as a 400 later)', () => {
  const c = client()
  it.each([
    ['empty sub', () => c.accessChanged({ sub: '  ', stateVersion: 1, access: 'allowed' })],
    ['sub over 255', () => c.accessChanged({ sub: 'x'.repeat(256), stateVersion: 1, access: 'allowed' })],
    ['NUL in a sub', () => c.accessChanged({ sub: 'riyadah_\u0000', stateVersion: 1, access: 'allowed' })],
    ['negative version', () => c.accessChanged({ sub: SUB, stateVersion: -1, access: 'allowed' })],
    ['fractional version', () => c.accessChanged({ sub: SUB, stateVersion: 1.5, access: 'allowed' })],
    ['unknown access', () => c.accessChanged({ sub: SUB, stateVersion: 1, access: 'suspended' as never })],
    ['name over 200', () => c.memberUpdated({ sub: SUB, stateVersion: 1, name: 'x'.repeat(201) })],
    ['lone surrogate in a name', () => c.memberUpdated({ sub: SUB, stateVersion: 1, name: 'Sara \udc00' })],
    ['not an email', () => c.memberUpdated({ sub: SUB, stateVersion: 1, email: 'not-an-email' })],
    ['a Gurb placeholder address', () => c.memberUpdated({ sub: SUB, stateVersion: 1, email: 'x@c.embed.invalid' })],
    ['an http photo (Gurb fetches https only)', () => c.memberUpdated({ sub: SUB, stateVersion: 1, avatarUrl: 'http://cdn.example.com/a.png' })],
    ['a photo on another port', () => c.memberUpdated({ sub: SUB, stateVersion: 1, avatarUrl: 'https://cdn.example.com:8443/a.png' })],
  ])('%s', (_name, build) => {
    expectLocalRefusal(build)
  })
})

describe('snapshot', () => {
  const member = (i: number) => ({ sub: `riyadah_${i}`, stateVersion: 1000 + i, access: (i % 7 === 0 ? 'blocked' : 'allowed') as 'allowed' | 'blocked' })

  it('splits into pages of ≤ 500 that share one snapshot_id and generated_at', () => {
    const generatedAt = new Date(Date.now() - 60_000)
    const pages = client().snapshot({ members: Array.from({ length: 1201 }, (_, i) => member(i)), generatedAt })
    expect(pages).toHaveLength(3)
    const bodies = pages.map((p) => data(p).data as { snapshot_id: string; generated_at: string; page: number; pages: number; members: unknown[] })
    expect(new Set(bodies.map((b) => b.snapshot_id)).size).toBe(1)
    expect(bodies.every((b) => b.generated_at === generatedAt.toISOString() && b.pages === 3)).toBe(true)
    expect(bodies.map((b) => b.page)).toEqual([1, 2, 3])
    expect(bodies.map((b) => b.members.length)).toEqual([500, 500, 201])
    expect(new Set(pages.map((p) => p.id)).size).toBe(3)
  })

  it('an empty list is ONE empty page (it still completes — and blocks nobody it should not)', () => {
    const pages = client().snapshot({ members: [] })
    expect(pages).toHaveLength(1)
    expect(data(pages[0]!).data).toMatchObject({ page: 1, pages: 1, members: [] })
  })

  it('refuses a member listed twice, a bad generatedAt, a bad snapshotId or page size', () => {
    const c = client()
    expectLocalRefusal(() => c.snapshot({ members: [member(1), member(1)] }), /listed twice/)
    expectLocalRefusal(() => c.snapshot({ members: [], generatedAt: new Date(Date.now() + 10 * 60_000) }))
    expectLocalRefusal(() => c.snapshot({ members: [], generatedAt: new Date(Date.now() - 73 * 3600_000) }))
    expectLocalRefusal(() => c.snapshot({ members: [], snapshotId: 'has space' }))
    expectLocalRefusal(() => c.snapshot({ members: [], pageSize: 501 }))
  })
})

describe('send()', () => {
  it('posts the stored body with fresh Standard Webhooks headers', async () => {
    const { fn, calls } = stubFetch(200, { success: true, outcome: 'applied' })
    const c = client(fn)
    const evt = c.accessChanged({ sub: SUB, stateVersion: 1, access: 'allowed' })
    const result = await c.send(JSON.parse(JSON.stringify(evt))) // round-trips through an outbox
    expect(result).toEqual({ outcome: 'delivered', status: 200, applied: 'applied' })
    const call = calls[0]!
    const headers = call.init.headers as Record<string, string>
    expect(call.url).toBe(`https://community.example.com/api/webhooks/inbound/${COMMUNITY}/host`)
    expect(call.init.body).toBe(evt.body)
    expect(headers['webhook-id']).toBe(evt.id)
    expect(headers['webhook-signature']).toBe(signPartnerEvent([SECRET], evt.id, Number(headers['webhook-timestamp']), evt.body))
    expect(Math.abs(Number(headers['webhook-timestamp']) - Date.now() / 1000)).toBeLessThan(5)
  })

  it.each([
    [200, { success: true, outcome: 'duplicate' }, 'delivered'],
    [400, { code: 'HOST_EVENT_INVALID', message: 'data.sub is required' }, 'rejected'],
    [401, { code: 'WEBHOOK_SIGNATURE_INVALID' }, 'rejected'],
    [403, {}, 'rejected'],
    [404, { code: 'WEBHOOK_PROVIDER_UNKNOWN' }, 'rejected'],
    [408, {}, 'retry'],
    [429, {}, 'retry'],
    [500, {}, 'retry'],
    [503, { code: 'HOST_EVENT_NOT_YET_SUPPORTED' }, 'retry'],
  ])('HTTP %i → %s', async (status, body, outcome) => {
    const { fn } = stubFetch(status, body)
    const c = client(fn)
    const result = await c.send(c.ping())
    expect(result.outcome).toBe(outcome)
    expect(result.status).toBe(status)
    if ('code' in body && body.code) expect(result.code).toBe(body.code)
  })

  it('a network failure is a retry, never a throw', async () => {
    const fn = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof globalThis.fetch
    const c = client(fn)
    await expect(c.send(c.ping())).resolves.toMatchObject({ outcome: 'retry', status: 0 })
  })

  it('refuses an event built for another community, or altered after building', async () => {
    const { fn } = stubFetch(200, {})
    const mine = client(fn)
    const theirs = new GurbPartnerEvents({ communityId: '00000000-0000-4000-8000-000000000002', secret: SECRET, fetch: fn })
    await expect(mine.send(theirs.ping())).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 0 })
    const evt = mine.ping()
    await expect(mine.send({ ...evt, id: 'evt_other' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 0 })
  })
})

describe('the new refusal codes reach GurbApiError.code', () => {
  it.each([
    [{ error: 'HOST_MEMBER_BLOCKED' }, 403, 'HOST_MEMBER_BLOCKED'],
    [{ code: 'JOIN_THROUGH_HOST_ONLY', message: 'This community accepts members only through its host site' }, 403, 'JOIN_THROUGH_HOST_ONLY'],
    [{ error: 'MEMBER_NOT_ACTIVE' }, 409, 'MEMBER_NOT_ACTIVE'],
    [{ error: 'ACCOUNT_NOT_USABLE' }, 403, 'ACCOUNT_NOT_USABLE'],
    [{ error: 'Some new backend text', code: 'SOMETHING_UNKNOWN' }, 403, 'FORBIDDEN_SURFACE'],
  ])('%j (HTTP %i) → %s', (body, status, code) => {
    expect(toApiError(status, body).code).toBe(code)
  })
})
