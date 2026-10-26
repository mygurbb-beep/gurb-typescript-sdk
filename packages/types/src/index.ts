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
 * What a host site may embed: the whole community, or one section of it.
 *
 * `'community'` is the community page ITSELF in a frame — navigation, every
 * section the plan enables, and the member's own view of it. They land where a
 * normal sign-in would put them and move around inside the frame. Reach for it
 * when the frame IS the page, such as a "Community" tab in your app.
 *
 * The others are chrome-less panes meant to compose into your own layout: your
 * header, your navigation, one Gurb panel among your own content. They have no
 * menu and cannot navigate anywhere.
 *
 * The trade is real. A whole community brings its own scroll height (so
 * `autoResize` matters far more), its own internal routing — your back button
 * will not follow it — and links that may try to leave the frame. A section
 * brings none of that.
 */
export const EMBED_SECTIONS = ['community', 'tweets', 'events', 'blogs', 'albums'] as const
export type EmbedSection = (typeof EMBED_SECTIONS)[number]

/** True for the whole-community frame rather than a single chrome-less pane. */
export function isWholeCommunity(section: EmbedSection): boolean {
  return section === 'community'
}

/**
 * A starting height that is not immediately wrong, before the frame reports its
 * own.
 *
 * A whole community needs far more room than one pane: at 600px a member sees a
 * navigation bar and little else, and judges the integration broken in the
 * second before auto-resize lands. An explicit `initialHeight` still wins —
 * this only decides what "unspecified" means.
 */
export function defaultEmbedHeight(section: EmbedSection): number {
  return isWholeCommunity(section) ? 900 : 600
}

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
  /**
   * Present only on the response to a CREATE that carried an `owner`.
   *
   * The three outcomes are operationally different and you cannot tell them
   * apart from the outside, so branch on this rather than assuming:
   *
   *   CREATED — a brand-new, passwordless Gurb account now exists. Its owner has
   *             no way to sign in yet; send them through your provider, or have
   *             them use Gurb's password-reset flow.
   *   LINKED  — an account that ALREADY had a history is now reachable through
   *             your provider. Gurb has e-mailed its owner to tell them so. If
   *             you did not expect this, you asserted an address that belonged
   *             to somebody who was already here.
   *   MATCHED — the identity was already bound. Nothing changed.
   */
  owner?: {
    userId: string
    outcome: 'CALLER' | 'MATCHED' | 'CREATED' | 'LINKED'
  }
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

// ═════════════════════════════════════════════════════════════════════════════
//  Publishing content
// ═════════════════════════════════════════════════════════════════════════════

/**
 * WHAT PUBLISHING REQUIRES, AND WHY IT IS NOT UNIFORM
 *
 * Every write below is guarded by the SAME permission Gurb's own web app checks
 * for that action — not a stricter one and not a looser one. That parity is
 * deliberate: a community admin who grants `blogs:create` in the dashboard
 * expects it to mean the same thing through an integration, and any divergence
 * would make the dashboard's permission screen a lie.
 *
 * The practical consequence is that the requirements are NOT the same across
 * sections, and cannot be made so:
 *
 *   tweets  → posts:manage | posts:create
 *   events  → calendar:manage | calendar:create
 *   blogs   → blogs:manage | blogs:create
 *   albums  → albums:manage | albums:create
 *
 * A plain member holds NONE of these — `MEMBER` resolves to an empty permission
 * set in Gurb, and posting is a capability an admin grants. So a key whose owner
 * was never granted anything can read everything and publish nothing. That is
 * correct behaviour, not a misconfiguration.
 *
 * UPDATE AND DELETE ARE "OR OWNER"
 *
 * The author of a post may edit it without holding any moderation permission.
 * On this surface the author is the KEY'S OWNER, so a key can always edit what
 * it published, and needs `*:manage` or `*:moderate` to touch anyone else's.
 * Expect 403s when integrating against content your key did not create.
 *
 * FILE UPLOADS ARE NOT SUPPORTED YET
 *
 * These endpoints are text and JSON only. An album is created empty; a tweet
 * carries no attachment; a blog has no header image. Uploads need storage-budget
 * accounting that this surface does not implement yet, and shipping them without
 * it would let a community silently exceed the storage its plan pays for.
 */

export interface CreateTweetInput {
  content: string
  /** Post into a group instead of the home feed. Checked against that group's own rules. */
  groupId?: string
  allowComments?: boolean
}

export interface UpdateTweetInput {
  content?: string
  allowComments?: boolean
}

/** `DRAFT` fires no webhook and sends no notification — by design, upstream. */
export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'COMPLETED'

export interface CreateEventInput {
  title: string
  /** Required. Community-internal pages are Arabic-only by design. */
  titleArabic: string
  description?: string
  status?: EventStatus
  /** ISO 8601. Sent as a string; the server parses it. */
  startDate: string
  endDate: string
  location?: string
  isOnline?: boolean
  meetingUrl?: string
  registrationUrl?: string
  timezone?: string
  capacity?: number
  allowComments?: boolean
  tags?: string[]
}

export type UpdateEventInput = Partial<CreateEventInput>

// ─── Event reminders (1.9.0) ─────────────────────────────────────────────────

/**
 * Where a manual event reminder goes: `inApp` = the bell inside Gurb, `push` = the
 * attendees' phones (FCM), `email` = the event e-mail in the community's brand.
 */
export type ReminderChannel = 'email' | 'push' | 'inApp'

export interface SendEventReminderInput {
  /** One, several or all three. Order does not matter; duplicates collapse. */
  channels: ReminderChannel[]
}

