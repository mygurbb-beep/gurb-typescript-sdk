import { describe, expect, it, vi, afterEach } from 'vitest'
import { createGurbClient } from './client.js'
import { GurbApiError } from './errors.js'

const KEY = 'gurb_a1b2c3d4e5f6_' + 'x'.repeat(43)

/** A fetch stub that records the call and replays a canned response. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('key validation', () => {
  it('rejects a malformed key at construction, not on first request', () => {
    expect(() => createGurbClient({ apiKey: 'not-a-key' })).toThrow(GurbApiError)
  })

  it('tells a developer who pasted a session JWT what they actually did', () => {
    expect(() => createGurbClient({ apiKey: 'eyJhbGciOiJIUzI1NiJ9.abc.def' })).toThrow(
      /session JWT, not an API key/,
    )
  })

  it('accepts a well-formed key', () => {
    expect(() => createGurbClient({ apiKey: KEY, fetch: stubFetch(200, {}).fn })).not.toThrow()
  })
})

describe('browser guard', () => {
  it('refuses to construct when a window exists', () => {
    vi.stubGlobal('window', {})
    expect(() => createGurbClient({ apiKey: KEY })).toThrow(/never run in a browser/)
  })
})

describe('requests', () => {
  it('sends the key as a header and never in the query string', async () => {
    const { fn, calls } = stubFetch(200, { success: true, data: { id: 'c1' } })
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test', fetch: fn })

    await client.community.get()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/community')
    expect(calls[0]!.url).not.toContain(KEY)
    expect((calls[0]!.init.headers as Record<string, string>)['X-Api-Key']).toBe(KEY)
  })

  it('unwraps the { success, data } envelope', async () => {
    const { fn } = stubFetch(200, { success: true, data: { id: 'c1', slug: 'demo' } })
    const client = createGurbClient({ apiKey: KEY, fetch: fn })
    await expect(client.community.get()).resolves.toEqual({ id: 'c1', slug: 'demo' })
  })

  it('drops undefined query params instead of sending "undefined"', async () => {
    const { fn, calls } = stubFetch(200, { data: { items: [] } })
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test', fetch: fn })

    await client.events.list({ limit: 10 })

    expect(calls[0]!.url).toBe('https://x.test/api/sdk/events?limit=10')
  })

  it('maps a recognised backend error code through unchanged', async () => {
    const { fn } = stubFetch(403, { success: false, error: 'FEATURE_NOT_AVAILABLE', message: 'Blogs are not on your plan' })
    const client = createGurbClient({ apiKey: KEY, fetch: fn })

    await expect(client.blogs.list()).rejects.toMatchObject({
      code: 'FEATURE_NOT_AVAILABLE',
      status: 403,
      message: 'Blogs are not on your plan',
    })
  })

  it('does not pass an unrecognised backend string through as a code', async () => {
    const { fn } = stubFetch(403, { success: false, error: 'SOMETHING_NEW_WE_ADDED' })
    const client = createGurbClient({ apiKey: KEY, fetch: fn })

    // Consumers switch on `code`; coupling it to unversioned backend copy would
    // break them silently. The original text survives in `message`.
    await expect(client.blogs.list()).rejects.toMatchObject({
      code: 'FORBIDDEN_SURFACE',
      message: 'SOMETHING_NEW_WE_ADDED',
    })
  })

  it('reports a transport failure as NETWORK_ERROR, not an unhandled rejection', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof globalThis.fetch
    const client = createGurbClient({ apiKey: KEY, fetch: fn })

    await expect(client.tweets.list()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
  })
})

describe('embed sessions', () => {
  it('posts the identity payload and carries no role field', async () => {
    const { fn, calls } = stubFetch(200, {
      data: { token: 'et_abc', expiresAt: '2026-08-11T00:02:00Z', userId: 'u1' },
    })
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test', fetch: fn })

    const session = await client.embed.createSession({
      externalUserId: 'shop-user-42',
      displayName: 'Sara',
    })

    expect(calls[0]!.url).toBe('https://x.test/api/embed/sessions')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      externalUserId: 'shop-user-42',
      displayName: 'Sara',
    })
    expect(session.token).toBe('et_abc')
  })

  it('puts the token in the fragment, never the query string', () => {
    const client = createGurbClient({
      apiKey: KEY,
      baseUrl: 'https://x.test',
      fetch: stubFetch(200, {}).fn,
    })

    const url = client.embed.buildUrl({ slug: 'demo', section: 'tweets', token: 'et_abc' })

    expect(url).toBe('https://x.test/embed/demo/tweets#t=et_abc')
    expect(new URL(url).search).toBe('')
  })
})

// ─── Members, permissions and bulk ───────────────────────────────────────────

describe('permissions', () => {
  it('refuses to grant and revoke the same permission in one call', async () => {
    const { fn, calls } = stubFetch(200, {})
    const client = createGurbClient({ apiKey: KEY, fetch: fn })

    await expect(
      client.members.updatePermissions('mem_1', { grant: ['CREATE_POST'], revoke: ['CREATE_POST'] }),
    ).rejects.toThrow(/grant and revoke the same permission/)
    // The point is that it never reached the network — there is no correct
    // guess at what was meant, so asking the server is not a fix.
    expect(calls).toHaveLength(0)
  })

  it('refuses an empty change set', async () => {
    const client = createGurbClient({ apiKey: KEY, fetch: stubFetch(200, {}).fn })
    await expect(client.members.updatePermissions('mem_1', {})).rejects.toThrow(/at least one permission/)
  })

  it('sends both lists in one request so the member is never half-updated', async () => {
    const { fn, calls } = stubFetch(200, { data: {} })
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test', fetch: fn })

    await client.members.updatePermissions('mem_1', { grant: ['CREATE_EVENT'], revoke: ['CREATE_POST'] })

    expect(calls[0]!.init.method).toBe('PATCH')
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/members/mem_1/permissions')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      grant: ['CREATE_EVENT'],
      revoke: ['CREATE_POST'],
    })
  })
})

describe('bulk members', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ externalUserId: `u${i}`, displayName: `User ${i}` }))

  it('rejects an empty list', async () => {
    const client = createGurbClient({ apiKey: KEY, fetch: stubFetch(200, {}).fn })
    await expect(client.members.bulkUpsert([])).rejects.toThrow(/at least one member/)
  })

  it('rejects a list over the limit without sending it', async () => {
    const { fn, calls } = stubFetch(200, {})
    const client = createGurbClient({ apiKey: KEY, fetch: fn })

    await expect(client.members.bulkUpsert(rows(501))).rejects.toThrow(/at most 500/)
    // Sending it would likely die at a proxy timeout with no way to know which
    // half landed — worse than a clean local failure.
    expect(calls).toHaveLength(0)
  })

  it('accepts exactly the limit', async () => {
    const { fn } = stubFetch(200, { data: { created: [], updated: [], failed: [], total: 500 } })
    const client = createGurbClient({ apiKey: KEY, fetch: fn })
    await expect(client.members.bulkUpsert(rows(500))).resolves.toMatchObject({ total: 500 })
  })

  it('names a duplicate id rather than letting the batch race itself', async () => {
    const client = createGurbClient({ apiKey: KEY, fetch: stubFetch(200, {}).fn })

    await expect(
      client.members.bulkUpsert([
        { externalUserId: 'dup', displayName: 'A' },
        { externalUserId: 'dup', displayName: 'B' },
      ]),
    ).rejects.toThrow(/Duplicate externalUserId in the same batch: dup/)
  })
})
