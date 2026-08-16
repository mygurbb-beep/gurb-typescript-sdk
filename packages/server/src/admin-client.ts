import type {
  ApiKeySummary,
  ApiKeyWithSecret,
  Community,
  CommunityRequest,
  CommunityRequestStatus,
  CreateCommunityInput,
  Paginated,
  PaginationParams,
} from '@gurb/api-types'
import { GurbApiError } from './errors.js'
import { assertServerEnvironment, assertValidAdminKey } from './key.js'
import { Transport } from './transport.js'

export interface GurbAdminClientOptions {
  /** A platform super-admin key: `gurb_sa_<id>_<secret>`. */
  adminKey: string
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://mygurb.com'

/**
 * Platform administration. Separate from `GurbClient` on purpose.
 *
 * Everything here is an operation an ordinary integration must never perform:
 * creating communities, approving requests, minting and revoking the keys other
 * integrations run on. Keeping it in its own class with its own credential type
 * means the dangerous surface is something you have to reach for deliberately —
 * you cannot arrive at `communities.create()` by autocompleting from a client
 * you built for reading a feed.
 *
 * This mirrors how the platform itself works: SUPER_ADMIN is not a bigger
 * community role, it is a different kind of actor.
 */
export class GurbAdminClient {
  readonly #http: Transport

  constructor(options: GurbAdminClientOptions) {
    assertServerEnvironment('GurbAdminClient')
    assertValidAdminKey(options.adminKey)

    this.#http = new Transport({
      apiKey: options.adminKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  }

  // ─── Communities ───────────────────────────────────────────────────────────

  communities = {
    list: (params: PaginationParams & { search?: string } = {}): Promise<Paginated<Community>> =>
      this.#http.request('GET', 'admin/sdk/communities', { query: { ...params } }),

    /**
     * Create a community outright, with no approval step.
     *
     * This is the operation the whole super-admin key exists to protect. Anyone
     * holding this credential can populate the platform, so treat it the way
     * you would treat a database password: one holder, injected from a secret
     * store, never in a repository, rotated on staff changes.
     */
    create: (input: CreateCommunityInput): Promise<Community> => {
      const name = input.name?.trim() ?? ''
      if (!name || name.length > 100) {
        return Promise.reject(new GurbApiError({
          message: 'A community name is required and must be at most 100 characters.',
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }

      // Checked here so a malformed slug is a local error naming the rule,
      // rather than a round trip that comes back 400 saying "invalid slug".
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug ?? '') || input.slug.length < 3 || input.slug.length > 50) {
        return Promise.reject(new GurbApiError({
          message:
            'Invalid slug. Use lowercase letters, digits and hyphens only, 3-50 characters, with no leading, trailing or repeated hyphen.',
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }

      if (input.owner) {
        const { provider, externalUserId, email, emailVerified } = input.owner
        if (!provider || !externalUserId || !email) {
          return Promise.reject(new GurbApiError({
            message: 'An external owner needs provider, externalUserId and email.',
            code: 'VALIDATION_ERROR',
            status: 0,
          }))
        }
        if (typeof emailVerified !== 'boolean') {
          // Not defaulted on purpose. `emailVerified` decides whether an
          // incoming identity may join an account that already exists, so an
          // absent claim must be sent as the absence it is — never assumed true
          // because it was easier to leave out.
          return Promise.reject(new GurbApiError({
            message:
              'owner.emailVerified must be the provider\'s own claim, sent explicitly as true or false.',
            code: 'VALIDATION_ERROR',
            status: 0,
          }))
        }
      }

      // Two fields, plus the owner when one is named. Nothing else — anything
      // more would be a choice the endpoint does not honour.
      return this.#http.request('POST', 'admin/sdk/communities', {
        body: { name, slug: input.slug, ...(input.owner ? { owner: input.owner } : {}) },
      })
    },
  }

  // ─── The approval queue ────────────────────────────────────────────────────

  communityRequests = {
    list: (
      params: PaginationParams & { status?: CommunityRequestStatus } = {},
    ): Promise<Paginated<CommunityRequest>> =>
      this.#http.request('GET', 'admin/sdk/community-requests', { query: { ...params } }),

    get: (requestId: string): Promise<CommunityRequest> =>
      this.#http.request('GET', `admin/sdk/community-requests/${encodeURIComponent(requestId)}`),

    /**
     * Approve a pending request. The community is created as part of this call,
     * and its id comes back on the request.
     *
     * Approving an already-decided request fails rather than creating a second
     * community — the decision, not the click, is what is idempotent.
     */
    approve: (requestId: string): Promise<CommunityRequest> =>
      this.#http.request('POST', `admin/sdk/community-requests/${encodeURIComponent(requestId)}/approve`),

    /**
     * Reject a pending request.
     *
     * A reason is required, not optional: the requester is shown it, and
     * "rejected" with no explanation generates a support ticket every time.
     */
    reject: (requestId: string, reason: string): Promise<CommunityRequest> => {
      if (!reason || reason.trim().length === 0) {
        return Promise.reject(new GurbApiError({
          message: 'A rejection reason is required — the requester is shown it.',
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }
      return this.#http.request(
        'POST',
        `admin/sdk/community-requests/${encodeURIComponent(requestId)}/reject`,
        { body: { reason: reason.trim() } },
      )
    },
  }

  // ─── API keys ──────────────────────────────────────────────────────────────

  apiKeys = {
    list: (params: PaginationParams & { communityId?: string } = {}): Promise<Paginated<ApiKeySummary>> =>
      this.#http.request('GET', 'admin/sdk/api-keys', { query: { ...params } }),

    /**
     * Mint a community-scoped key.
     *
     * The plaintext key is in this response and **nowhere else, ever**. There is
     * no read-back route by design: if the secret could be fetched again, then
     * read access to your admin surface would be equivalent to holding every
     * key it ever issued. Hand it to its owner now or discard it and mint
     * another.
     *
     * Scope it to `['read']` unless the integration genuinely writes. Most do
     * not, and a read-only key that leaks is an incident you can close.
     */
    create: (input: {
      communityId: string
      /** Shown in the dashboard so a human can tell keys apart later. */
      name: string
      scopes?: ('read' | 'write')[]
    }): Promise<ApiKeyWithSecret> =>
      this.#http.request('POST', 'admin/sdk/api-keys', {
        body: { ...input, scopes: input.scopes ?? ['read'] },
      }),

    /**
     * Revoke a key. Takes effect immediately and cannot be undone — revocation
     * is one-way so that "is this key still live?" has exactly one answer.
     */
    revoke: (keyId: string): Promise<ApiKeySummary> =>
      this.#http.request('POST', `admin/sdk/api-keys/${encodeURIComponent(keyId)}/revoke`),
  }
}

export function createGurbAdminClient(options: GurbAdminClientOptions): GurbAdminClient {
  return new GurbAdminClient(options)
}
