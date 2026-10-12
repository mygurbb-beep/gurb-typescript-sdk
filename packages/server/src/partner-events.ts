/**
 * Partner events — Gurb Partner Sign-In, events contract v1.
 *
 * A HOST (a partner site whose members sign in to a Gurb community through it)
 * tells Gurb whether each member may still be inside, and keeps their name,
 * email and photo current. It does that by POSTing signed events to
 *
 *   POST {baseUrl}/api/webhooks/inbound/{communityId}/host
 *
 * signed with Standard Webhooks (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature: v1,<base64 HMAC-SHA256>`) using the community's EVENTS
 * secret (`whsec_…`) — a Gurb super admin hands it over; it is NOT an API key.
 *
 *   const events = new GurbPartnerEvents({ communityId, secret: process.env.GURB_EVENTS_SECRET! })
 *   const evt = events.accessChanged({ sub, stateVersion, access: 'blocked' })
 *   await outbox.save(evt)                 // in the SAME transaction as your change
 *   const result = await events.send(evt)  // 'delivered' | 'rejected' | 'retry'
 *
 * TWO HALVES ON PURPOSE. Building an event is pure and gives you a plain,
 * JSON-serialisable object to store in your own outbox in the same database
 * transaction as the change it reports; sending it is a separate call your
 * worker makes, and repeats, later. `send()` never retries by itself: the
 * contract puts retries in the host's outbox (back-off 1 m → 5 m → 30 m → 2 h …
 * for 72 h), and an SDK retrying underneath would multiply every one of them.
 *
 * Every send re-signs with a fresh timestamp (Gurb refuses timestamps more than
 * 5 minutes off), while `id` and the body stay byte-identical, so a retry is
 * recognised as a duplicate and applied once.
 *
 * Delivery rules, as Gurb applies them:
 *   - `state_version` is monotonic per member; the newest wins, so delivery may
 *     be duplicated and out of order.
 *   - an unknown member, a duplicate or a stale version is 2xx — nothing to do.
 *   - 400/401/403/404 → do NOT retry: the event or the configuration is wrong.
 *   - 408/429/5xx/network → retry later.
 */

import { createHmac, randomUUID } from 'node:crypto'

import { GurbApiError } from './errors.js'
import { assertServerEnvironment } from './key.js'

const DEFAULT_BASE_URL = 'https://mygurb.com'
const DEFAULT_TIMEOUT_MS = 10_000

/** Contract limits — the same numbers Gurb's receiver enforces, so a mistake fails HERE. */
export const PARTNER_EVENT_LIMITS = {
  subMaxLength: 255,
  nameMaxLength: 200,
  avatarUrlMaxLength: 2048,
  snapshotPageMaxMembers: 500,
  snapshotMaxPages: 1000,
  snapshotIdMaxLength: 200,
  /** generated_at may be at most this far in the future … */
  snapshotMaxFutureMs: 5 * 60 * 1000,
  /** … and at most this old when a page is sent. */
  snapshotMaxAgeMs: 72 * 60 * 60 * 1000,
} as const

export type PartnerAccess = 'allowed' | 'blocked'

export type PartnerEventType =
  | 'access.changed'
  | 'member.session_revoked'
  | 'member.updated'
  | 'member.deleted'
  | 'access.snapshot'
  | 'ping'

/**
 * A built event, ready to store and send. Plain data: `JSON.stringify` it into
 * your outbox and hand the parsed object back to `send()` later. `body` is the
 * exact string that is signed and sent — never rebuild it from `type`.
 */
export interface PartnerEvent {
  readonly id: string
  readonly type: PartnerEventType
  readonly createdAt: string
  readonly body: string
}

export interface PartnerSnapshotMember {
  sub: string
  stateVersion: number
  access: PartnerAccess
}

export interface PartnerEventsOptions {
  /** The Gurb community these events are about (its UUID). */
  communityId: string
  /**
   * The community's events secret, `whsec_…`. During a rotation pass BOTH
   * (newest first): every send is signed with each, and Gurb accepts a match on
   * any secret it still holds.
   */
  secret: string | readonly string[]
  /** Default https://mygurb.com — or your community's custom domain. */
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  /** Per send. Default 10 s, the same timeout the contract gives Gurb. */
  timeoutMs?: number
}

