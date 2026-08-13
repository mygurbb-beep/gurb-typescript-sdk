import { describe, expect, it, vi } from 'vitest'
import { createGurbAdminClient } from './admin-client.js'
import { createGurbClient } from './client.js'
import { GurbApiError } from './errors.js'

const COMMUNITY_KEY = 'gurb_a1b2c3d4e5f6_' + 'x'.repeat(43)
const ADMIN_KEY = 'gurb_sa_a1b2c3d4e5f6_' + 'x'.repeat(43)

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

/**
 * The two credentials must never be interchangeable. These are the tests that
 * would fail first if someone "simplified" the key check into one pattern.
 */
describe('credential separation', () => {
  it('refuses a super-admin key in the community client, and says why', () => {
    expect(() => createGurbClient({ apiKey: ADMIN_KEY })).toThrow(/super-admin key, not a community API key/)
  })

  it('refuses a community key in the admin client, and says why', () => {
    expect(() => createGurbAdminClient({ adminKey: COMMUNITY_KEY })).toThrow(
      /community API key, not a super-admin key/,
    )
  })

  it('accepts each key in its own client', () => {
    const fetch = stubFetch(200, {}).fn
    expect(() => createGurbClient({ apiKey: COMMUNITY_KEY, fetch })).not.toThrow()
    expect(() => createGurbAdminClient({ adminKey: ADMIN_KEY, fetch })).not.toThrow()
  })

  it('rejects a JWT in the admin client with an admin-specific message', () => {
    expect(() => createGurbAdminClient({ adminKey: 'eyJhbGciOiJIUzI1NiJ9.a.b' })).toThrow(
      /gurb_sa_<id>_<secret>/,
    )
  })

  it('refuses to construct the admin client in a browser', () => {
    vi.stubGlobal('window', {})
    expect(() => createGurbAdminClient({ adminKey: ADMIN_KEY })).toThrow(/never run in a browser/)
    vi.unstubAllGlobals()
  })
})

describe('admin routes', () => {
  it('creates a community under the admin path', async () => {
    const { fn, calls } = stubFetch(201, { data: { id: 'cmt_1', slug: 'new' } })
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, baseUrl: 'https://x.test', fetch: fn })

    await admin.communities.create({ name: 'جديد', slug: 'new' })

    expect(calls[0]!.url).toBe('https://x.test/api/admin/sdk/communities')
    expect((calls[0]!.init.headers as Record<string, string>)['X-Api-Key']).toBe(ADMIN_KEY)
  })

  it('defaults a minted key to read-only scope', async () => {
    const { fn, calls } = stubFetch(201, { data: { id: 'k1', key: 'gurb_x_y' } })
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, fetch: fn })

    await admin.apiKeys.create({ communityId: 'cmt_1', name: 'zapier' })

    // Most integrations only read. A read-only key that leaks is a closable incident.
    expect(JSON.parse(calls[0]!.init.body as string).scopes).toEqual(['read'])
  })

  it('refuses to reject a request without a reason, before making a request', async () => {
    const { fn, calls } = stubFetch(200, {})
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, fetch: fn })

    await expect(admin.communityRequests.reject('creq_1', '   ')).rejects.toBeInstanceOf(GurbApiError)
    expect(calls).toHaveLength(0)
  })
})
