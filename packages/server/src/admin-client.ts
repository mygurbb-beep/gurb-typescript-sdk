import type {
  ApiKeySummary,
  ApiKeyWithSecret,
  Community,
  CommunityRequest,
  CommunityRequestStatus,
  CreateCommunityInput,
  Paginated,
  PaginationParams,
  SdkIdentity,
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
 * The slug and name rules, in one place so the checks and the messages cannot
 * drift.
 *
 * These mirror the server's own rules, and THAT IS A LIABILITY rather than just
 * a convenience: a client-side copy of a server rule is wrong the moment the
 * server relaxes it, and then this SDK refuses slugs the platform would happily
 * accept, with no server-side change able to fix it. It is worth it here only
 * because the rule is a URL grammar rather than a policy — it changes about as
 * often as URLs do — and because the alternative is a round trip to learn you
 * typed a capital letter.
 */
const SLUG_MIN_LENGTH = 3
const SLUG_MAX_LENGTH = 50
const NAME_MAX_LENGTH = 100

function localValidation(message: string): GurbApiError {
  // `status: 0` is the marker that no HTTP call was ever made. A caller
  // retrying on a 5xx must not retry one of these — the request would be
  // identical and so would the refusal.
  return new GurbApiError({ message, code: 'VALIDATION_ERROR', status: 0 })
}

/**
 * Characters, not UTF-16 code units.
 *
 * `'نادي'.length` counts units, and an emoji or an astral character counts as
 * two. Measuring a name that way rejects a perfectly ordinary name for being
 * "over 100" — the kind of bug that only shows up in the language the product
 * is actually used in. The spread operator iterates code points.
 */
function characterCount(value: string): number {
  return [...value].length
}

/** @throws GurbApiError with a message naming the rule that was broken. */
function assertValidName(trimmed: string, original: string): void {
  if (trimmed === '') {
    throw localValidation(
      original === ''
        ? 'A community name is required.'
        : 'A community name cannot be only whitespace.',
    )
  }

  const length = characterCount(trimmed)
  if (length > NAME_MAX_LENGTH) {
    throw localValidation(
      `A community name may be at most ${NAME_MAX_LENGTH} characters; this one is ${length}.`,
    )
  }
}

/**
 * Every slug rule, each with a message naming the rule it broke.
 *
 * "Invalid slug" tells an integrator nothing — they are looking at a string
 * that looks fine to them. Each branch below says which rule, and shows the
 * value, so the fix is obvious from the log line alone.
 *
 * @throws GurbApiError
 */
function assertValidSlug(slug: string): void {
  if (!slug) {
    throw localValidation(
      'A community slug is required. Slugs are the latin identifier in the URL, like "book-club".',
    )
  }

  // Charset first, so everything after it is guaranteed ASCII and a length is
  // a character length.
  if (/[^a-z0-9-]/.test(slug)) {
    const lowered = slug.toLowerCase()
    if (lowered !== slug && !/[^a-z0-9-]/.test(lowered)) {
      // By far the most common mistake, and the most annoying one to diagnose
      // from a generic message. Hand over the answer.
      throw localValidation(
        `Community slugs are lowercase: "${slug}" is not valid, but "${lowered}" would be. ` +
          'A slug may contain lowercase letters (a-z), digits (0-9) and hyphens only.',
      )
    }

    throw localValidation(
      `"${slug}" is not a valid community slug. A slug may contain lowercase letters (a-z), ` +
        'digits (0-9) and hyphens only — no spaces, accents or Arabic. The Arabic name goes in `name`.',
    )
  }

  if (slug.startsWith('-') || slug.endsWith('-')) {
    throw localValidation(`A community slug may not start or end with a hyphen: "${slug}".`)
  }

  if (slug.includes('--')) {
    throw localValidation(`A community slug may not contain consecutive hyphens: "${slug}".`)
  }

  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    throw localValidation(
      `A community slug must be ${SLUG_MIN_LENGTH} to ${SLUG_MAX_LENGTH} characters; "${slug}" is ${slug.length}.`,
    )
  }
}

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
     *
     * TWO REQUIRED FIELDS AND ONE WAY TO NAME AN OWNER. There is no
     * `description`, no `type` and no `ownerUserId`, because the endpoint does
     * not honour them: visibility is decided server-side (PRIVATE), and a field
     * accepted and dropped on the floor is worse than one that never existed —
     * it reads as a choice the caller made, and it is not.
     *
     * WHO ENDS UP OWNING IT, in precedence order:
     *
     *   `owner`       an identity your registered IdP vouches for
     *   `ownerEmail`  a Gurb account named directly, created if new
     *   neither       whoever the KEY acts for — see `me()` before relying on
     *                 this, because on a key with no subject that is the
     *                 platform admin who minted it, not you
     */
    create: (input: CreateCommunityInput): Promise<Community> => {
      const original = input.name ?? ''
      const name = original.trim()
      const ownerEmail = input.ownerEmail?.trim() ?? ''

      try {
        assertValidName(name, original)
        assertValidSlug(input.slug ?? '')

        if (ownerEmail && input.owner) {
          // No correct guess exists. One asserts an identity through a
          // registered provider, the other names a Gurb account directly, and
          // they can disagree about which human is meant.
          throw localValidation(
            'Send either owner or ownerEmail, not both: the first asserts an identity ' +
              'through a registered provider, the second names a Gurb account directly.',
          )
        }

        if (input.owner) {
          const { provider, externalUserId, email, emailVerified } = input.owner
          if (!provider || !externalUserId || !email) {
            throw localValidation('An external owner needs provider, externalUserId and email.')
          }
          if (typeof emailVerified !== 'boolean') {
            // Not defaulted on purpose. `emailVerified` decides whether an
            // incoming identity may join an account that already exists, so an
            // absent claim must be sent as the absence it is — never assumed
            // true because it was easier to leave out.
            throw localValidation(
              "owner.emailVerified must be the provider's own claim, sent explicitly as true or false.",
            )
          }
        }
      } catch (cause) {
        return Promise.reject(cause)
      }

      // Names are only sent alongside an address, and only when non-empty: an
      // empty string is a value the server has to interpret, and its answer
      // would be a 400 for a field the caller simply left alone.
      const ownerFirstName = input.ownerFirstName?.trim() ?? ''
      const ownerFamilyName = input.ownerFamilyName?.trim() ?? ''

      return this.#http.request('POST', 'admin/sdk/communities', {
        body: {
          name,
          slug: input.slug,
          ...(input.owner ? { owner: input.owner } : {}),
          ...(ownerEmail
            ? {
                ownerEmail,
                ...(ownerFirstName ? { ownerFirstName } : {}),
                ...(ownerFamilyName ? { ownerFamilyName } : {}),
              }
            : {}),
        },
      })
    },
  }

  /**
   * WHO THIS KEY ACTS FOR. Make this your first call.
   *
   * It answers the one question you cannot answer from the key string itself:
   * was the key you were handed actually set up FOR you, or does it still act
   * for the platform admin who minted it?
   *
   * That matters before anything irreversible. A platform key can only be
   * minted BY a super admin, so a key with no subject founds every community in
   * the admin's name — the customer ends up owning nothing, and nobody notices
   * until someone asks why their community belongs to someone else.
   *
   * ```ts
   * const me = await admin.me()
   * if (me.actsForIssuer) {
   *   throw new Error('This key has no subject — anything I create will belong to the platform admin.')
   * }
   * const owner = effectiveOwner(me)   // email, display name, phone
   * ```
   *
   * `effectiveOwner(me).phone` is never null: an account with no number reports
   * a run of zeros with `phoneIsPlaceholder` set, so a profile card has a field
   * of the right shape to render. Use `realPhone()` when you need the truth.
   *
   * A 200 proves the key is live and names a real, active account. It proves
   * nothing about permissions — those are checked per operation and differ per
   * section by design.
   */
  me = (): Promise<SdkIdentity> => this.#http.request('GET', 'admin/sdk/me')

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