export type PartnerSendOutcome =
  /** 2xx: applied, or safely ignored (duplicate, stale, unknown member). Mark it delivered. */
  | 'delivered'
  /** 400/401/403/404: retrying cannot help — fix the event or the setup, and alert a human. */
  | 'rejected'
  /** 408/429/5xx, timeout or network error: keep it in the outbox and retry with back-off. */
  | 'retry'

export interface PartnerSendResult {
  outcome: PartnerSendOutcome
  /** HTTP status, or 0 when no response arrived. */
  status: number
  /** Gurb's stable code on a refusal (e.g. HOST_EVENT_INVALID), when it sent one. */
  code?: string
  /** What Gurb did with a delivered event: applied | duplicate | stale | unknown_member | ignored. */
  applied?: string
  /** Gurb's message, or the network error. Never logged by the SDK. */
  message?: string
}

/**
 * A builder (or the constructor) refused its input — a bug in the caller,
 * raised before anything is sent. The same shape as every other local guard in
 * this SDK: a GurbApiError with VALIDATION_ERROR and `status: 0` (no HTTP call
 * was made), so there is still exactly one thing to catch.
 */
function invalid(message: string): GurbApiError {
  return new GurbApiError({ message, code: 'VALIDATION_ERROR', status: 0 })
}

// ─── validation (mirrors the receiver) ───────────────────────────────────────

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const WHSEC_RE = /^whsec_[A-Za-z0-9+/]+={0,2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function storable(value: string, field: string): string {
  if (CONTROL_RE.test(value) || LONE_SURROGATE_RE.test(value)) {
    throw invalid(`${field} contains a control character or broken Unicode`)
  }
  return value
}

function sub(value: unknown, field = 'sub'): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > PARTNER_EVENT_LIMITS.subMaxLength) {
    throw invalid(`${field} must be 1-${PARTNER_EVENT_LIMITS.subMaxLength} characters`)
  }
  return storable(trimmed, field)
}