export interface EventReminderResult {
  /** Attendees addressed: PAID ticket holders of a paid event, or members «going» to a free one — never the key's user. */
  recipients: number
  channels: ReminderChannel[]
  /** Bell notifications stored (0 without `inApp`). */
  inApp: number
  /** Attendees whose push was handed to FCM (0 without `push`). */
  push: number
  /** E-mails QUEUED — they go out in the background, a few per second. Not a delivery count. */
  emailQueued: number
}

// ─── Content invitations (1.9.0) ─────────────────────────────────────────────

/** The sections an invitation can point at. */
export type ContentInviteType = 'blog' | 'album' | 'event'

export interface CreateContentInvitationsInput {
  resourceType: ContentInviteType
  resourceId: string
  /** User ids (not member ids). 1–20 per call. */
  inviteeIds: string[]
  /** Up to 300 characters, shown with the invitation. */
  message?: string
}

/**
 * Why one invitee was not invited. `UNAVAILABLE` covers «not a member», «hidden from the
 * caller's member directory» and «cannot open the item» on purpose — one reason, so ids cannot
 * be probed for membership.
 */
export type ContentInviteSkipReason = 'SELF' | 'ALREADY_INVITED' | 'UNAVAILABLE'

export interface ContentInvitationsResult {
  invited: string[]
  skipped: Array<{ userId: string; reason: ContentInviteSkipReason }>
}

export interface CreateBlogInput {
  title: string
  /** Rendered HTML. The platform stores it as sent. */
  contentHtml: string
  /** `DRAFT` publishes nothing and announces nothing. */
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
  allowComments?: boolean
}

export type UpdateBlogInput = Partial<CreateBlogInput>

/** An album is created EMPTY — image upload is not supported on this surface yet. */
export interface CreateAlbumInput {
  title: string
  description?: string
}

export interface UpdateAlbumInput {
  title?: string
  description?: string
  allowComments?: boolean
}

// ═════════════════════════════════════════════════════════════════════════════
//  Groups, consultants, projects, awards, tasks, interactions, customization
// ═════════════════════════════════════════════════════════════════════════════

/**
 * PERMISSIONS ON EVERYTHING BELOW: READ THIS ONCE, THEN THE PER-TYPE DOCBLOCKS.
 *
 * Every endpoint in this half of the SDK is guarded by the SAME permission
 * Gurb's own web app checks for that action — read off the internal route file,
 * whole middleware chain, not grepped for. That parity is the point: an admin
 * who grants `groups:create` in the dashboard expects it to mean the same thing
 * through an integration, and any divergence turns the dashboard's permission
 * screen into a lie.
 *
 * THE REQUIREMENTS DIFFER PER SECTION AND CANNOT BE UNIFIED. The SDK mirrors
 * Gurb exactly rather than inventing one house rule:
 *
 *   groups        create `groups:manage | groups:create`
 *                 update `groups:manage | groups:create | groups:moderate`, OR OWNER
 *                 delete `groups:manage | groups:moderate` — NO owner branch
 *   consultants   `consultants:manage` on all three. It is the only consultant
 *                 permission that exists; there is no create/moderate split.
 *   projects      create `projects:manage | projects:create | projects:moderate`
 *                 update the same three plus `projects:edit`, OR OWNER
 *                 delete `projects:manage | projects:moderate | projects:edit`, OR OWNER
 *   projects2     identical shape with the `projects2:*` names
 *   awards        `awards:manage` on all three, no owner branch
 *   tasks         reads: none. writes: `tasks:manage`, no owner branch
 *   comments      NONE. likes NONE.
 *   settings/branding/legal   read none; write `settings:manage | homepage:customize`
 *   sidebar       read none; write `homepage:customize | settings:manage`
 *   advertisements  `/active` read none; admin list and writes
 *                 `ads:manage | homepage:customize`
 *
 * A PLAIN MEMBER HOLDS NONE OF THESE. `MEMBER` resolves to an EMPTY permission
 * set in Gurb — writing is a capability an admin grants, not one membership
 * confers. So a key whose owner was granted nothing reads everything and
 * publishes nothing. That is correct behaviour, not a misconfiguration, and no
 * amount of re-minting the key changes it.
 *
 * UPDATE AND DELETE: AUTHORSHIP IS CHECKED FIRST. Where a section is marked
 * "OR OWNER", the guard asks "did this row's creator make it?" before it asks
 * about permissions, and on this surface the creator is the KEY'S OWNER. So a
 * key can always edit what it created, and needs `*:manage` / `*:moderate` (or
 * `*:edit`) for anybody else's. Expect 403s against content your key did not
 * create. The sections with no owner branch — consultants, awards, tasks, and
 * group DELETE — genuinely have none upstream; that asymmetry is real and is
 * mirrored rather than smoothed out.
 *
 * COMMENTS AND LIKES REQUIRE NO PERMISSION AT ALL. They are what an ordinary
 * member does, and MEMBERSHIP is the gate — the exact opposite of posting a
 * tweet. Editing a comment is author-only inside a 15-minute window with no
 * permission escape hatch; deleting is the author inside 30 minutes, or a
 * community ADMIN/MODERATOR with no window.
 *
 * FEATURE GATES ARE AN ENTITLEMENT, NOT A PERMISSION. Where a section is marked
 * feature-gated, a community whose PLAN lacks the flag gets
 * `403 FEATURE_NOT_AVAILABLE` on EVERY call in that section INCLUDING READS. No
 * grant fixes it — it is a billing question, not an admin one. The gate runs
 * before the permission guard, so the refusal names the right remedy.
 */

