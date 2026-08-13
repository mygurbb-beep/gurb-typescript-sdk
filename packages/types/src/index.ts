/**
 * Shared types for the Gurb API surface exposed to SDK consumers.
 *
 * HAND-WRITTEN ON PURPOSE (v1). The backend's swagger-jsdoc spec covers admin
 * routes and is not served in production, so it is documentation rather than a
 * contract. When the backend emits a curated `openapi.public.json` artifact and
 * gates it in CI, this file is replaced wholesale by `openapi-typescript`
 * output. Keep it structural — no classes, no helpers — so that swap is a
 * deletion, not a migration.
 */

// ─── Primitives ──────────────────────────────────────────────────────────────

/** A community-scoped API key. Always `gurb_<keyId>_<secret>`. */
export type GurbApiKey = string

/**
 * The sections a host site may embed. One section per iframe by design: a
 * chrome-less pane composes into the host's layout, where a full app does not.
 */
export const EMBED_SECTIONS = ['tweets', 'events', 'blogs', 'albums'] as const
export type EmbedSection = (typeof EMBED_SECTIONS)[number]

export interface Paginated<T> {
  items: T[]
  page: number
  limit: number
  total: number
  hasMore: boolean
}

export interface PaginationParams {
  page?: number
  limit?: number
}

// ─── Resources ───────────────────────────────────────────────────────────────

export interface Community {
  id: string
  slug: string
  name: string
  description: string | null
  logoUrl: string | null
  bannerUrl: string | null
  /** Visibility is `type` alone. There is no `isPublic` field; derive it if you need a boolean. */
  type: 'PUBLIC' | 'PRIVATE'
  memberCount: number
  createdAt: string
}

export interface Author {
  /**
   * The platform-level user id.
   *
   * Note for anyone porting this to another language: several backend tables
   * store a `CommunityMember.id` in a column named `authorId`. This field is
   * always the `User.id` — the API normalises it before it crosses the wire.
   */
  userId: string
  displayName: string
  avatarUrl: string | null
}

export interface Tweet {
  id: string
  content: string
  author: Author
  imageUrls: string[]
  likeCount: number
  commentCount: number
  createdAt: string
  editedAt: string | null
}

export interface Event {
  id: string
  title: string
  description: string | null
  location: string | null
  coverUrl: string | null
  startsAt: string
  endsAt: string | null
  attendeeCount: number
}

export interface Blog {
  id: string
  title: string
  excerpt: string | null
  coverUrl: string | null
  author: Author
  publishedAt: string | null
  createdAt: string
}

export interface Album {
  id: string
  title: string
  description: string | null
  coverUrl: string | null
  photoCount: number
  createdAt: string
}

export interface Group {
  id: string
  name: string
  description: string | null
  coverUrl: string | null
  memberCount: number
  /** Published as a field rather than filtered out — an SDK caller acts for the
   *  community and may legitimately list its private groups. */
  isPrivate: boolean
  createdAt: string
}

/**
 * A consultancy LISTING, not a person.
 *
 * The underlying table models an offered service, which is why `title` has no
 * backing column and is always null today, and why `specialties` comes from a
 * relation rather than a field. Kept in the shape so the contract does not have
 * to change when a title column arrives.
 */
export interface Consultant {
  id: string
  displayName: string
  title: string | null
  bio: string | null
  avatarUrl: string | null
  specialties: string[]
  createdAt: string
}

export interface Project {
  id: string
  title: string
  description: string | null
  coverUrl: string | null
  status: string | null
  createdAt: string
}

/**
 * An award the community DEFINES — the medal, not the granting of it.
 *
 * `awardedAt` is therefore null: when a medal was given is a property of a
 * grant (`award_recipients`), not of the catalogue row. A future
 * `awards/:id/recipients` resource is where real timestamps belong.
 */
export interface Award {
  id: string
  title: string
  description: string | null
  imageUrl: string | null
  awardedAt: string | null
  createdAt: string
}

export interface Member {
  userId: string
  memberId: string
  displayName: string
  avatarUrl: string | null
  role: 'ADMIN' | 'MODERATOR' | 'MEMBER'
  joinedAt: string
}

// ─── Embed ───────────────────────────────────────────────────────────────────

/**
 * What the host's backend sends to mint an embed session.
 *
 * There is deliberately no `role` field. The host cannot elevate a user; every
 * embedded identity lands as a plain MEMBER. Adding a role field here would
 * make a leaked key a way to manufacture moderators.
 */
export interface CreateEmbedSessionInput {
  /**
   * The host's own id for this user. Opaque to Gurb, stable forever: it is the
   * join key, so reusing one for a different human hands them that account.
   */
  externalUserId: string
  displayName: string
  email?: string
  avatarUrl?: string
}

