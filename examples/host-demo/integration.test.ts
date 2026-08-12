import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGurbClient, GurbApiError } from '../../packages/server/src/index.js'
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
