import {
  BULK_MEMBER_LIMIT,
  type Album,
  type Blog,
  type BulkMemberInput,
  type BulkMemberResult,
  type Community,
  type CommunityRequest,
  type CommunityRole,
  type CreateCommunityInput,
  type CreateEmbedSessionInput,
  type EmbedSection,
  type EmbedSession,
  type Event,
  type Member,
  type MemberPermissions,
  type Paginated,
  type PaginationParams,
  type Permission,
  type Tweet,
} from '@gurb/api-types'
import { GurbApiError } from './errors.js'
import { assertServerEnvironment, assertValidApiKey } from './key.js'
import { Transport } from './transport.js'

export interface GurbClientOptions {
  apiKey: string
  /**
   * Origin only — no `/api` suffix. The client appends `api/` itself, matching
   * how the web app's own `apiUrl()` helper behaves. Passing `/api/v1` here
   * produces requests to routes that do not exist, and the response is not
   * always a clean 404 — so a typo here can present as an auth problem.
   */
  baseUrl?: string
  /** Injected for tests. Defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://mygurb.com'

export class GurbClient {
  readonly #http: Transport

  constructor(options: GurbClientOptions) {
    assertServerEnvironment()
    assertValidApiKey(options.apiKey)

    this.#http = new Transport({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  }

  // ─── Community ─────────────────────────────────────────────────────────────

  /** The community this key is pinned to. A key can never read another one. */
  community = {
    get: (): Promise<Community> => this.#http.request('GET', 'sdk/community'),

    /**
     * Ask for a new community to be created.
     *
     * A community key cannot create one outright — that is a super-admin
     * operation. This files a request that a platform admin approves or
     * rejects, which is the same gate the dashboard uses. Poll
     * `communityRequests.get()` or subscribe to the `community.approved`
     * webhook rather than assuming success.
     */
    requestCreation: (input: CreateCommunityInput): Promise<CommunityRequest> =>
      this.#http.request('POST', 'sdk/community-requests', { body: input }),
  }

  communityRequests = {
    list: (
      params: PaginationParams & { status?: CommunityRequest['status'] } = {},
    ): Promise<Paginated<CommunityRequest>> =>
      this.#http.request('GET', 'sdk/community-requests', { query: { ...params } }),

    get: (requestId: string): Promise<CommunityRequest> =>
      this.#http.request('GET', `sdk/community-requests/${encodeURIComponent(requestId)}`),
  }

  // ─── Content ───────────────────────────────────────────────────────────────

  tweets = {
    list: (params: PaginationParams = {}): Promise<Paginated<Tweet>> =>
      this.#http.request('GET', 'sdk/tweets', { query: { ...params } }),
  }

  events = {
    list: (params: PaginationParams & { upcoming?: boolean } = {}): Promise<Paginated<Event>> =>
      this.#http.request('GET', 'sdk/events', { query: { ...params } }),
  }

  blogs = {
    list: (params: PaginationParams = {}): Promise<Paginated<Blog>> =>
      this.#http.request('GET', 'sdk/blogs', { query: { ...params } }),
  }

  albums = {
    list: (params: PaginationParams = {}): Promise<Paginated<Album>> =>
      this.#http.request('GET', 'sdk/albums', { query: { ...params } }),
  }

  // ─── Members, roles and permissions ────────────────────────────────────────