/** What a delete answers with. The id is the one you addressed. */
export interface DeletedResult {
  id: string
  deleted: true
}

// ─── Groups ──────────────────────────────────────────────────────────────────

/**
 * Requires `groups:manage` or `groups:create`, and the `groups` feature on the
 * plan (403 FEATURE_NOT_AVAILABLE otherwise, reads included).
 *
 * `iconUrl` is REQUIRED and must be an http(s) URL. Gurb's own route takes an
 * uploaded icon file and refuses a group without one; this surface has no
 * multipart parser, so the URL occupies the same argument the uploaded file's
 * URL would.
 */
export interface CreateGroupInput {
  name: string
  /** Defaults to `name`. The column is NOT NULL and Gurb's UI is Arabic-first. */
  nameArabic?: string
  description: string
  /** Defaults to `description`, same reason as `nameArabic`. */
  descriptionArabic?: string
  /**
   * Required, deliberately. Defaulting a VISIBILITY field is how a private
   * group gets published by accident.
   */
  isPrivate: boolean
  /** The member CAP. `-1` is unlimited and is the default; otherwise positive. */
  memberLimit?: number
  /** Defaults to true. */
  canChat?: boolean
  email?: string
  website?: string
  /** Required http(s) URL — see above. */
  iconUrl: string
  coverUrl?: string
}

/**
 * Requires `groups:manage`, `groups:create` or `groups:moderate` — OR the key
 * owner created the group. Feature-gated on `groups`.
 *
 * IMAGES CANNOT BE CLEARED. The internal update applies an icon or cover only
 * when a truthy value arrives, so `null` would answer 200 and change nothing;
 * it is refused instead of silently dropped. Same for `email` and `website`.
 */
export interface UpdateGroupInput {
  name?: string
  nameArabic?: string
  description?: string
  descriptionArabic?: string
  isPrivate?: boolean
  memberLimit?: number
  canChat?: boolean
  email?: string
  website?: string
  iconUrl?: string
  coverUrl?: string
}

/**
 * A group as a write returns it.
 *
 * `memberCount` IS THE ROSTER SIZE, matching `groups.list`. The CAP is
 * `memberLimit`, which is also the name the write contract accepts. Internally
 * one field called `memberCount` means both, at different layers; publishing
 * that confusion would give one name two meanings on one surface.
 */
export interface GroupWriteResult {
  id: string
  name: string
  description: string | null
  coverUrl: string | null
  iconUrl: string | null
  /** Roster size. A brand-new group has 1 — its creator, added as ADMIN. */
  memberCount: number
  /** The cap. `-1` means unlimited. */
  memberLimit: number
  isPrivate: boolean
  canChat: boolean
  createdAt: string | null
}

// ─── Consultants ─────────────────────────────────────────────────────────────

export const CONSULTANT_STATUSES = [
  'available',
  'coming_soon',
  'not_available',
  'fully_booked',
] as const
export type ConsultantStatus = (typeof CONSULTANT_STATUSES)[number]

/**
 * Requires `consultants:manage` — the only consultant permission that exists,
 * on all three verbs, with no owner branch anywhere. Feature-gated on
 * `consultants`.
 *
 * `bookingUrl` is required: the column is NOT NULL and the service refuses an
 * empty one.
 *
 * CONSULTANT TYPES (the specialty vocabulary) are not created here. `typeIds`
 * ATTACHES types that already exist; there is no `newTypes`, because creating
 * taxonomy rows as a side effect of writing a consultant is how a vocabulary
 * fills up with near-duplicates.
 */
export interface CreateConsultantInput {
  displayName: string
  bio?: string
  bookingUrl: string
  /** Two decimal places; the column maxes out at 99999999.99. */
  price?: number
  avatarUrl?: string
  bannerUrl?: string
  /** Defaults to `available` — a consultant has no draft state. */
  status?: ConsultantStatus
  typeIds?: string[]
}

/**
 * Requires `consultants:manage`. Feature-gated on `consultants`.
 *
 * Unlike groups, images here CAN be cleared: `null` reaches the column.
 *
 * `typeIds` REPLACES the type set wholesale — it is not a merge — so `[]`
 * removes every specialty. "Add a specialty" and "set the specialties" look
 * identical in a request body; this is the latter.
 */
export interface UpdateConsultantInput {
  displayName?: string
  bio?: string | null
  bookingUrl?: string
  /** `null` clears the price. */
  price?: number | null
  /** `null` clears the image. */
  avatarUrl?: string | null
  /** `null` clears the image. */
  bannerUrl?: string | null
  status?: ConsultantStatus
  isActive?: boolean
  typeIds?: string[]
}

/** A consultancy listing as a write returns it. `title` has no backing column and is always null. */
export interface ConsultantWriteResult {
  id: string
  displayName: string
  title: null
  bio: string | null
  avatarUrl: string | null
  bannerUrl: string | null
  bookingUrl: string | null
  price: number | null
  status: string | null
  isActive: boolean
  specialties: string[]
  createdAt: string | null
}

// ─── Projects and Projects-2 ─────────────────────────────────────────────────