export interface EmbedSession {
  /**
   * Single-use, ~120s, `aud: "embed"`. Accepted by exactly one endpoint (the
   * exchange). Put it in a URL fragment, never a query string.
   */
  token: string
  expiresAt: string
  /** The Gurb user this external identity resolved to (created on first sight). */
  userId: string
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Stable, machine-readable error codes. Backend messages are English by
 * project convention; consumers own their own translation.
 */
export type GurbErrorCode =
  | 'INVALID_API_KEY'
  | 'API_KEY_REVOKED'
  | 'FORBIDDEN_SURFACE'
  | 'INSUFFICIENT_SCOPE'
  | 'FEATURE_NOT_AVAILABLE'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN'

export interface GurbErrorBody {
  success: false
  error?: string
  message?: string
  requestId?: string
}

// ═════════════════════════════════════════════════════════════════════════════
//  Administration, membership and permissions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A platform-level super-admin key. Always `gurb_sa_<keyId>_<secret>`.
 *
 * The `sa_` segment is not decoration. A community key damages one community;
 * this one can create communities, mint other keys, and act across tenants — so
 * it must be impossible to confuse the two by looking at them, by parsing them,
 * or by passing one where the other belongs. `GurbClient` rejects this shape and
 * `GurbAdminClient` rejects the community shape.
 */
export type GurbAdminKey = string

// ─── Roles and permissions ───────────────────────────────────────────────────

/**
 * A member's role inside one community.
 *
 * `SUPER_ADMIN` is deliberately absent: it is platform-level, it is not a
 * community membership, and no API call may ever grant it. Leaving it out of
 * the type means there is no way to ask for it.
 */
export type CommunityRole = 'ADMIN' | 'MODERATOR' | 'MEMBER'

/**
 * Permissions the SDK knows by name.
 *
 * The platform's catalogue is larger and grows over time. `Permission` below
 * stays assignable from any string on purpose: a new permission added to the
 * platform must not fail to compile here, and an SDK upgrade must not be a
 * prerequisite for using one. These constants exist for autocomplete and for
 * catching typos in the common cases, not as a closed set.
 */
export const KNOWN_PERMISSIONS = [
  // Content
  'CREATE_POST', 'EDIT_ANY_POST', 'DELETE_ANY_POST',
  'CREATE_EVENT', 'EDIT_ANY_EVENT', 'DELETE_ANY_EVENT',
  'CREATE_BLOG', 'EDIT_ANY_BLOG', 'DELETE_ANY_BLOG',
  'CREATE_ALBUM', 'EDIT_ANY_ALBUM', 'DELETE_ANY_ALBUM',
  'UPLOAD_MEDIA',
  // Membership
  'INVITE_MEMBERS', 'REMOVE_MEMBERS', 'APPROVE_JOIN_REQUESTS',
  'ASSIGN_ROLES', 'MANAGE_PERMISSIONS',
  // Moderation
  'MODERATE_CONTENT', 'RESTRICT_MEMBERS', 'VIEW_REPORTS',
  // Community
  'EDIT_COMMUNITY_SETTINGS', 'MANAGE_API_KEYS', 'VIEW_ANALYTICS',
] as const

export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number]

/** A known permission, or any newer one the platform has added since. */
export type Permission = KnownPermission | (string & {})

export interface MemberPermissions {
  memberId: string
  userId: string
  role: CommunityRole
  /** Everything in force: what the role grants, plus individual grants. */
  effective: Permission[]
  /** Granted to this member specifically, on top of the role. */
  granted: Permission[]
  /** Taken away from this member specifically, despite the role. */
  revoked: Permission[]
}

// ─── Community creation and approval ─────────────────────────────────────────

export type CommunityRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

export interface CreateCommunityInput {
  name: string
  slug: string
  description?: string
  type?: 'PUBLIC' | 'PRIVATE'
  /** The `User.id` who will own it. Defaults to the requester. */
  ownerUserId?: string
}

export interface CommunityRequest {
  id: string
  name: string
  slug: string
  description: string | null
  status: CommunityRequestStatus
  requestedByUserId: string
  /** Present once a decision has been made. */
  decidedByUserId: string | null
  decidedAt: string | null
  /** Why it was rejected. Always null while PENDING or once APPROVED. */
  rejectionReason: string | null
  /** The community this became. Null until approved. */
  communityId: string | null
  createdAt: string
}

// ─── API key management (super admin) ────────────────────────────────────────

export interface ApiKeySummary {
  id: string
  communityId: string
  name: string
  scopes: ('read' | 'write')[]
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

/**
 * The only response that ever carries a usable key.
 *
 * There is no read-back route: if it is lost, mint another and revoke this one.
 * Storing it anywhere retrievable would turn a database read into a full
 * community compromise.
 */
export interface ApiKeyWithSecret extends ApiKeySummary {
  /** Shown exactly once. */
  key: string
}

// ─── Bulk membership ─────────────────────────────────────────────────────────

export interface BulkMemberInput {
  /** Your own id for this person. Stable forever — it is the join key. */
  externalUserId: string
  displayName: string
  email?: string
  /**
   * Defaults to MEMBER. A key can never assign a role above its own authority,
   * and no key can assign a platform role.
   */
  role?: CommunityRole
}

export interface BulkFailure {
  /** Index in the array you sent, so you can map a failure back to its input. */
  index: number
  externalUserId: string
  code: GurbErrorCode
  message: string
}

/**
 * The result of a partially-successful batch.
 *
 * Bulk operations do not throw on individual failures: one bad email address in
 * a list of 500 must not discard the other 499. Check `failed` — an empty array
 * is the only proof that everything landed.
 */
export interface BulkMemberResult {
  created: Member[]
  updated: Member[]
  failed: BulkFailure[]
  total: number
}

/** The most members one call may carry. Larger lists must be chunked. */
export const BULK_MEMBER_LIMIT = 500
