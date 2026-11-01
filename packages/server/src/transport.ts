import { GurbApiError, toApiError } from './errors.js'

export interface TransportOptions {
  baseUrl: string
  /** The credential header value. Never placed in a URL. */
  apiKey: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export type QueryValue = string | number | boolean | undefined

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * The one place that knows a key exists.
 *
 * Both clients share it so there is a single answer to "how does a request get
 * authenticated, how are errors shaped, how is a timeout reported" — three
 * things that must not drift between the community and admin surfaces, because
 * a difference there is a security difference, not a style difference.
 */
export class Transport {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number

  constructor(options: TransportOptions) {
    this.#apiKey = options.apiKey
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    if (typeof this.#fetch !== 'function') {
      throw new GurbApiError({
        message: 'No fetch implementation available. Node 20+ is required, or pass { fetch }.',
        code: 'NETWORK_ERROR',
        status: 0,
      })
    }
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  /**
   * PUT is here for exactly one endpoint — the sidebar — and it is not a
   * normalisation opportunity. That write genuinely REPLACES the whole menu
   * array upstream, and spelling it PATCH here would advertise a per-item merge
   * that does not exist. The verb is part of the contract.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    opts: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<T> {
    // Every id is a whole path segment, and encodeURIComponent keeps «.»: an id of ".." is
    // collapsed by URL into a DIFFERENT route, sent with this key (sdk/events/../registrations/…),
    // and an empty one turns members.get('') into the members LIST (sdk/members/). Refused here,
    // once for every method, before anything is sent — the same guard as the PHP Requester.
    if (path.replace(/^\/+/, '').split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new GurbApiError({
        message: `An id in the request path is empty, "." or "..": ${path}`,
        code: 'VALIDATION_ERROR',
        status: 0,
      })
    }

    const url = new URL(`${this.#baseUrl}/api/${path.replace(/^\/+/, '')}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)

    let response: Response
    try {
      response = await this.#fetch(url.toString(), {
        method,
        headers: {
          // The key never goes in a query string: those land in access logs.
          'X-Api-Key': this.#apiKey,
          Accept: 'application/json',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        signal: controller.signal,
      })
    } catch (cause) {
      throw new GurbApiError({
        message:
          cause instanceof Error && cause.name === 'AbortError'
            ? `Request to ${path} timed out after ${this.#timeoutMs}ms`
            : `Network request to ${path} failed`,
        code: 'NETWORK_ERROR',
        status: 0,
      })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      // An HTML error page from a proxy is the usual cause. Surfacing it as a
      // parse error rather than the raw body keeps secrets out of logs.
      throw new GurbApiError({
        message: `Gurb API returned a non-JSON response (status ${response.status})`,
        code: response.ok ? 'UNKNOWN' : 'NETWORK_ERROR',
        status: response.status,
      })
    }

    if (!response.ok) throw toApiError(response.status, parsed)

    // Responses are `{ success, data }` or bare. Unwrap when wrapped.
    const envelope = parsed as { data?: unknown }
    return (envelope.data !== undefined ? envelope.data : parsed) as T
  }
}
