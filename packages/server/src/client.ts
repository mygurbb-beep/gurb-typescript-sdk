import type {
  Album,
  Blog,
  Community,
  CreateEmbedSessionInput,
  EmbedSection,
  EmbedSession,
  Event,
  Member,
  Paginated,
  PaginationParams,
  Tweet,
} from '@gurb/api-types'
import { GurbApiError, toApiError } from './errors.js'
import { assertServerEnvironment, assertValidApiKey } from './key.js'

export interface GurbClientOptions {
  apiKey: string
  /**
   * Origin only — no `/api` suffix. The client appends `api/` itself, matching
   * how the web app's own `apiUrl()` helper behaves. Passing `/api/v1` here
   * produces requests to routes that do not exist, and because unmatched
   * `/api/*` paths fall through to root-mounted routers they answer 400/401
   * rather than 404 — which sends you to debug auth instead of the URL.
   */
  baseUrl?: string
  /** Injected for tests. Defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://mygurb.com'
const DEFAULT_TIMEOUT_MS = 15_000

export class GurbClient {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number

  constructor(options: GurbClientOptions) {
    assertServerEnvironment()
    assertValidApiKey(options.apiKey)

    this.#apiKey = options.apiKey
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
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

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}/api/${path.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
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

  // ─── Community ─────────────────────────────────────────────────────────────

  /** The community this key is pinned to. A key can never read another one. */
  community = {
    get: (): Promise<Community> => this.#request('GET', 'sdk/community'),
  }

  // ─── Content ───────────────────────────────────────────────────────────────

  tweets = {
    list: (params: PaginationParams = {}): Promise<Paginated<Tweet>> =>
      this.#request('GET', 'sdk/tweets', { query: { ...params } }),
  }

  events = {
    list: (params: PaginationParams & { upcoming?: boolean } = {}): Promise<Paginated<Event>> =>
      this.#request('GET', 'sdk/events', {
        query: {
          page: params.page,
          limit: params.limit,
          upcoming: params.upcoming === undefined ? undefined : String(params.upcoming),
        },
      }),
  }

  blogs = {
    list: (params: PaginationParams = {}): Promise<Paginated<Blog>> =>
      this.#request('GET', 'sdk/blogs', { query: { ...params } }),
  }

  albums = {
    list: (params: PaginationParams = {}): Promise<Paginated<Album>> =>
      this.#request('GET', 'sdk/albums', { query: { ...params } }),
  }

  members = {
    list: (params: PaginationParams = {}): Promise<Paginated<Member>> =>
      this.#request('GET', 'sdk/members', { query: { ...params } }),
  }

  // ─── Embed ─────────────────────────────────────────────────────────────────

  embed = {
    /**
     * Mint a short-lived, single-use token for one of your logged-in users.
     *
     * Call this from your backend, per page load, and hand the token to the
     * browser. Do not cache it: it is valid for ~120 seconds and dies on first
     * use, which is exactly what makes it safe to put in a URL fragment.
     */
    createSession: (input: CreateEmbedSessionInput): Promise<EmbedSession> =>
      this.#request('POST', 'embed/sessions', { body: input }),

    /**
     * Build the iframe URL for a minted token.
     *
     * The token goes in the fragment, never the query string. Fragments are not
     * sent to the server, so the token stays out of nginx logs, `Referer`
     * headers, and any analytics the host page runs.
     */
    buildUrl: (args: { slug: string; section: EmbedSection; token: string }): string => {
      const { slug, section, token } = args
      return `${this.#baseUrl}/embed/${encodeURIComponent(slug)}/${section}#t=${encodeURIComponent(token)}`
    },
  }
}

export function createGurbClient(options: GurbClientOptions): GurbClient {
  return new GurbClient(options)
}