function version(value: unknown, field = 'stateVersion'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer`)
  }
  return value
}

function access(value: unknown): PartnerAccess {
  if (value !== 'allowed' && value !== 'blocked') throw invalid('access must be "allowed" or "blocked"')
  return value
}

function optionalText(value: string | null | undefined, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`${field} must be a string`)
  const trimmed = storable(value, field).trim()
  if (!trimmed) return undefined
  if (trimmed.length > max) throw invalid(`${field} must be at most ${max} characters`)
  return trimmed
}

function email(value: string | null | undefined): string | undefined {
  const text = optionalText(value, 'email', 320)
  if (text === undefined) return undefined
  const at = text.indexOf('@')
  if (/\s/.test(text) || at <= 0 || at !== text.lastIndexOf('@') || at === text.length - 1) {
    throw invalid('email is not a valid address')
  }
  if (text.toLowerCase().endsWith('.embed.invalid')) {
    throw invalid('email is a Gurb placeholder address, not a real one')
  }
  return text
}

function avatarUrl(value: string | null | undefined): string | undefined {
  const text = optionalText(value, 'avatarUrl', PARTNER_EVENT_LIMITS.avatarUrlMaxLength)
  if (text === undefined) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw invalid('avatarUrl must be an absolute URL')
  }
  // Gurb fetches photos over https on port 443 only; anything else would be
  // accepted, then silently never replace the member's photo.
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
    throw invalid('avatarUrl must be https on the default port — Gurb fetches nothing else')
  }
  return text
}

function snapshotId(value: string | undefined): string {
  const id = value ?? `snap_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${randomUUID().slice(0, 8)}`
  if (!id || id.length > PARTNER_EVENT_LIMITS.snapshotIdMaxLength || !/^[\x21-\x7e]+$/.test(id)) {
    throw invalid(`snapshotId must be printable ASCII without spaces, at most ${PARTNER_EVENT_LIMITS.snapshotIdMaxLength} characters`)
  }
  return id
}

// ─── signing ─────────────────────────────────────────────────────────────────

function secretBytes(secret: string): Buffer {
  return Buffer.from(secret.slice('whsec_'.length), 'base64')
}

/** `v1,<sig>` per secret, space-separated (Standard Webhooks). Exported for tests and custom transports. */
export function signPartnerEvent(secrets: readonly string[], id: string, timestampSeconds: number, body: string): string {
  return secrets
    .map((secret) => `v1,${createHmac('sha256', secretBytes(secret)).update(`${id}.${timestampSeconds}.${body}`).digest('base64')}`)
    .join(' ')
}

// ─── the client ──────────────────────────────────────────────────────────────

export class GurbPartnerEvents {
  readonly #communityId: string
  readonly #secrets: readonly string[]
  readonly #url: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number

  constructor(options: PartnerEventsOptions) {
    assertServerEnvironment('GurbPartnerEvents')
    if (typeof options.communityId !== 'string' || !UUID_RE.test(options.communityId)) {
      throw invalid('communityId must be the community UUID')
    }
    const secrets = typeof options.secret === 'string' ? [options.secret] : [...(options.secret ?? [])]
    if (secrets.length === 0 || secrets.length > 2) throw invalid('pass one events secret, or two during a rotation')
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.startsWith('gurb_')) {
        // The two credentials must never be interchangeable: an API key here
        // would be a key leaking into an events config (and vice versa).
        throw invalid('this is a Gurb API key, not an events secret (whsec_…) — they are separate credentials')
      }
      if (typeof secret !== 'string' || !WHSEC_RE.test(secret) || secretBytes(secret).length < 24) {
        throw invalid('secret must be the community events secret, "whsec_<base64>"')
      }
    }
    this.#communityId = options.communityId.toLowerCase()
    this.#secrets = secrets
    const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.#url = `${base}/api/webhooks/inbound/${this.#communityId}/host`
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (typeof this.#fetch !== 'function') throw invalid('No fetch implementation available. Node 20+ is required, or pass { fetch }.')
  }

  /** Where events go. */
  get endpoint(): string {
    return this.#url
  }

  #build(type: PartnerEventType, data: Record<string, unknown>): PartnerEvent {
    const id = `evt_${randomUUID().replace(/-/g, '')}`
    const createdAt = new Date().toISOString()
    const body = JSON.stringify({ id, type, created_at: createdAt, community: this.#communityId, data })
    return { id, type, createdAt, body }
  }

  /** A member's access changed. Send it on EVERY change, with the member's complete current access. */
  accessChanged(input: { sub: string; stateVersion: number; access: PartnerAccess }): PartnerEvent {
    return this.#build('access.changed', { sub: sub(input.sub), state_version: version(input.stateVersion), access: access(input.access) })
  }

  /** The member's login ended on your side (password reset, email change): end every Gurb session too. */
  sessionRevoked(input: { sub: string; stateVersion: number; reason?: 'credentials_changed' }): PartnerEvent {
    return this.#build('member.session_revoked', {
      sub: sub(input.sub),
      state_version: version(input.stateVersion),
      reason: input.reason ?? 'credentials_changed',
    })
  }

  /**
   * The member's shared identity changed. A FULL REPLACEMENT: an omitted field
   * means "empty" — no email moves the member to a placeholder address on Gurb,
   * no avatarUrl removes their photo. Always send every field you share.
   */
  memberUpdated(input: {
    sub: string
    stateVersion: number
    name?: string | null
    email?: string | null
    avatarUrl?: string | null
    locale?: 'ar' | 'en'
  }): PartnerEvent {
    const data: Record<string, unknown> = { sub: sub(input.sub), state_version: version(input.stateVersion) }
    const name = optionalText(input.name, 'name', PARTNER_EVENT_LIMITS.nameMaxLength)
    const mail = email(input.email)
    const photo = avatarUrl(input.avatarUrl)
    if (name !== undefined) data.name = name.replace(/\s+/g, ' ')
    if (mail !== undefined) data.email = mail
    if (photo !== undefined) data.avatar_url = photo
    if (input.locale !== undefined) {
      if (input.locale !== 'ar' && input.locale !== 'en') throw invalid('locale must be "ar" or "en"')
      data.locale = input.locale
    }
    return this.#build('member.updated', data)
  }

  /** An approved erasure request: Gurb erases the member's personal data and forgets the link. Irreversible. */
  memberDeleted(input: { sub: string; stateVersion: number; requestedAt?: Date }): PartnerEvent {
    const requestedAt = input.requestedAt ?? new Date()
    if (!(requestedAt instanceof Date) || Number.isNaN(requestedAt.getTime())) throw invalid('requestedAt must be a valid Date')
    return this.#build('member.deleted', { sub: sub(input.sub), state_version: version(input.stateVersion), requested_at: requestedAt.toISOString() })
  }

  /**
   * The nightly full list, split into pages of at most 500 (all sharing one
   * snapshot_id and generated_at). List EVERY member account — once all pages
   * arrive, Gurb blocks the members it knows who are missing from the list
   * (unless that would block more than 10%: then a Gurb admin decides).
   * Send every page; order does not matter.
   */
  snapshot(input: {
    members: readonly PartnerSnapshotMember[]
    snapshotId?: string
    generatedAt?: Date
    pageSize?: number
  }): PartnerEvent[] {
    const generatedAt = input.generatedAt ?? new Date()
    if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) throw invalid('generatedAt must be a valid Date')
    const age = Date.now() - generatedAt.getTime()
    if (age < -PARTNER_EVENT_LIMITS.snapshotMaxFutureMs || age > PARTNER_EVENT_LIMITS.snapshotMaxAgeMs) {
      throw invalid('generatedAt must be at most 5 minutes in the future and at most 72 hours old')
    }
    const pageSize = input.pageSize ?? PARTNER_EVENT_LIMITS.snapshotPageMaxMembers
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PARTNER_EVENT_LIMITS.snapshotPageMaxMembers) {
      throw invalid(`pageSize must be 1-${PARTNER_EVENT_LIMITS.snapshotPageMaxMembers}`)
    }
    const seen = new Set<string>()
    const lines = input.members.map((m, i) => {
      const line = { sub: sub(m.sub, `members[${i}].sub`), state_version: version(m.stateVersion, `members[${i}].stateVersion`), access: access(m.access) }
      // A member listed twice is a bug in the export; Gurb would keep one silently.
      if (seen.has(line.sub)) throw invalid(`members[${i}].sub "${line.sub}" is listed twice`)
      seen.add(line.sub)
      return line
    })
    const pages = Math.max(1, Math.ceil(lines.length / pageSize))
    if (pages > PARTNER_EVENT_LIMITS.snapshotMaxPages) throw invalid(`a snapshot may have at most ${PARTNER_EVENT_LIMITS.snapshotMaxPages} pages`)
    const id = snapshotId(input.snapshotId)
    const at = generatedAt.toISOString()
    return Array.from({ length: pages }, (_, p) =>
      this.#build('access.snapshot', {
        snapshot_id: id,
        generated_at: at,
        page: p + 1,
        pages,
        members: lines.slice(p * pageSize, (p + 1) * pageSize),
      })
    )
  }

  /** A connectivity and signature check ("Test connection"). Changes nothing. */
  ping(input: { message?: string } = {}): PartnerEvent {
    return this.#build('ping', { sub: null, state_version: 0, message: input.message ?? 'ping' })
  }

  /**
   * Deliver one built event. Never throws for an HTTP or network failure — the
   * result says what to do. Re-signed on every call (fresh timestamp); the id
   * and body are the stored ones, so Gurb applies a retried event once.
   */
  async send(event: PartnerEvent): Promise<PartnerSendResult> {
    if (!event || typeof event.id !== 'string' || typeof event.body !== 'string') {
      throw invalid('send() takes an event built by this client')
    }
    // The body names its community: refuse to send one built for another.
    let parsed: { id?: unknown; community?: unknown }
    try {
      parsed = JSON.parse(event.body) as { id?: unknown; community?: unknown }
    } catch {
      throw invalid('event.body is not the JSON this client built')
    }
    if (parsed.id !== event.id || parsed.community !== this.#communityId) {
      throw invalid('this event was built for a different community or has been altered')
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': event.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signPartnerEvent(this.#secrets, event.id, timestamp, event.body),
        },
        body: event.body,
        signal: controller.signal,
        redirect: 'manual', // the contract has no redirects; a 3xx is a misconfiguration, not a hop
      })
    } catch (error) {
      return { outcome: 'retry', status: 0, message: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }

    let json: { code?: unknown; message?: unknown; outcome?: unknown } = {}
    try {
      json = (await response.json()) as typeof json
    } catch {
      /* not JSON — keep the status */
    }
    const code = typeof json.code === 'string' ? json.code : undefined
    const message = typeof json.message === 'string' ? json.message : undefined
    const status = response.status
    if (status >= 200 && status < 300) {
      return { outcome: 'delivered', status, ...(typeof json.outcome === 'string' ? { applied: json.outcome } : {}) }
    }
    const outcome: PartnerSendOutcome = status === 408 || status === 429 || status >= 500 ? 'retry' : 'rejected'
    return { outcome, status, ...(code ? { code } : {}), ...(message ? { message } : {}) }
  }
}

export function createGurbPartnerEvents(options: PartnerEventsOptions): GurbPartnerEvents {
  return new GurbPartnerEvents(options)
}
