import type { GurbErrorCode, GurbErrorBody } from '@gurb/api-types'

/**
 * The only error this SDK throws.
 *
 * One class, not a hierarchy: a consumer writing `catch (e)` should need one
 * `instanceof` check and then branch on `code`. Transport failures are mapped
 * into it too (`NETWORK_ERROR`) so that "the request failed" and "the server
 * said no" are not two different shapes to handle.
 */
export class GurbApiError extends Error {
  readonly code: GurbErrorCode
  readonly status: number
  readonly requestId: string | undefined

  constructor(args: {
    message: string
    code: GurbErrorCode
    status: number
    requestId?: string | undefined
  }) {
    super(args.message)
    this.name = 'GurbApiError'
    this.code = args.code
    this.status = args.status
    this.requestId = args.requestId
    Object.setPrototypeOf(this, GurbApiError.prototype)
  }

  /** Retrying only ever helps for these. Anything else is a client-side bug. */
  get isRetryable(): boolean {
    return this.code === 'NETWORK_ERROR' || this.code === 'RATE_LIMITED' || this.status >= 500
  }
}

const KNOWN_CODES = new Set<string>([
  'INVALID_API_KEY',
  'API_KEY_REVOKED',
  'FORBIDDEN_SURFACE',
  'INSUFFICIENT_SCOPE',
  'FEATURE_NOT_AVAILABLE',
  'NOT_FOUND',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'JOIN_THROUGH_HOST_ONLY',
  'HOST_MEMBER_BLOCKED',
  'MEMBER_NOT_ACTIVE',
  'ACCOUNT_NOT_USABLE',
  'EXTERNAL_IDENTITY_MANUAL_LINK_REQUIRED',
  'EXTERNAL_IDENTITY_INVALID_INPUT',
  'EVENT_REMINDER_COOLDOWN',
  'EVENT_NOT_REMINDABLE',
  'EVENT_ALREADY_STARTED',
  'EVENT_REMINDER_NO_RECIPIENTS',
  'INVITES_DAILY_LIMIT',
  'RESTRICTION_BLOCKED',
  'INVITE_CHANNEL_INVALID',
  'REMINDER_AUDIENCE_INVALID',
  'REMINDER_MEMBERS_REQUIRED',
  'REMINDER_MEMBERS_TOO_MANY',
  'REMINDER_MESSAGE_TOO_LONG',
  'REMINDER_BROAD_DAILY_LIMIT',
])

/**
 * Map an HTTP failure onto a stable code.
 *
 * The backend's `error` field is preferred when we recognise it. We do NOT
 * pass unrecognised strings straight through as `code` — a consumer switching
 * on `code` would then be coupled to backend copy that can change without a
 * version bump. Unknown becomes `UNKNOWN`; the original text stays in `message`.
 */
export function toApiError(status: number, body: unknown): GurbApiError {
  const parsed = (body ?? {}) as GurbErrorBody
  // `error` first, then `code`: Gurb's service errors carry the stable code in
  // `code` only (e.g. JOIN_THROUGH_HOST_ONLY thrown from a service). Either way
  // only a code we KNOW becomes `code` — anything else stays in `message`.
  const fromError = typeof parsed.error === 'string' && KNOWN_CODES.has(parsed.error) ? parsed.error : undefined
  const fromCode = typeof parsed.code === 'string' && KNOWN_CODES.has(parsed.code) ? parsed.code : undefined
  const declared = fromError ?? fromCode ?? (typeof parsed.error === 'string' ? parsed.error : undefined)

  let code: GurbErrorCode = 'UNKNOWN'
  if (declared && KNOWN_CODES.has(declared)) {
    code = declared as GurbErrorCode
  } else if (status === 401) {
    code = 'INVALID_API_KEY'
  } else if (status === 403) {
    code = 'FORBIDDEN_SURFACE'
  } else if (status === 404) {
    code = 'NOT_FOUND'
  } else if (status === 429) {
    code = 'RATE_LIMITED'
  } else if (status === 400 || status === 422) {
    code = 'VALIDATION_ERROR'
  }

  return new GurbApiError({
    message: parsed.message ?? declared ?? `Gurb API request failed with status ${status}`,
    code,
    status,
    requestId: parsed.requestId,
  })
}