export const PROJECT_STATUSES = [
  'PLANNING',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export interface ProjectProductInput {
  name: string
  /** Defaults to `name`. */
  nameArabic?: string
  price?: number
  link?: string
}

/**
 * Requires `projects:manage`, `projects:create` or `projects:moderate` — and
 * the `projects` feature on the plan. The same shape with `projects2:*` names
 * and the `projects2` feature applies to `projects2`.
 *
 * PROJECTS-2 CARRIES A SECOND GATE that `projects` does not: a per-community
 * page-visibility opt-in, refusing with `FEATURE_DISABLED` ("your admin turned
 * this off") as opposed to `FEATURE_NOT_AVAILABLE` ("your plan does not include
 * it"). They send you to different people; do not collapse them.
 *
 * THE FIELD IS `name` HERE AND `title` IN THE RESPONSE. That asymmetry is
 * Gurb's — the column is `name`, every SDK read publishes `title` — and is
 * mirrored rather than normalised.
 *
 * NO `status` DEFAULT. Absent means NULL, and "no status yet" is a real state a
 * project can be in; defaulting to `PLANNING` would invent a fact.
 *
 * Created with no logo and no banner: `coverUrl` comes back null, and there is
 * no endpoint on this surface to set it.
 */
export interface CreateProjectInput {
  name: string
  /** Defaults to `name`. */
  nameArabic?: string
  /** Required — the column is NOT NULL. */
  description: string
  status?: ProjectStatus
  /** ISO 8601. */
  startDate?: string
  /** ISO 8601. Must be on or after `startDate`. */
  endDate?: string
  initialPrice?: number
  /** Must be greater than or equal to `initialPrice`. */
  finalPrice?: number
  marketValue?: number
  currentAmount?: number
  projectLink?: string
  products?: ProjectProductInput[]
}

/**
 * Requires `projects:manage | projects:create | projects:moderate |
 * projects:edit` — OR the key owner created the project. Feature-gated, and
 * `projects2` additionally page-visibility gated.
 *
 * `null` clears the nullable columns. The three prices are NOT among them: a
 * null there is ignored rather than written, so they are typed without it.
 */
export interface UpdateProjectInput {
  name?: string
  nameArabic?: string
  description?: string
  /** `null` genuinely removes the project's status. */
  status?: ProjectStatus | null
  startDate?: string | null
  endDate?: string | null
  initialPrice?: number
  finalPrice?: number
  marketValue?: number
  currentAmount?: number
  projectLink?: string | null
  products?: ProjectProductInput[]
}

// ─── Awards ──────────────────────────────────────────────────────────────────

/**
 * Requires `awards:manage` — one permission on all three verbs, no owner
 * branch. Feature-gated on `awards`.
 *
 * `awards:moderate` exists in this module but only covers hide/unhide, which
 * are not on this surface. Do not expect it to work here.
 *
 * THIS DEFINES A MEDAL; IT DOES NOT AWARD ONE. Granting is a different
 * operation against `award_recipients` and is not published here.
 *
 * `icon` IS A PRESET KEY, e.g. `"trophy"`, not a URL — there are no uploads on
 * this surface, and the preset key is the only half a caller can honestly
 * supply. Clients reading `imageUrl` back must be ready for a non-URL value.
 */
export interface CreateAwardInput {
  /** Max 120 characters. */
  name: string
  /** Defaults to `name`. Max 120. */
  nameArabic?: string
  /** Max 300. */
  description?: string
  descriptionArabic?: string
  /** Max 300. */
  criteria?: string
  criteriaArabic?: string
  /** A preset icon key — see above. Required. */
  icon: string
  /** Required. Hex, e.g. `#093431`. */
  color: string
  rarityId?: string
  categoryId?: string
  /**
   * Grants this award to every FUTURE joiner, automatically. Never
   * retroactive — flipping it touches nobody who is already a member.
   */
  autoAwardNewMembers?: boolean
}

/**
 * Requires `awards:manage`. Feature-gated on `awards`.
 *
 * `rarityId: null` / `categoryId: null` detach the award from its tier or
 * category. An ABSENT key is left alone, so a partial update never silently
 * uncategorises an award.
 */
export interface UpdateAwardInput {
  name?: string
  nameArabic?: string
  description?: string | null
  descriptionArabic?: string | null
  criteria?: string | null
  criteriaArabic?: string | null
  icon?: string
  color?: string
  rarityId?: string | null
  categoryId?: string | null
  autoAwardNewMembers?: boolean
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/** Who created a task. `null` when that account no longer exists. */
export interface TaskCreator {
  /** A `User.id`. */
  userId: string
  displayName: string
  avatarUrl: string | null
}

export interface Task {
  id: string
  headingId: string
  title: string
  shortDescription: string | null
  description: string | null
  status: TaskStatus | null
  priority: TaskPriority | null
  points: number
  estimatedMinutes: number | null
  tags: string[]
  dueAt: string | null
  completedAt: string | null
  /** `false` hides the task from `tasks.list` while leaving it addressable by id. */
  isActive: boolean
  autoAssignNewMembers: boolean
  /** A COUNT, never a list. */
  assignmentCount: number
  createdBy: TaskCreator | null
  createdAt: string | null
  updatedAt: string | null
}

/** A prerequisite or a dependent, flattened to the ids a client can act on. */
export interface TaskLink {
  taskId: string
  title: string
  status: TaskStatus | null
  priority: TaskPriority | null
}

/** What `tasks.get` adds over a list row — the section is one join above a task. */
export interface TaskDetail extends Task {
  sectionId: string | null
  sectionName: string | null
  headingName: string | null
  /** Tasks this one waits for. */
  dependsOn: TaskLink[]
  /** Tasks waiting for this one. */
  blocking: TaskLink[]
  activityCount: number
}

/**
 * Reading the board needs NO permission — any approved member may. Writing
 * needs `tasks:manage`.
 *
 * The whole section is feature-gated on `tasks`, READS INCLUDED: a community
 * without the flag gets 403 FEATURE_NOT_AVAILABLE from `list` as well.
 */
export interface TaskListParams extends PaginationParams {
  /** One value or several. Several are sent comma-separated, which the API accepts. */
  status?: TaskStatus | TaskStatus[]
  priority?: TaskPriority | TaskPriority[]
  /** A `User.id`. Named for its kind because the same column holds Group ids for GROUP rows. */
  assigneeUserId?: string
  headingId?: string
  sectionId?: string
  /** ISO 8601. */
  dueBefore?: string
  /** ISO 8601. */
  dueAfter?: string
  search?: string
}

/**
 * Requires `tasks:manage`. There is no owner branch — a task's creator cannot
 * edit it without that permission, which is Gurb's own rule. Feature-gated on
 * `tasks`.
 *
 * `headingId` IS REQUIRED AND CANNOT BE DEFAULTED. Tasks live three levels
 * deep — section → heading → task — and there is no inbox to fall back on.
 *
 * THE HEADING IS ALSO WHERE ASSIGNMENT COMES FROM: every assignee the chosen
 * heading and its section carry is copied onto the new task. Choosing a
 * `headingId` is not filing, it decides who is asked to do the work.
 *
 * `status` is NOT accepted here — a new task is always `PENDING`. Move it with
 * an update immediately after if you need one that starts in progress.
 */
export interface CreateTaskInput {
  headingId: string
  /** Max 40 characters. Surprisingly short, and not a typo. */
  title: string
  /** Max 150. */
  shortDescription?: string
  /** Max 400. */
  description?: string
  /** ISO 8601. */
  dueAt?: string
  /** Defaults to `MEDIUM`. */
  priority?: TaskPriority
  /** A non-negative integer — it feeds the member leaderboard. */
  points?: number
  estimatedMinutes?: number
  tags?: string[]
  /** Future joiners only; suppressed inside a SPECIFIC_MEMBERS section. */
  autoAssignNewMembers?: boolean
}

/**
 * Requires `tasks:manage`. Feature-gated on `tasks`.
 *
 * `status: 'COMPLETED'` stamps `completedAt` and fires `task.completed` — but
 * only on the TRANSITION. Re-sending COMPLETED on an already-completed task is
 * a plain `task.updated`; moving away from it is `task.reopened`. Exactly one
 * event leaves per call, so state mirroring can rely on it.
 *
 * `isActive: false` is the product's HIDE, not a delete: the task drops out of
 * `list` and stays addressable by id. No `task.deleted` fires.
 */
export interface UpdateTaskInput {
  title?: string
  /** `null` clears it. */
  shortDescription?: string | null
  description?: string
  /** ISO 8601, or `null` to clear. */
  dueAt?: string | null
  priority?: TaskPriority
  status?: TaskStatus
  points?: number
  estimatedMinutes?: number
  tags?: string[]
  isActive?: boolean
  autoAssignNewMembers?: boolean
}

// ─── Comments and likes ──────────────────────────────────────────────────────

/**
 * What a comment can hang off.
 *
 * Four, and not more: tasks and the legacy `post` table are deliberately not
 * comment parents on this surface.
 */
export const COMMENT_PARENTS = ['tweets', 'blogs', 'albums', 'events'] as const
export type CommentParent = (typeof COMMENT_PARENTS)[number]

/**
 * What can be liked directly.
 *
 * EVENTS ARE ABSENT ON PURPOSE. Gurb has no event-like route at all — the
 * internal service throws "not yet implemented" — so publishing one would be a
 * contract promising something the platform does not do. Event COMMENTS, and
 * likes on those comments, do work.
 */
export const LIKEABLE_PARENTS = ['tweets', 'blogs', 'albums'] as const
export type LikeableParent = (typeof LIKEABLE_PARENTS)[number]

export interface CommentAuthor {
  /** The platform `User.id`. */
  userId: string | null
  /** The `CommunityMember.id` the comment row actually stores. Both are published, named for what they are. */
  memberId: string | null
  displayName: string
  avatarUrl: string | null
  /** They left or were removed. Their words remain theirs — render "عضو سابق", not their absence. */
  isFormerMember: boolean
}

export interface Comment {
  id: string
  content: string
  author: CommentAuthor
  parentCommentId: string | null
  attachmentUrls: string[]
  likeCount: number
  likedByMe: boolean
  isEdited: boolean
  editedAt: string | null
  createdAt: string | null
  /** Replies nest to unlimited depth, as the platform stores them. */
  replies: Comment[]
}

/**
 * NO PERMISSION IS REQUIRED TO COMMENT. Membership is the gate, and the key
 * proves live approved membership on every request. This is the exact opposite
 * of posting a tweet, which needs a granted capability.
 *
 * The parent's own feature gate still applies: blogs, albums and events are
 * plan-gated, tweets are not.
 *
 * A REPLY IS THE SAME ENDPOINT with `parentCommentId` set. Gurb splits them
 * because a multipart form cannot nest; JSON can, so there is one call here.
 * `null` is refused rather than treated as top-level — a caller sending it has
 * almost certainly failed to resolve a variable, and silently posting their
 * reply as a new thread is worse than an error.
 */
export interface CreateCommentInput {
  /** 1–800 characters after trimming. */
  content: string
  /** Must be a comment on the SAME parent. Omit for a top-level comment. */
  parentCommentId?: string
}

/**
 * Editing is AUTHOR-ONLY, inside 15 minutes, with no permission that overrides
 * it — not for an admin, not for a moderator, on either surface. A moderator
 * who needs a comment gone deletes it; nobody edits another member's words.
 *
 * Deleting is the author inside 30 minutes, or a community ADMIN/MODERATOR with
 * no window. It cascades to that comment's replies.
 */
export interface UpdateCommentInput {
  /** 1–800 characters after trimming. */
  content: string
}

/**
 * The state of one like, however it was reached.
 *
 * NO PERMISSION IS REQUIRED TO LIKE — membership is the gate. Tweet likes
 * additionally run Gurb's restriction check, so a key whose owner is currently
 * restricted is refused there and only there. Likes are rate limited.
 */
export interface LikeState {
  liked: boolean
  likeCount: number
}

// ─── Community customization ─────────────────────────────────────────────────

/**
 * The community's settings blob, as published.
 *
 * `pageVisibility.home` is always `true` — the platform forces it on every
 * write, whatever was sent.
 */
export interface CommunitySettings {
  branding: {
    primaryColor: string | null
    secondaryColor: string | null
    isExplorable: boolean
  }
  /** Menu id → visible. Every key defaults to `true`. */
  pageVisibility: Record<string, boolean>
  homeWidgets: unknown
  advertisements: unknown
  /** Absent upstream means enabled, so this is `true` unless explicitly turned off. */
  directMessagesEnabled: boolean
  backButton: unknown
  widgetConfig: unknown
  guestAccess: unknown
  sidebarCustomization: unknown
}

/**
 * Requires `settings:manage` or `homepage:customize`. Reading needs nothing —
 * the internal read is a genuinely public endpoint, because a guest must know
 * which sections to render before logging in. No feature gate.
 *
 * SEND ONLY THE KEYS YOU MEAN. Every key present REPLACES its stored
 * counterpart wholesale, except `pageVisibility`, which is deep-merged key by
 * key. Round-tripping a whole settings object you read earlier is how a
 * community's widget layout gets silently wiped.
 *
 * `termsText` / `privacyPolicyText` are NOT here — use the legal endpoint,
 * which is where the "empty string restores the standard template" rule lives.
 * `featureOverrides` is refused: it holds plan-flag overrides, and a community
 * key writing it would be granting itself entitlements it has not paid for.
 * Any key not on this type is refused rather than dropped, so a misspelling is
 * an error and not a silent no-op.
 */
export interface UpdateCommunitySettingsInput {
  /** Menu id → visible. A patch of one key leaves every other entry alone. */
  pageVisibility?: Record<string, boolean>
  homeWidgets?: Record<string, unknown>
  advertisements?: Record<string, unknown>
  directMessagesEnabled?: boolean
  backButton?: Record<string, unknown>
  widgetConfig?: Record<string, unknown>
  guestAccess?: Record<string, unknown>
}

/**
 * Requires `settings:manage` or `homepage:customize`. No feature gate.
 *
 * `type` FLIPS MORE THAN A FLAG. PUBLIC → PRIVATE resets the guest-preview
 * opt-in on every row of every section, in the same transaction, and flipping
 * back does NOT restore them — an admin re-picks each one. It is on the
 * contract because Gurb exposes it under exactly the same permission, and a
 * "safer" divergence is still a divergence.
 *
 * There is no `isPublic`, in either direction. `type` is the single source of
 * truth for visibility.
 *
 * `logoUrl` / `bannerUrl` are REFUSED rather than ignored: upstream reads them
 * only from an uploaded file, so accepting a URL would return 200 and change
 * nothing — the worst possible answer.
 */
export interface UpdateCommunityBrandingInput {
  name?: string
  nameArabic?: string
  description?: string
  descriptionArabic?: string
  /** Read the cascade note above before sending this. */
  type?: 'PUBLIC' | 'PRIVATE'
  primaryColor?: string
  secondaryColor?: string
  category?: string
  country?: string
  city?: string
}

/** The community record as a branding write returns it. No `isPublic`. */
export interface CommunityRecord {
  id: string
  slug: string
  name: string
  nameArabic: string | null
  description: string | null
  descriptionArabic: string | null
  type: string
  primaryColor: string | null
  secondaryColor: string | null
  category: string | null
  country: string | null
  city: string | null
  logoUrl: string | null
  bannerUrl: string | null
  updatedAt: string | null
}

/** THIS COMMUNITY's terms and privacy policy — not the platform's legal pages. */
export interface CommunityLegal {
  terms: string
  privacyPolicy: string
  /** True when the text shown is the platform's standard template, not the community's own. */
  isDefaultTerms: boolean
  isDefaultPrivacyPolicy: boolean
  termsVersion: string
  privacyVersion: string
  language: string
  updatedAt: string | null
}

/**
 * Requires `settings:manage` or `homepage:customize`. Reading needs nothing,
 * deliberately, for PRIVATE communities too: a prospective member must be able
 * to read the rules before agreeing to them. No feature gate.
 *
 * `""` IS A MEANINGFUL VALUE — it restores the platform's standard template for
 * that field. An ABSENT field is left alone. Conflating the two produces one of
 * two real bugs: a deliberate reset ignored, or an unrelated save wiping a
 * founder's custom terms.
 *
 * `language` alone is not accepted: it only changes which template a blank
 * field resolves to, which is invisible unless a field is also being cleared.
 */
export interface UpdateCommunityLegalInput {
  /** `""` restores the standard template. */
  terms?: string
  /** `""` restores the standard template. */
  privacyPolicy?: string
  language?: 'ar' | 'en'
}

export interface SidebarConfig {
  enabled: boolean
  /** Menu items, passed through as the platform stores them. */
  items: unknown[]
  lastModified: string | null
  /** A `User.id`. */
  modifiedByUserId: string | null
}

/**
 * Requires `homepage:customize` or `settings:manage`, and the
 * `homepage_widgets` feature — ON THE READS TOO. Gurb gates this whole module
 * at router level; mirroring only the write gate would re-open a hole that was
 * closed on purpose.
 *
 * THIS IS A PUT, NOT A PATCH, and the verb is honest: sending `items` REPLACES
 * the whole array. Omitting it keeps the stored one. Calling it PATCH would
 * suggest a per-item merge that does not exist.
 *
 * `items` is passed through unvalidated — the platform renames legacy menu ids,
 * validates and sanitises labels, and a pre-check here would reject ids it
 * deliberately accepts.
 */
export interface UpdateSidebarInput {
  enabled?: boolean
  /** Replaces the whole menu. */
  items?: unknown[]
}

export const AD_POSITIONS = ['RIGHT_SIDEBAR', 'LEFT_SIDEBAR', 'ABOVE_TWEET_CREATOR'] as const
export type AdPosition = (typeof AD_POSITIONS)[number]

export interface Advertisement {
  id: string
  title: string
  imageUrl: string | null
  linkUrl: string | null
  position: string
  isActive: boolean
  isGuestVisible: boolean
  clickCount: number
  impressionCount: number
  startsAt: string | null
  endsAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Requires `ads:manage` or `homepage:customize`, and the `ads_management`
 * feature — WHICH ALSO GATES THE MEMBER-FACING `listActive`. A community whose
 * plan lacks the flag gets 403 on its own ad widget. That combination has
 * already been misdiagnosed in production as a missing permission; it is an
 * entitlement, and only a plan change fixes it.
 *
 * THERE IS NO CREATE. An advertisement needs an uploaded image and this surface
 * has no uploads; an external `imageUrl` is not a substitute, because the web
 * app resolves ad images by S3 prefix and was never taught to render a foreign
 * URL. Create ads in the dashboard, manage their schedule and targeting here.
 *
 * `imageUrl` is therefore REFUSED here rather than accepted-and-discarded.
 */
export interface UpdateAdvertisementInput {
  title?: string
  /** `null` or `""` clears the link. */
  linkUrl?: string | null
  position?: AdPosition
  isActive?: boolean
  /** ISO 8601, or `null` to clear. */
  startDate?: string | null
  /** ISO 8601, or `null` to clear. */
  endDate?: string | null
  /** Rejected by the platform for a PRIVATE community — that is a real product rule, not a bug. */
  isGuestVisible?: boolean
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
  // Partner Sign-In (1.8.0) — refusals of an embed session / member import in a
  // community that admits members only through its host site.
  /** The community admits members only through its host site, and this key is not the host's. */
  | 'JOIN_THROUGH_HOST_ONLY'
  /** The host blocked this member (an access event or the nightly snapshot): show "membership inactive". */
  | 'HOST_MEMBER_BLOCKED'
  /** The member was removed or banned in this community. */
  | 'MEMBER_NOT_ACTIVE'
  /** The Gurb account behind this member is deactivated or expired. */
  | 'ACCOUNT_NOT_USABLE'
  /** A competing request claimed the same identity at the same moment — retry once. */
  | 'EXTERNAL_IDENTITY_MANUAL_LINK_REQUIRED'
  /** The identity in the request cannot be acted on (bad externalUserId / email). */
  | 'EXTERNAL_IDENTITY_INVALID_INPUT'
  // Event reminders + content invitations (1.9.0). None of these is helped by retrying now.
  /** A manual reminder for this event went out less than 10 minutes ago. */
  | 'EVENT_REMINDER_COOLDOWN'
  /** The event is a draft, cancelled or completed. */
  | 'EVENT_NOT_REMINDABLE'
  /** The event has already started. */
  | 'EVENT_ALREADY_STARTED'
  /** Nobody is attending the event yet. */
  | 'EVENT_REMINDER_NO_RECIPIENTS'
  /** The key's user sent 100 invitations in the last 24 hours. */
  | 'INVITES_DAILY_LIMIT'
  /** The key's user is restricted (suspended, or blocked from posting) in this community. */
  | 'RESTRICTION_BLOCKED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN'

export interface GurbErrorBody {
  success: false
  error?: string
  /** Some refusals carry their stable code here instead of in `error`. */
  code?: string
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

/**
 * Everything needed to create a community — and deliberately nothing else.
 *
 * There is no `description`, no `type`, no `ownerUserId`. Each was removed
 * rather than accepted-and-ignored, because a parameter that is silently
 * discarded is worse than one that never existed: it reads as a choice the
 * caller made, and it is not.
 *
 * The server decides the rest. Visibility defaults to PRIVATE — a community
 * that appears publicly because someone omitted a field is a leak, not a
 * convenience — and the owner is taken from the credential, so the audit trail
 * names whoever actually performed the action rather than whoever was named in
 * a body.
 */
/**
 * An identity asserted by an IdP you have already registered with Gurb — Okta,
 * Entra, or any other configured `OAuthProvider`.
 *
 * BINDING IS ON `(provider, externalUserId)`, NEVER ON EMAIL. The provider's
 * subject is stable and cannot be claimed by someone else; an e-mail address
 * can. Matching on email alone would let whoever holds the platform key claim
 * any address and reach the account behind it.
 *
 * Email still matters — it is how an incoming identity is joined to an account
 * a person already had — but only under conditions the server enforces:
 * both sides' addresses verified, never a super admin, always audited, and the
 * account owner is e-mailed when it happens.
 */
export interface ExternalOwner {
  /** The `slug` of an OAuthProvider already registered and active in Gurb. */
  provider: string
  /** The provider's own stable id for this person — Okta's `sub`. */
  externalUserId: string
  email: string
  /**
   * Whether the PROVIDER asserts this address is verified.
   *
   * Send the provider's own claim, never `true` for convenience. It is one half
   * of the test that decides whether an incoming identity may join an account
   * that already exists.
   */
  emailVerified: boolean
  firstName?: string
  familyName?: string
}

export interface CreateCommunityInput {
  /** The human-facing name. Arabic is expected; 1–100 characters. */
  name: string
  /**
   * Provision the owner from an IdP instead of using the calling credential.
   *
   * Omit it and the community is owned by whoever the key acts for. Supply it
   * and Gurb resolves — or creates — the account behind that identity and makes
   * them the owner, in the same operation.
   */
  owner?: ExternalOwner
  /**
   * Name the owner by e-mail address instead.
   *
   * THE SIMPLE PATH, and the one to reach for when you have no identity
   * provider registered: you hold a platform key, your customer signs up in
   * YOUR product, and the community is founded by them rather than by you. Gurb
   * finds the account behind the address, or creates one, and makes it the
   * community's ADMIN.
   *
   * Mutually exclusive with `owner` — that one asserts an identity through a
   * registered provider, this one names a Gurb account directly, and sending
   * both is refused locally rather than resolved by a guess.
   *
   * Omitting BOTH is not a neutral default. The community is then founded by
   * whoever the key acts for, and a platform key can only be minted BY a super
   * admin — so unless the key names a subject, your customer's community
   * belongs to the Gurb admin who issued the key. Call `me()` before anything
   * irreversible; `actsForIssuer` is the flag that tells you.
   */
  ownerEmail?: string
  /** Only used when the address names an account that does not exist yet. */
  ownerFirstName?: string
  /** Only used when the address names an account that does not exist yet. */
  ownerFamilyName?: string
  /**
   * The latin identifier used in URLs: lowercase letters, digits and hyphens,
   * 3–50 characters, no leading, trailing or repeated hyphen.
   *
   * Validated before the request leaves, so a malformed slug is a local error
   * with a message naming the rule rather than a round trip and a 400.
   */
  slug: string
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

// ─── Who a key acts for ──────────────────────────────────────────────────────

/**
 * A person, as the platform surface publishes one.
 *
 * `phone` IS NEVER NULL. When the account has no number it carries a run of
 * zeros and `phoneIsPlaceholder` is true.
 *
 * That is deliberate. An integration rendering a profile card wants a field of
 * the right SHAPE to lay out, and a null there becomes the literal string
 * "undefined" in somebody's template. The zeros are chosen so nobody could
 * mistake them for a real number and try to dial them, and the flag means no
 * caller has to detect the placeholder by comparing strings — the kind of check
 * that silently stops working the day the placeholder changes.
 */
export interface SdkPerson {
  userId: string
  email: string
  displayName: string
  /** Never null. Check `phoneIsPlaceholder` before showing it to anyone. */
  phone: string
  phoneIsPlaceholder: boolean
}

/**
 * WHO YOUR KEY ACTS FOR — the first call an integration should make.
 *
 * A platform key can only be MINTED by a Gurb super admin. Before keys could
 * name a subject, that meant every community created through the SDK was
 * founded by the platform admin: a customer handed a key to build their own
 * community founded nothing, while the admin's account silently collected
 * communities they had never heard of. Nobody noticed until somebody asked why
 * their community belonged to someone else.
 *
 * So call this BEFORE anything irreversible. If `actsForIssuer` is true, the key
 * you were given has no subject, and everything you create will belong to the
 * platform admin rather than to you. Ask for a new key rather than proceeding.
 *
 * WHAT IT DOES NOT TELL YOU: anything about permissions. A 200 means the key is
 * live and names a real, active account. It does not mean that account may do
 * any particular thing — permissions are checked per operation and differ per
 * section by design.
 */
export interface SdkIdentity {
  /** The account communities created with this key are founded by. */
  subject: SdkPerson | null
  /** The platform admin who minted the key. Always present. */
  issuedBy: SdkPerson
  /**
   * True when the key names no subject, so it acts for its minter. On a key
   * somebody handed you this is a red flag, not a detail: what you create will
   * not be yours.
   */
  actsForIssuer: boolean
  key: {
    id: string | null
    name: string | null
    scopes: string[]
  }
}

/** The account that will own what you create — the subject if named, else the issuer. */
export function effectiveOwner(identity: SdkIdentity): SdkPerson {
  return identity.subject ?? identity.issuedBy
}

/** The real number, or null when the platform only had a placeholder. */
export function realPhone(person: SdkPerson): string | null {
  return person.phoneIsPlaceholder ? null : person.phone
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

// Permission labels live in ./permissions.ts and are re-exported below. The
// network-fetching versions that used to sit here were removed in 1.7.0: the
// endpoint they called answers 401 to a community key, so they could never have
// worked, and their `permissionLabels(catalog, locale)` shadowed the embedded
// one in the bundle — the source typechecked and the built package threw.

export * from './permissions.js'
