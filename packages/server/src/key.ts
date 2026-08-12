import { GurbApiError } from './errors.js'

/**
 * A Gurb API key is `gurb_<keyId>_<secret>`.
 *
 * The `gurb_` prefix exists so a key is distinguishable from a session JWT
 * (which starts `eyJ`) by shape alone — the backend routes on that, and so do
 * secret scanners. Validating here rather than on first request means an
 * integrator who pasted the wrong string learns at construction time instead of
 * debugging a 401 against a route that was never the problem.
 */
const KEY_PATTERN = /^gurb_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/

export function assertValidApiKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new GurbApiError({
      message: 'A Gurb API key is required. Pass { apiKey } to createGurbClient().',
      code: 'INVALID_API_KEY',
      status: 0,
    })
  }

  if (!KEY_PATTERN.test(key)) {
    const looksLikeJwt = key.startsWith('eyJ')
    throw new GurbApiError({
      message: looksLikeJwt
        ? 'That is a session JWT, not an API key. API keys look like gurb_<id>_<secret> and are minted from the community dashboard.'
        : 'Malformed Gurb API key. Expected the format gurb_<id>_<secret>.',
      code: 'INVALID_API_KEY',
      status: 0,
    })
  }
}

/**
 * Refuse to run in a browser.
 *
 * The package boundary and the `exports` map already make this hard to do by
 * accident; this is the layer that turns a mistake into a loud failure during
 * development rather than a secret shipped in a JS bundle. `@gurb/embed` is the
 * browser-side package and it cannot express an API key at all.
 */
export function assertServerEnvironment(): void {
  if (typeof window !== 'undefined' || typeof document !== 'undefined') {
    throw new GurbApiError({
      message:
        '@gurb/server must never run in a browser — it holds your secret API key. Use @gurb/embed on the client and mint embed sessions from your own backend.',
      code: 'INVALID_API_KEY',
      status: 0,
    })
  }
}
