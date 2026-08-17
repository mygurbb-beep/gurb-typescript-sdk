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

describe('creating a community takes two fields and nothing else', () => {
  const badSlugs: Array<[string, string]> = [
    ['UPPER', 'uppercase'],
    ['ab', 'too short'],
    ['a'.repeat(51), 'too long'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['double--hyphen', 'repeated hyphen'],
    ['has space', 'a space'],
    ['عربي', 'non-latin'],
  ]

  it.each(badSlugs)('rejects %s (%s) without making a request', async (slug) => {
    const { fn, calls } = stubFetch(200, {})
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, fetch: fn })

    await expect(admin.communities.create({ name: 'مجتمع', slug })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 0,
    })
    // A malformed slug should cost nothing — no round trip, and a message that
    // names the rule rather than a server-side "invalid slug".
    expect(calls).toHaveLength(0)
  })

  it('rejects an empty or over-long name without making a request', async () => {
    const { fn, calls } = stubFetch(200, {})
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, fetch: fn })

    await expect(admin.communities.create({ name: '   ', slug: 'valid-slug' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    await expect(
      admin.communities.create({ name: 'x'.repeat(101), slug: 'valid-slug' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(calls).toHaveLength(0)
  })

  it('sends exactly name and slug, and trims the name', async () => {
    const { fn, calls } = stubFetch(201, { data: { id: 'cmt_1', slug: 'crafts' } })
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, baseUrl: 'https://x.test', fetch: fn })

    await admin.communities.create({ name: '  مجتمع الحرفيين  ', slug: 'crafts' })

    expect(calls[0]!.url).toBe('https://x.test/api/admin/sdk/communities')
    // Nothing else on the wire. No description, no type, no ownerUserId — the
    // server decides those, and offering them would imply it does not.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      name: 'مجتمع الحرفيين',
      slug: 'crafts',
    })
  })

  it('accepts slugs at both ends of the length rule', async () => {
    const { fn } = stubFetch(201, { data: {} })
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, fetch: fn })

    await expect(admin.communities.create({ name: 'n', slug: 'abc' })).resolves.toBeDefined()
    await expect(admin.communities.create({ name: 'n', slug: 'a'.repeat(50) })).resolves.toBeDefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
//  Owning a community, and knowing who your key acts for
// ═════════════════════════════════════════════════════════════════════════════

describe('slug messages name the rule that was broken', () => {
  function admin(fn: typeof globalThis.fetch) {
    return createGurbAdminClient({ adminKey: ADMIN_KEY, baseUrl: 'https://x.test', fetch: fn })
  }

  /**
   * "Invalid slug" tells an integrator nothing — they are looking at a string
   * that looks fine to them. Each of these names the rule and shows the value,
   * so the fix is obvious from the log line alone.
   */
  it('offers the lowercased form, because that is the usual mistake', async () => {
    const { fn } = stubFetch(201, {})
    await expect(admin(fn).communities.create({ name: 'n', slug: 'Book-Club' })).rejects.toThrow(
      /"Book-Club" is not valid, but "book-club" would be/,
    )
  })

  it('says "no Arabic here, the Arabic name goes in name"', async () => {
    const { fn } = stubFetch(201, {})
    await expect(admin(fn).communities.create({ name: 'n', slug: 'نادي' })).rejects.toThrow(
      /The Arabic name goes in `name`/,
    )
  })

  it('distinguishes a leading hyphen from a doubled one', async () => {
    const { fn } = stubFetch(201, {})
    await expect(admin(fn).communities.create({ name: 'n', slug: '-abc' })).rejects.toThrow(
      /may not start or end with a hyphen/,
    )
    await expect(admin(fn).communities.create({ name: 'n', slug: 'a--b' })).rejects.toThrow(
      /consecutive hyphens/,
    )
  })

  /**
   * `'نادي'.length` counts UTF-16 units, so a byte- or unit-based check rejects
   * an ordinary Arabic name for being "over 100" — a bug that only shows up in
   * the language the product is actually used in.
   */
  it('counts a name in characters, not UTF-16 code units', async () => {
    const { fn, calls } = stubFetch(201, { data: {} })
    // 60 astral characters: 120 UTF-16 units, 60 code points. Must be accepted.
    await expect(
      admin(fn).communities.create({ name: '𝕏'.repeat(60), slug: 'astral-name' }),
    ).resolves.toBeDefined()
    expect(calls).toHaveLength(1)
  })
})

describe('who ends up owning the community', () => {
  function admin(fn: typeof globalThis.fetch) {
    return createGurbAdminClient({ adminKey: ADMIN_KEY, baseUrl: 'https://x.test', fetch: fn })
  }

  it('sends ownerEmail, with the names only when they are non-empty', async () => {
    const { fn, calls } = stubFetch(201, { data: { id: 'c1' } })

    await admin(fn).communities.create({
      name: 'مجتمع',
      slug: 'shop-club',
      ownerEmail: '  founder@shop.test  ',
      ownerFirstName: 'عبدالله',
      ownerFamilyName: '   ',
    })

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(body).toEqual({
      name: 'مجتمع',
      slug: 'shop-club',
      ownerEmail: 'founder@shop.test',
      ownerFirstName: 'عبدالله',
    })
    // An empty string is a value the server has to interpret, and its answer
    // would be a 400 for a field the caller simply left alone.
    expect(Object.keys(body)).not.toContain('ownerFamilyName')
  })

  /**
   * No correct guess exists: one asserts an identity through a registered
   * provider, the other names a Gurb account directly, and they can disagree
   * about which human is meant.
   */
  it('refuses owner and ownerEmail together, with no request made', async () => {
    const { fn, calls } = stubFetch(201, {})

    await expect(
      admin(fn).communities.create({
        name: 'n',
        slug: 'both-owners',
        ownerEmail: 'a@b.test',
        owner: { provider: 'okta', externalUserId: 'sub', email: 'a@b.test', emailVerified: true },
      }),
    ).rejects.toThrow(/either owner or ownerEmail, not both/)
    expect(calls).toHaveLength(0)
  })

  it('sends neither key when neither is given', async () => {
    const { fn, calls } = stubFetch(201, { data: {} })
    await admin(fn).communities.create({ name: 'n', slug: 'no-owner' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'n', slug: 'no-owner' })
  })
})

describe('me()', () => {
  it('asks admin/sdk/me and returns the identity unwrapped', async () => {
    const identity = {
      subject: {
        userId: 'u1',
        email: 'founder@shop.test',
        displayName: 'عبدالله',
        phone: '00000000000',
        phoneIsPlaceholder: true,
      },
      issuedBy: {
        userId: 'u0',
        email: 'admin@mygurb.com',
        displayName: 'Platform',
        phone: '0500000000',
        phoneIsPlaceholder: false,
      },
      actsForIssuer: false,
      key: { id: 'k1', name: 'shop-prod', scopes: ['read', 'write'] },
    }
    const { fn, calls } = stubFetch(200, { success: true, data: identity })
    const admin = createGurbAdminClient({ adminKey: ADMIN_KEY, baseUrl: 'https://x.test', fetch: fn })

    await expect(admin.me()).resolves.toEqual(identity)
    expect(calls[0]!.url).toBe('https://x.test/api/admin/sdk/me')
    expect(calls[0]!.init.method).toBe('GET')
  })
})
