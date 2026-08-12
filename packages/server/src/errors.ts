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
  const declared = typeof parsed.error === 'string' ? parsed.error : undefined

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
