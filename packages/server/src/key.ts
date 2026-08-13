import { GurbApiError } from './errors.js'

/**
 * Two credential shapes, deliberately not interchangeable.
 *
 *   gurb_<12 hex>_<secret>        a community key   — one community, forever
 *   gurb_sa_<12 hex>_<secret>     a super-admin key — the whole platform
 *
 * The shapes are mutually exclusive by construction: `sa` is not twelve hex
 * characters, so an admin key can never satisfy the community pattern. That
 * matters more than it looks. The blast radius of the two is not comparable —
 * a leaked community key creates junk in one community, a leaked admin key can
 * create communities and mint further keys — so the wrong one must fail loudly
 * at construction rather than quietly at the first 403.
 *
 * The `gurb_` prefix also distinguishes both from a session JWT (which starts
 * `eyJ`), which is what the platform routes on and what secret scanners match.
 */
const COMMUNITY_KEY_PATTERN = /^gurb_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/
const ADMIN_KEY_PATTERN = /^gurb_sa_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/

function reject(message: string): never {
  throw new GurbApiError({ message, code: 'INVALID_API_KEY', status: 0 })
}

function assertPresent(key: unknown, what: string): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    reject(`A Gurb ${what} is required.`)
  }
}

/** Validates a community-scoped key: the credential `GurbClient` accepts. */
export function assertValidApiKey(key: unknown): asserts key is string {
  assertPresent(key, 'API key')

  if (COMMUNITY_KEY_PATTERN.test(key)) return

  if (ADMIN_KEY_PATTERN.test(key)) {
    reject(
      'That is a super-admin key, not a community API key. Use GurbAdminClient for platform operations — passing an admin key here would give ordinary application code far more authority than it needs.',
    )
  }
  reject(
    key.startsWith('eyJ')
      ? 'That is a session JWT, not an API key. API keys look like gurb_<id>_<secret> and are minted from the community dashboard.'
      : 'Malformed Gurb API key. Expected the format gurb_<id>_<secret>.',
  )
}

/** Validates a platform super-admin key: the credential `GurbAdminClient` accepts. */
export function assertValidAdminKey(key: unknown): asserts key is string {
  assertPresent(key, 'super-admin key')

  if (ADMIN_KEY_PATTERN.test(key)) return

  if (COMMUNITY_KEY_PATTERN.test(key)) {
    reject(
      'That is a community API key, not a super-admin key. Community keys cannot create communities or mint other keys; use GurbClient with it instead.',
    )
  }
  reject(
    key.startsWith('eyJ')
      ? 'That is a session JWT, not a super-admin key. Admin keys look like gurb_sa_<id>_<secret>.'
      : 'Malformed Gurb super-admin key. Expected the format gurb_sa_<id>_<secret>.',
  )
}

/**
 * Refuse to run in a browser.
 *
 * The package boundary and the `exports` map already make this hard to do by
 * accident; this is the layer that turns a mistake into a loud failure during
 * development rather than a secret shipped in a JS bundle. `@gurb/embed` is the
 * browser-side package and it cannot express a key at all.
 */
export function assertServerEnvironment(what = '@gurb/server'): void {
  if (typeof window !== 'undefined' || typeof document !== 'undefined') {
    throw new GurbApiError({
      message: `${what} must never run in a browser — it holds a secret key. Use @gurb/embed on the client and mint embed sessions from your own backend.`,
      code: 'INVALID_API_KEY',
      status: 0,
    })
  }
}
