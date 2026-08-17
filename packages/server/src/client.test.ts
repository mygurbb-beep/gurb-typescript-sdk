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

  /**
   * THESE ASSERTIONS ARE THE CONTRACT with `app/embed/page.tsx` in the Gurb web
   * app, and with @gurb/embed's own boundary tests. Changing one requires
   * changing the others in the same commit.
   *
   * They replaced an assertion that pinned `/embed/{slug}/{section}#t=`, which
   * was green and wrong: the page lives at `/embed` and reads `token`, so the
   * SDK was naming a route that does not exist and a fragment key nothing
   * reads. Both sides had passing suites; neither crossed the boundary.
   */
  function urlFor(section: 'community' | 'tweets'): string {
    const client = createGurbClient({
      apiKey: KEY,
      baseUrl: 'https://x.test',
      fetch: stubFetch(200, {}).fn,
    })
    return client.embed.buildUrl({ section, token: 'et_abc' })
  }

  it('points at /embed — one path, no slug and no section segment', () => {
    expect(urlFor('community').split('#')[0]).toBe('https://x.test/embed')
  })

  it('names the token `token`, which is the key the page reads', () => {
    expect(new URLSearchParams(urlFor('community').split('#')[1]).get('token')).toBe('et_abc')
  })

  it('omits `section` for the whole community, because absence means home', () => {
    expect(new URLSearchParams(urlFor('community').split('#')[1]).has('section')).toBe(false)
  })

  it('carries `section` for a single pane', () => {
    expect(new URLSearchParams(urlFor('tweets').split('#')[1]).get('section')).toBe('tweets')
  })

  it('puts the token in the fragment, never the query string', () => {
    // A query string reaches the server: nginx access logs, Referer headers.
    const url = urlFor('tweets')
    expect(new URL(url).search).toBe('')
    expect(url.split('#')[1]).toContain('token=')
  })

  describe('embed.iframe', () => {
    it('emits a frame pointing at the same URL buildUrl produces', () => {
      const html = urlFor('community')
      const client = createGurbClient({
        apiKey: KEY,
        baseUrl: 'https://x.test',
        fetch: stubFetch(200, {}).fn,
      })
      expect(client.embed.iframe({ section: 'community', token: 'et_abc' })).toContain(
        `src="${html.replace(/&/g, '&amp;')}"`,
      )
    })

    it('sizes a whole community taller than a single pane', () => {
      const client = createGurbClient({
        apiKey: KEY,
        baseUrl: 'https://x.test',
        fetch: stubFetch(200, {}).fn,
      })
      expect(client.embed.iframe({ section: 'community', token: 'et_abc' })).toContain('height:900px')
      expect(client.embed.iframe({ section: 'tweets', token: 'et_abc' })).toContain('height:600px')
    })

    it('never grants allow-top-navigation — the frame must not move the host page', () => {
      const client = createGurbClient({
        apiKey: KEY,
        baseUrl: 'https://x.test',
        fetch: stubFetch(200, {}).fn,
      })
      const html = client.embed.iframe({ section: 'tweets', token: 'et_abc' })
      expect(html).toContain('allow-same-origin')
      expect(html).not.toContain('allow-top-navigation')
    })
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

describe('publishing content', () => {
  /**
   * The verb and path per section, asserted as a table.
   *
   * These are a PUBLISHED CONTRACT: once an integration calls them, changing a
   * path or a method breaks somebody's production silently, at a time we do not
   * choose. Asserting them here means such a change fails in CI instead.
   *
   * PATCH, not PUT, on every update — every one of them is partial in fact, and
   * PATCH matches the members surface that shipped first.
   */
  it.each([
    ['tweets', 'POST',   'sdk/tweets'],
    ['events', 'POST',   'sdk/events'],
    ['blogs',  'POST',   'sdk/blogs'],
    ['albums', 'POST',   'sdk/albums'],
  ])('%s create → %s %s', async (section, method, path) => {
    const { fn, calls } = stubFetch(200, { success: true, data: { id: 'x' } })
    vi.stubGlobal('fetch', fn)
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test' })

    const bodies: Record<string, unknown> = {
      tweets: { content: 'مرحباً' },
      events: { title: 'T', titleArabic: 'ت', startDate: '2026-09-01T10:00:00Z', endDate: '2026-09-01T12:00:00Z' },
      blogs:  { title: 'T', contentHtml: '<p>x</p>' },
      albums: { title: 'T' },
    }
    // @ts-expect-error indexed access across four differently-typed resources
    await client[section].create(bodies[section])

    expect(calls[0]!.init.method).toBe(method)
    expect(calls[0]!.url).toBe(`https://x.test/api/${path}`)
  })

  it.each([
    ['tweets', 'sdk/tweets'],
    ['events', 'sdk/events'],
    ['blogs',  'sdk/blogs'],
    ['albums', 'sdk/albums'],
  ])('%s update is a PATCH and delete is a DELETE', async (section, path) => {
    const { fn, calls } = stubFetch(200, { success: true, data: { id: 'x' } })
    vi.stubGlobal('fetch', fn)
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test' })

    // @ts-expect-error indexed access across four differently-typed resources
    await client[section].update('abc', {})
    // @ts-expect-error indexed access across four differently-typed resources
    await client[section].delete('abc')

    expect(calls[0]!.init.method).toBe('PATCH')
    expect(calls[0]!.url).toBe(`https://x.test/api/${path}/abc`)
    expect(calls[1]!.init.method).toBe('DELETE')
    expect(calls[1]!.url).toBe(`https://x.test/api/${path}/abc`)
  })

  it('percent-encodes the id, so a slash in it cannot reach another route', async () => {
    // An id is caller-supplied. Without encoding, "a/b" would turn
    // DELETE sdk/tweets/a/b into a path this SDK never meant to call.
    const { fn, calls } = stubFetch(200, { success: true, data: {} })
    vi.stubGlobal('fetch', fn)
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test' })

    await client.tweets.delete('a/b')
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/tweets/a%2Fb')
  })

  it('refuses an empty post locally, spending no rate-limit budget', async () => {
    const { fn, calls } = stubFetch(200, { success: true, data: {} })
    vi.stubGlobal('fetch', fn)
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test' })

    await expect(client.tweets.create({ content: '   ' })).rejects.toBeInstanceOf(GurbApiError)
    expect(calls).toHaveLength(0)
  })

  it('trims the content it sends rather than the content it validated', async () => {
    // Validating a trimmed value and then sending the untrimmed one is a real
    // and easy bug: the local check passes, the server sees leading whitespace.
    const { fn, calls } = stubFetch(200, { success: true, data: {} })
    vi.stubGlobal('fetch', fn)
    const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test' })

    await client.tweets.create({ content: '  hello  ' })
    expect(JSON.parse(String(calls[0]!.init.body)).content).toBe('hello')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  The sections mirrored from the PHP SDK
// ═════════════════════════════════════════════════════════════════════════════

/** A client whose every call is recorded and answered with `{}`. */
function spyClient(body: unknown = { success: true, data: {} }) {
  const { fn, calls } = stubFetch(200, body)
  const client = createGurbClient({ apiKey: KEY, baseUrl: 'https://x.test', fetch: fn })
  return { client, calls }
}

function sent(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

describe('community customization', () => {
  it('reads and patches settings on the right routes', async () => {
    const { client, calls } = spyClient()

    await client.community.getSettings()
    await client.community.updateSettings({ pageVisibility: { news: false } })

    expect(calls[0]!.url).toBe('https://x.test/api/sdk/community/settings')
    expect(calls[1]!.init.method).toBe('PATCH')
    expect(sent(calls[1]!)).toEqual({ pageVisibility: { news: false } })
  })

  it('refuses an empty settings patch before any request leaves', async () => {
    const { client, calls } = spyClient()
    await expect(client.community.updateSettings({})).rejects.toThrow(/at least one key/)
    expect(calls).toHaveLength(0)
  })

  it('refuses an empty branding patch', async () => {
    const { client, calls } = spyClient()
    await expect(client.community.updateBranding({})).rejects.toThrow(/at least one field/)
    expect(calls).toHaveLength(0)
  })

  /**
   * THE POINT OF THIS TEST. `''` restores the platform's standard template and
   * an ABSENT key leaves the stored text alone. Conflating them produces one of
   * two real bugs: a deliberate reset ignored, or someone's hand-written terms
   * wiped by a call that meant to touch neither.
   */
  it('sends an empty string but omits an absent field', async () => {
    const { client, calls } = spyClient()

    await client.community.updateLegal({ terms: '' })

    expect(sent(calls[0]!)).toEqual({ terms: '' })
    expect(Object.keys(sent(calls[0]!))).not.toContain('privacyPolicy')
  })

  it('refuses `language` on its own — it changes nothing observable', async () => {
    const { client, calls } = spyClient()
    await expect(client.community.updateLegal({ language: 'ar' })).rejects.toThrow(/terms and\/or/)
    expect(calls).toHaveLength(0)
  })
})

describe('groups, consultants, projects and awards', () => {
  it('sends the TRIMMED values, not merely validates them', async () => {
    const { client, calls } = spyClient()

    await client.groups.create({
      name: '  نادي  ',
      description: '  وصف  ',
      isPrivate: false,
      iconUrl: '  https://cdn.test/i.png  ',
    })

    expect(sent(calls[0]!)).toMatchObject({
      name: 'نادي',
      description: 'وصف',
      iconUrl: 'https://cdn.test/i.png',
      isPrivate: false,
    })
  })

  it('refuses a group with a whitespace-only icon URL, with no request made', async () => {
    const { client, calls } = spyClient()
    await expect(
      client.groups.create({ name: 'n', description: 'd', isPrivate: true, iconUrl: '   ' }),
    ).rejects.toThrow(/http\(s\) iconUrl/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a consultant with no bookingUrl — the column is NOT NULL', async () => {
    const { client, calls } = spyClient()
    await expect(
      client.consultants.create({ displayName: 'X', bookingUrl: '' }),
    ).rejects.toThrow(/displayName and a bookingUrl/)
    expect(calls).toHaveLength(0)
  })

  /**
   * projects2 is a PARALLEL MODULE, not a newer projects. A client that routed
   * both to one endpoint would return an empty list for half the platform's
   * communities — which reads as "no projects" rather than "wrong module".
   */
  it('keeps projects and projects2 on genuinely separate routes', async () => {
    const { client, calls } = spyClient()

    await client.projects.create({ name: 'A', description: 'd' })
    await client.projects2.create({ name: 'A', description: 'd' })

    expect(calls[0]!.url).toBe('https://x.test/api/sdk/projects')
    expect(calls[1]!.url).toBe('https://x.test/api/sdk/projects2')
  })

  it('requires an icon preset key and a colour on an award', async () => {
    const { client, calls } = spyClient()
    await expect(client.awards.create({ name: 'وسام', icon: 'trophy', color: '' })).rejects.toThrow(
      /icon preset key and a hex color/,
    )
    expect(calls).toHaveLength(0)
  })

  it('encodes an id so a slash cannot walk the request onto another route', async () => {
    const { client, calls } = spyClient()
    // Unencoded, this would become /api/sdk/awards/a/b — and an unmatched
    // /api/* on this backend answers 400 "Tenant context required", not 404.
    await client.awards.delete('a/b')
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/awards/a%2Fb')
  })
})

describe('tasks', () => {
  it('comma-joins a multi-valued filter and drops the empty ones', async () => {
    const { client, calls } = spyClient({ data: { items: [] } })

    await client.tasks.list({ status: ['PENDING', 'OVERDUE'], priority: [], search: 'q' })

    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('status')).toBe('PENDING,OVERDUE')
    // An empty `?priority=` is a filter matching nothing, which returns MORE
    // rows than asked for — the failure you do not notice.
    expect(url.searchParams.has('priority')).toBe(false)
    expect(url.searchParams.get('search')).toBe('q')
  })

  it('accepts a single value where a list is allowed', async () => {
    const { client, calls } = spyClient({ data: { items: [] } })
    await client.tasks.list({ status: 'COMPLETED' })
    expect(new URL(calls[0]!.url).searchParams.get('status')).toBe('COMPLETED')
  })

  it('refuses a task with no headingId — there is no inbox to fall back on', async () => {
    const { client, calls } = spyClient()
    await expect(client.tasks.create({ headingId: '  ', title: 'T' })).rejects.toThrow(
      /headingId and a title/,
    )
    expect(calls).toHaveLength(0)
  })
})

describe('comments and likes', () => {
  it('always puts the parent in the path — the comment table has no community column', async () => {
    const { client, calls } = spyClient()

    await client.comments.update('blogs', 'b1', 'c1', { content: 'edited' })

    expect(calls[0]!.url).toBe('https://x.test/api/sdk/blogs/b1/comments/c1')
    expect(calls[0]!.init.method).toBe('PATCH')
  })

  it('omits parentCommentId entirely for a top-level comment', async () => {
    const { client, calls } = spyClient()
    await client.comments.create('tweets', 't1', { content: 'hi' })
    expect(sent(calls[0]!)).toEqual({ content: 'hi' })
  })

  /**
   * A blank parentCommentId almost always means a variable that failed to
   * resolve. Silently turning someone's reply into a new top-level thread is
   * worse than an error.
   */
  it('refuses a blank parentCommentId rather than posting at top level', async () => {
    const { client, calls } = spyClient()
    await expect(
      client.comments.create('tweets', 't1', { content: 'hi', parentCommentId: '   ' }),
    ).rejects.toThrow(/omit it entirely/)
    expect(calls).toHaveLength(0)
  })

  it('addresses a comment like by parent AND comment id', async () => {
    const { client, calls } = spyClient()
    await client.comments.like('albums', 'a1', 'c9')
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/albums/a1/comments/c9/like')
    expect(calls[0]!.init.method).toBe('POST')
  })

  it('uses one path for state, like and unlike — only the verb differs', async () => {
    const { client, calls } = spyClient()

    await client.likes.state('tweets', 't1')
    await client.likes.like('tweets', 't1')
    await client.likes.unlike('tweets', 't1')

    expect(calls.map((c) => c.url)).toEqual([
      'https://x.test/api/sdk/tweets/t1/like',
      'https://x.test/api/sdk/tweets/t1/like',
      'https://x.test/api/sdk/tweets/t1/like',
    ])
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'POST', 'DELETE'])
  })
})

describe('sidebar and advertisements', () => {
  /**
   * PUT, NOT PATCH, and the verb is the contract: this write REPLACES the whole
   * menu array. Spelling it PATCH would advertise a per-item merge that does
   * not exist upstream.
   */
  it('replaces the menu with a PUT', async () => {
    const { client, calls } = spyClient()
    await client.sidebar.update({ items: [{ id: 'home' }] })
    expect(calls[0]!.init.method).toBe('PUT')
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/customization/sidebar')
  })

  it('keeps the stored menu when only `enabled` is sent', async () => {
    const { client, calls } = spyClient()
    await client.sidebar.update({ enabled: false })
    expect(sent(calls[0]!)).toEqual({ enabled: false })
  })

  it('refuses a sidebar update with neither field', async () => {
    const { client, calls } = spyClient()
    await expect(client.sidebar.update({})).rejects.toThrow(/items and\/or enabled/)
    expect(calls).toHaveLength(0)
  })

  it('resets with a DELETE on the same path', async () => {
    const { client, calls } = spyClient()
    await client.sidebar.reset()
    expect(calls[0]!.init.method).toBe('DELETE')
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/customization/sidebar')
  })

  it('returns the icon vocabulary as a bare list, dropping non-strings', async () => {
    const { client } = spyClient({ data: { icons: ['home', 7, 'users', null] } })
    await expect(client.sidebar.icons()).resolves.toEqual(['home', 'users'])
  })

  it('answers [] rather than throwing when the icon payload has no list', async () => {
    const { client } = spyClient({ data: {} })
    await expect(client.sidebar.icons()).resolves.toEqual([])
  })

  it('unwraps the member-facing ad feed, which is not paginated', async () => {
    const { client, calls } = spyClient({ data: { items: [{ id: 'ad1' }] } })

    await expect(client.advertisements.listActive({ position: 'RIGHT_SIDEBAR' })).resolves.toEqual([
      { id: 'ad1' },
    ])
    expect(new URL(calls[0]!.url).searchParams.get('position')).toBe('RIGHT_SIDEBAR')
  })

  it('drops the position filter entirely when it is not given', async () => {
    const { client, calls } = spyClient({ data: { items: [] } })
    await client.advertisements.listActive()
    expect(calls[0]!.url).toBe('https://x.test/api/sdk/customization/advertisements/active')
  })
})