  members = {
    list: (params: PaginationParams & { role?: CommunityRole } = {}): Promise<Paginated<Member>> =>
      this.#http.request('GET', 'sdk/members', { query: { ...params } }),

    get: (memberId: string): Promise<Member> =>
      this.#http.request('GET', `sdk/members/${encodeURIComponent(memberId)}`),

    /**
     * Change a member's role.
     *
     * The platform caps this at your key's own authority: a key minted by a
     * MODERATOR cannot produce an ADMIN. That check lives on the server because
     * a client-side one is a suggestion, not a control.
     */
    setRole: (memberId: string, role: CommunityRole): Promise<Member> =>
      this.#http.request('PATCH', `sdk/members/${encodeURIComponent(memberId)}/role`, {
        body: { role },
      }),

    /** What this member can actually do: role grants plus individual overrides. */
    getPermissions: (memberId: string): Promise<MemberPermissions> =>
      this.#http.request('GET', `sdk/members/${encodeURIComponent(memberId)}/permissions`),

    /**
     * Grant or revoke permissions for one member, on top of their role.
     *
     * Both lists are applied in one request so a member is never briefly left
     * with the grant applied and the revoke not — two calls cannot be made
     * atomic from the outside.
     *
     * Sending the same permission in both lists is rejected rather than
     * silently resolved: there is no correct guess at what was meant.
     */
    updatePermissions: (
      memberId: string,
      changes: { grant?: Permission[]; revoke?: Permission[] },
    ): Promise<MemberPermissions> => {
      const grant = changes.grant ?? []
      const revoke = changes.revoke ?? []

      const conflicting = grant.filter((p) => revoke.includes(p))
      if (conflicting.length > 0) {
        return Promise.reject(new GurbApiError({
          message: `Cannot grant and revoke the same permission in one call: ${conflicting.join(', ')}`,
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }
      if (grant.length === 0 && revoke.length === 0) {
        return Promise.reject(new GurbApiError({
          message: 'updatePermissions needs at least one permission to grant or revoke.',
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }

      return this.#http.request('PATCH', `sdk/members/${encodeURIComponent(memberId)}/permissions`, {
        body: { grant, revoke },
      })
    },

    remove: (memberId: string): Promise<void> =>
      this.#http.request('DELETE', `sdk/members/${encodeURIComponent(memberId)}`),

    /**
     * Add or update many members in one call.
     *
     * Matched on `externalUserId`, so re-sending the same list is safe: an id
     * already known is updated, not duplicated. That makes this usable as a
     * nightly sync of your own user table and not just a one-off import.
     *
     * Individual rows can fail without failing the batch — check `failed`.
     * Lists longer than {@link BULK_MEMBER_LIMIT} are rejected here rather than
     * sent, because a request that large is likely to die at a proxy timeout
     * with no way to know which half landed.
     */
    bulkUpsert: (members: BulkMemberInput[]): Promise<BulkMemberResult> => {
      if (members.length === 0) {
        return Promise.reject(new GurbApiError({
          message: 'bulkUpsert needs at least one member.',
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }
      if (members.length > BULK_MEMBER_LIMIT) {
        return Promise.reject(new GurbApiError({
          message: `bulkUpsert accepts at most ${BULK_MEMBER_LIMIT} members per call; you sent ${members.length}. Chunk the list and send it in batches.`,
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }

      // A duplicate id inside one batch would race against itself server-side,
      // and the winner would be arbitrary. Better to name the id than to guess.
      const seen = new Set<string>()
      for (const member of members) {
        if (seen.has(member.externalUserId)) {
          return Promise.reject(new GurbApiError({
            message: `Duplicate externalUserId in the same batch: ${member.externalUserId}`,
            code: 'VALIDATION_ERROR',
            status: 0,
          }))
        }
        seen.add(member.externalUserId)
      }

      return this.#http.request('POST', 'sdk/members/bulk', { body: { members } })
    },
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
      this.#http.request('POST', 'embed/sessions', { body: input }),

    /**
     * Build the iframe URL for a minted token.
     *
     * The token goes in the fragment, never the query string. Fragments are not
     * sent to the server, so the token stays out of access logs, `Referer`
     * headers, and any analytics the host page runs.
     */
    buildUrl: (args: { slug: string; section: EmbedSection; token: string }): string => {
      const { slug, section, token } = args
      return `${this.#http.baseUrl}/embed/${encodeURIComponent(slug)}/${section}#t=${encodeURIComponent(token)}`
    },
  }
}

export function createGurbClient(options: GurbClientOptions): GurbClient {
  return new GurbClient(options)
}
