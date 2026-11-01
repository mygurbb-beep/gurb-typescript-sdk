import {
  BULK_MEMBER_LIMIT,
  defaultEmbedHeight,
  isWholeCommunity,
  type Advertisement,
  type AdPosition,
  type Album,
  type CreateAlbumInput,
  type CreateBlogInput,
  type CreateEventInput,
  type CreateTweetInput,
  type UpdateAlbumInput,
  type UpdateBlogInput,
  type UpdateEventInput,
  type UpdateTweetInput,
  type Award,
  type Blog,
  type BulkMemberInput,
  type BulkMemberResult,
  type Comment,
  type CommentParent,
  type Community,
  type CommunityLegal,
  type CommunityRecord,
  type CommunitySettings,
  type Consultant,
  type ConsultantWriteResult,
  type CommunityRequest,
  type CommunityRole,
  type CreateAwardInput,
  type CreateCommentInput,
  type CreateCommunityInput,
  type CreateConsultantInput,
  type CreateEmbedSessionInput,
  type CreateGroupInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type DeletedResult,
  type EmbedSection,
  type EmbedSession,
  type Event,
  type Group,
  type GroupWriteResult,
  type LikeableParent,
  type LikeState,
  type Member,
  type MemberPermissions,
  type Paginated,
  type Project,
  type PaginationParams,
  type Permission,
  type SidebarConfig,
  type Task,
  type TaskDetail,
  type TaskListParams,
  type Tweet,
  type UpdateAdvertisementInput,
  type UpdateAwardInput,
  type UpdateCommentInput,
  type UpdateCommunityBrandingInput,
  type UpdateCommunityLegalInput,
  type UpdateCommunitySettingsInput,
  type UpdateConsultantInput,
  type UpdateGroupInput,
  type UpdateProjectInput,
  type UpdateSidebarInput,
  type UpdateTaskInput,
  type ContentInvitationsResult,
  type ContentInviteType,
  type CreateContentInvitationsInput,
  type EventReminderResult,
  type SendEventReminderInput,
  type DeclineEventRegistrationInput,
  type EventRegistrationList,
  type ListEventRegistrationsParams,
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

/** The `status` filters `events.listRegistrations` accepts — checked locally, as the PHP SDK does. */
const REGISTRATION_FILTERS: ReadonlyArray<string> = ['PENDING', 'GOING', 'DECLINED', 'ALL']

/**
 * A refusal that never left the process.
 *
 * `status: 0` is the marker that NO HTTP call was made. It matters to callers
 * with retry logic: a 5xx is worth retrying and one of these never is — the
 * request would be identical and so would the refusal.
 */
function localValidation(message: string): GurbApiError {
  return new GurbApiError({ message, code: 'VALIDATION_ERROR', status: 0 })
}

/**
 * Encode a caller-supplied id before it becomes a path segment.
 *
 * An id containing a slash would otherwise walk the request onto a path this
 * SDK never meant to call — and on this backend an unmatched `/api/*` answers
 * `400 {"error":"Tenant context required"}` rather than 404, because six
 * routers are mounted at the root and swallow it first. So a typo'd id looks
 * exactly like an auth failure, and sends an integrator to audit credentials
 * that were never the problem.
 */
function seg(id: string): string {
  return encodeURIComponent(id)
}

/**
 * Escape a value for an HTML attribute delimited by double quotes.
 *
 * `&` first, or the ampersands introduced by the later replacements get escaped
 * a second time and `&quot;` renders as the literal text `&quot;`.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * `sdk/{parent}/{parentId}/comments`.
 *
 * `parent` comes from a closed set, so that segment can never be caller text.
 * `parentId` is, and is encoded — see `seg()`.
 */
function commentBase(parent: CommentParent, parentId: string): string {
  return `sdk/${parent}/${seg(parentId)}/comments`
}

function commentLikePath(parent: CommentParent, parentId: string, commentId: string): string {
  return `${commentBase(parent, parentId)}/${seg(commentId)}/like`
}

/** `sdk/{parent}/{parentId}/like`. */
function likePath(parent: LikeableParent, parentId: string): string {
  return `sdk/${parent}/${seg(parentId)}/like`
}

/** Comma-join a one-or-many filter; `undefined` drops out of the query entirely. */
function csv(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : [value]
  // An empty `?status=` is a filter matching nothing, which returns MORE rows
  // than asked for rather than fewer — the failure you do not notice.
  return list.length === 0 ? undefined : list.join(',')
}

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

    /**
     * How this community is configured: menu visibility, home widgets, guest
     * access, direct messages — plus its colours, which travel with this read
     * because it is the one endpoint that returns them.
     *
     * NO PERMISSION IS NEEDED. Gurb serves this to anonymous visitors — a guest
     * landing on a community page has to know which sections to render before
     * logging in — and an API key is strictly more credentialed than the open
     * internet, so requiring anything here would refuse a read a stranger can
     * already perform. No feature gate either.
     */
    getSettings: (): Promise<CommunitySettings> =>
      this.#http.request('GET', 'sdk/community/settings'),

    /**
     * Change some settings.
     *
     * ⚠️ SEND ONLY THE KEYS YOU MEAN TO CHANGE. NEVER READ THE SETTINGS AND
     * WRITE THE WHOLE BLOB BACK. This is the single most dangerous method in
     * the SDK to use carelessly, and the reason is the merge on the other side:
     *
     *     stored = { ...stored, ...yourPatch }
     *
     * with a DEEP merge for `pageVisibility` and nothing else. Every other key
     * you send REPLACES its stored counterpart WHOLESALE. So a
     * read-modify-write round trip — the shape everyone reaches for —
     * overwrites `homeWidgets`, `widgetConfig`, `guestAccess` and the rest with
     * whatever your process happened to be holding, and if anything was stale
     * or decoded to a default, the community's layout is silently gone. The
     * response says success. Nobody finds out until a member reports a missing
     * menu.
     *
     * `pageVisibility` is the safe one, and only because of that deep merge: a
     * patch of `{ news: false }` leaves every other menu entry exactly as it
     * was. `pageVisibility.home` is always forced true by the server whatever
     * you send.
     *
     * Requires `settings:manage` OR `homepage:customize`.
     */
    updateSettings: (patch: UpdateCommunitySettingsInput): Promise<CommunitySettings> => {
      if (!patch || Object.keys(patch).length === 0) {
        // Not a harmless no-op: an empty patch almost always means the caller
        // built it from a filter that matched nothing, and sending a request
        // that changes nothing would hide that.
        return Promise.reject(localValidation('updateSettings needs at least one key to change.'))
      }
      return this.#http.request('PATCH', 'sdk/community/settings', { body: patch })
    },

    /**
     * Rename the community, retint it, move it, or change its VISIBILITY.
     *
     * ⚠️ `type` IS NOT A FLAG. Flipping PUBLIC → PRIVATE resets the
     * guest-preview opt-in on EVERY row of EVERY section, in the same
     * transaction, and flipping back does NOT restore them — an admin has to
     * re-pick each one. It is on this contract because Gurb's own route exposes
     * it under exactly the same permission, and refusing it here would leave an
     * admin unable to do through the API what they can do in the dashboard,
     * with nothing to explain why. A "safer" divergence is still a divergence.
     *
     * There is no `isPublic`, and sending it is a 400 rather than a silent
     * ignore. Visibility is `type` alone; the boolean it replaced was a
     * duplicate that desynced.
     *
     * `logoUrl` and `bannerUrl` are REFUSED for the same reason: images are
     * file uploads, which this surface does not have, and a URL string would be
     * accepted and then do nothing — the worst possible answer.
     *
     * Requires `settings:manage` OR `homepage:customize`.
     */
    updateBranding: (fields: UpdateCommunityBrandingInput): Promise<CommunityRecord> => {
      if (!fields || Object.keys(fields).length === 0) {
        return Promise.reject(localValidation('updateBranding needs at least one field to change.'))
      }
      return this.#http.request('PATCH', 'sdk/community/branding', { body: fields })
    },

    /**
     * The community's own terms of use and privacy policy.
     *
     * NO PERMISSION, and no feature gate — deliberately public upstream for
     * PRIVATE communities too, because a prospective member has to read the
     * rules before agreeing to them.
     */
    getLegal: (): Promise<CommunityLegal> => this.#http.request('GET', 'sdk/community/legal'),

    /**
     * Set the community's terms and/or privacy policy.
     *
     * AN EMPTY STRING IS A REAL INSTRUCTION AND IS NOT THE SAME AS OMITTING THE
     * FIELD. `''` RESTORES the platform's standard template for that document
     * in the community's language; an absent key leaves the stored text alone.
     * Conflating the two produces one of two real bugs: a deliberate reset
     * ignored, or someone's hand-written terms wiped by a call that meant to
     * touch neither.
     *
     * `language` alone changes nothing observable — it only decides which
     * standard template a BLANK field resolves to — so it is not accepted on
     * its own.
     *
     * Requires `settings:manage` OR `homepage:customize`.
     */
    updateLegal: (input: UpdateCommunityLegalInput): Promise<CommunityLegal> => {
      if (input?.terms === undefined && input?.privacyPolicy === undefined) {
        return Promise.reject(
          localValidation(
            'updateLegal needs terms and/or privacyPolicy. Pass "" to restore the standard template.',
          ),
        )
      }
      // Each field is OMITTED when undefined rather than sent as null, because
      // absence is what the server reads as "keep what is stored" — and it
      // makes that decision by asking whether the KEY IS PRESENT.
      return this.#http.request('PATCH', 'sdk/community/legal', {
        body: {
          ...(input.terms === undefined ? {} : { terms: input.terms }),
          ...(input.privacyPolicy === undefined ? {} : { privacyPolicy: input.privacyPolicy }),
          ...(input.language === undefined ? {} : { language: input.language }),
        },
      })
    },
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

  /**
   * Posts on the community's home feed, or inside one of its groups.
   *
   * `create` needs `posts:manage` or `posts:create` on the key's owner — a plain
   * member holds neither, because posting is a capability an admin grants. See
   * CreateTweetInput for why the requirement differs per section.
   */
  tweets = {
    list: (params: PaginationParams = {}): Promise<Paginated<Tweet>> =>
      this.#http.request('GET', 'sdk/tweets', { query: { ...params } }),

    create: (input: CreateTweetInput): Promise<Tweet> => {
      const content = input?.content?.trim() ?? ''
      if (!content) {
        // Caught here so an empty draft costs no round trip and no rate-limit
        // budget. The server refuses it too; this only makes the error local.
        return Promise.reject(new GurbApiError({
          message: 'A post needs content.',
          code: 'VALIDATION_ERROR',
          status: 0,
        }))
      }
      return this.#http.request('POST', 'sdk/tweets', { body: { ...input, content } })
    },

    /**
     * Edit a post. The key's owner may always edit what it published; editing
     * anyone else's needs `posts:manage` or `posts:moderate`.
     */
    update: (tweetId: string, input: UpdateTweetInput): Promise<Tweet> =>
      this.#http.request('PATCH', `sdk/tweets/${encodeURIComponent(tweetId)}`, { body: input }),

    delete: (tweetId: string): Promise<{ id: string; deleted: true }> =>
      this.#http.request('DELETE', `sdk/tweets/${encodeURIComponent(tweetId)}`),
  }

  /**
   * Requires the `events` feature on the community's plan. A community without
   * it answers 403 FEATURE_NOT_AVAILABLE on every call here, reads included —
   * that is an entitlement, not a permission, and no grant will fix it.
   */
  events = {
    list: (params: PaginationParams & { upcoming?: boolean } = {}): Promise<Paginated<Event>> =>
      this.#http.request('GET', 'sdk/events', { query: { ...params } }),

    /** `status: 'DRAFT'` announces nothing — no webhook, no notification. */
    create: (input: CreateEventInput): Promise<Event> =>
      this.#http.request('POST', 'sdk/events', { body: input }),

    update: (eventId: string, input: UpdateEventInput): Promise<Event> =>
      this.#http.request('PATCH', `sdk/events/${encodeURIComponent(eventId)}`, { body: input }),

    delete: (eventId: string): Promise<{ id: string; deleted: true }> =>
      this.#http.request('DELETE', `sdk/events/${encodeURIComponent(eventId)}`),

    /**
     * «إرسال تذكير» — remind people about the event now: the `audience` you pick (the confirmed by
     * default, the interested, every member, or chosen members), through the channels you pick,
     * with an optional `message`.
     *
     * The key's user needs `calendar:manage` or `calendar:moderate`. One manual reminder per
     * event per 10 minutes (`EVENT_REMINDER_COOLDOWN`); a draft, cancelled, finished or started
     * event is refused. E-mails are queued: `emailQueued` is not a delivery count.
     */
    sendReminder: (eventId: string, input: SendEventReminderInput): Promise<EventReminderResult> =>
      this.#http.request('POST', `sdk/events/${encodeURIComponent(eventId)}/reminders`, { body: input }),

    /**
     * «طلبات التسجيل» — the people who registered for the event (members and guests), with their
     * answers to its questions and the organiser's decision. `status` filters: omitted → `PENDING`.
     *
     * The key's user needs `calendar:manage` or `calendar:moderate`, and must see the event at the
     * moderator tier — otherwise `NOT_FOUND`, not a 403, so event ids cannot be probed.
     */
    listRegistrations: (eventId: string, params: ListEventRegistrationsParams = {}): Promise<EventRegistrationList> => {
      if (params.status !== undefined && !REGISTRATION_FILTERS.includes(params.status)) {
        return Promise.reject(localValidation('Unknown registration status — use "PENDING", "GOING", "DECLINED" or "ALL".'))
      }
      return this.#http.request('GET', `sdk/events/${encodeURIComponent(eventId)}/registrations`, { query: { ...params } })
    },

    /**
     * Approve a pending registration: `PENDING` → `GOING` (with an entry ticket when the event
     * issues them). The person is told by e-mail, and a member also in the app.
     *
     * `EVENT_FULL` (400) when it would exceed the capacity; `REGISTRATION_NOT_PENDING` (409) when it
     * was already decided or withdrawn; `EVENT_NOT_BOOKABLE` (409) when the event is a draft,
     * cancelled or over. Same permission as `listRegistrations`.
     */
    approveRegistration: (eventId: string, userId: string): Promise<{ status: 'GOING' }> =>
      this.#http.request(
        'POST',
        `sdk/events/${encodeURIComponent(eventId)}/registrations/${encodeURIComponent(userId)}/approve`,
      ),

    /**
     * Decline a pending registration: `PENDING` → `DECLINED`, with an optional `reason` sent to the
     * person (the server keeps the first 500 characters). A declined person cannot ask again.
     * `REGISTRATION_NOT_PENDING` (409) when it was already decided. Same permission as
     * `listRegistrations`.
     */
    declineRegistration: (
      eventId: string,
      userId: string,
      input: DeclineEventRegistrationInput = {},
    ): Promise<{ status: 'DECLINED' }> =>
      this.#http.request(
        'POST',
        `sdk/events/${encodeURIComponent(eventId)}/registrations/${encodeURIComponent(userId)}/decline`,
        // No reason, no body — the same wire as the PHP SDK.
        input.reason === undefined ? {} : { body: { reason: input.reason } },
      ),
  }

  /**
   * «دعوة للمشاهدة» — invite members to look at a blog post, an album, an event, a post, a project
   * (either projects section) or a consultant, through the channels you pick (default push + bell).
   *
   * The key's user needs the item section's manage or moderate permission (`INSUFFICIENT_PERMISSION`
   * otherwise; consultants: `consultants:manage`) and must be able to open the item, and each
   * invitee too (others come back `UNAVAILABLE`). A person is invited to an item once, by anyone. The
   * item's section must be on the plan (`FEATURE_NOT_AVAILABLE`). 20 invitees per call, 100 per
   * user per day (`INVITES_DAILY_LIMIT`).
   */
  contentInvitations = {
    create: (input: CreateContentInvitationsInput): Promise<ContentInvitationsResult> =>
      this.#http.request('POST', 'sdk/content-invitations', { body: input }),

    /** The user ids the key's user already invited to this item. */
    listMine: (params: { resourceType: ContentInviteType; resourceId: string }): Promise<{ inviteeIds: string[] }> =>
      this.#http.request('GET', 'sdk/content-invitations/mine', { query: { ...params } }),
  }

  /** Requires the `blogs` feature on the plan. Deleting is a SOFT delete upstream. */
  blogs = {
    list: (params: PaginationParams = {}): Promise<Paginated<Blog>> =>
      this.#http.request('GET', 'sdk/blogs', { query: { ...params } }),

    create: (input: CreateBlogInput): Promise<Blog> =>
      this.#http.request('POST', 'sdk/blogs', { body: input }),

    update: (blogId: string, input: UpdateBlogInput): Promise<Blog> =>
      this.#http.request('PATCH', `sdk/blogs/${encodeURIComponent(blogId)}`, { body: input }),

    delete: (blogId: string): Promise<{ id: string; deleted: true }> =>
      this.#http.request('DELETE', `sdk/blogs/${encodeURIComponent(blogId)}`),
  }

  /**
   * Requires the `albums` feature on the plan.
   *
   * NOTE: `create` makes an EMPTY album. Adding images is not supported on this
   * surface yet — uploads need storage-budget accounting, and shipping them
   * without it would let a community silently exceed the storage its plan pays
   * for. Members can still add images through the app.
   */
  albums = {
    list: (params: PaginationParams = {}): Promise<Paginated<Album>> =>
      this.#http.request('GET', 'sdk/albums', { query: { ...params } }),

    create: (input: CreateAlbumInput): Promise<Album> =>
      this.#http.request('POST', 'sdk/albums', { body: input }),

    update: (albumId: string, input: UpdateAlbumInput): Promise<Album> =>
      this.#http.request('PATCH', `sdk/albums/${encodeURIComponent(albumId)}`, { body: input }),

    delete: (albumId: string): Promise<{ id: string; deleted: true }> =>
      this.#http.request('DELETE', `sdk/albums/${encodeURIComponent(albumId)}`),
  }

  /**
   * Feature-gated on `groups`, reads included.
   *
   * The list is NOT filtered by visibility — private groups are in it. See
   * `Group.isPrivate` for the responsibility that comes with that.
   */
  groups = {
    list: (params: PaginationParams = {}): Promise<Paginated<Group>> =>
      this.#http.request('GET', 'sdk/groups', { query: { ...params } }),

    /**
     * Create a group. Needs `groups:manage` OR `groups:create`.
     *
     * `iconUrl` IS REQUIRED, and that is a consequence of there being no
     * uploads on this surface: Gurb's own route takes an icon FILE and its
     * service refuses a group without one, so the URL string occupies the
     * argument the uploaded file's URL would have filled.
     *
     * `isPrivate` is required rather than defaulted, because defaulting a
     * VISIBILITY field is how a private group gets published by accident.
     */
    create: (input: CreateGroupInput): Promise<GroupWriteResult> => {
      const name = input?.name?.trim() ?? ''
      const description = input?.description?.trim() ?? ''
      const iconUrl = input?.iconUrl?.trim() ?? ''

      if (!name || !description || !iconUrl) {
        return Promise.reject(
          localValidation('A group needs a name, a description and an http(s) iconUrl.'),
        )
      }

      // The TRIMMED values are what get sent, not merely what got validated.
      // Validating one string and transmitting another is an easy and real bug.
      return this.#http.request('POST', 'sdk/groups', {
        body: { ...input, name, description, iconUrl },
      })
    },

    /**
     * Update a group.
     *
     * The key's owner may edit what it created — authorship is checked FIRST,
     * exactly as the web app checks it — and editing anyone else's needs
     * `groups:manage`, `groups:create` or `groups:moderate`.
     *
     * AN IMAGE CANNOT BE CLEARED HERE. `iconUrl: null` and `coverUrl: null` are
     * refused rather than silently ignored, because upstream a falsy value is
     * indistinguishable from an absent one and would answer 200 while changing
     * nothing.
     */
    update: (groupId: string, fields: UpdateGroupInput): Promise<GroupWriteResult> =>
      this.#http.request('PATCH', `sdk/groups/${seg(groupId)}`, { body: fields }),

    /**
     * Delete a group.
     *
     * THE ONE PLACE ON THIS SURFACE WHERE DELETE IS NOT UPDATE-MINUS-CREATE:
     * `groups:manage` or `groups:moderate` ONLY, with NO authorship shortcut. A
     * group's creator may rename their group and may not delete it. That
     * asymmetry is deliberate upstream — the permission was widened toward
     * moderators, not toward authors — and it is mirrored rather than smoothed
     * out.
     */
    delete: (groupId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `sdk/groups/${seg(groupId)}`),
  }

  /**
   * Consultancy listings. Feature-gated on `consultants`, reads included.
   *
   * THE FLATTEST PERMISSION IN THIS SDK: `consultants:manage` for create,
   * update AND delete, with no authorship shortcut anywhere. That is not a
   * simplification made here — it is the only consultant permission the
   * platform has, so there is no create/moderate split to mirror.
   */
  consultants = {
    list: (params: PaginationParams = {}): Promise<Paginated<Consultant>> =>
      this.#http.request('GET', 'sdk/consultants', { query: { ...params } }),

    /**
     * `bookingUrl` is required because the column is NOT NULL upstream.
     *
     * TYPES (specialties) ARE NOT CREATED HERE. `typeIds` attaches EXISTING
     * ones; there is no `newTypes`, because creating taxonomy rows as a side
     * effect of writing a consultant is how a shared specialty vocabulary fills
     * with near-duplicates.
     */
    create: (input: CreateConsultantInput): Promise<ConsultantWriteResult> => {
      const displayName = input?.displayName?.trim() ?? ''
      const bookingUrl = input?.bookingUrl?.trim() ?? ''

      if (!displayName || !bookingUrl) {
        return Promise.reject(localValidation('A consultant needs a displayName and a bookingUrl.'))
      }

      return this.#http.request('POST', 'sdk/consultants', {
        body: { ...input, displayName, bookingUrl },
      })
    },

    /**
     * IMAGES CAN BE CLEARED HERE, unlike a group's: `avatarUrl: null` and
     * `bannerUrl: null` reach the column and empty it.
     *
     * `typeIds` REPLACES the specialty set wholesale — `[]` removes every one.
     * "Add a specialty" and "set the specialties" look identical in a request
     * body, so this is the sentence to read twice.
     */
    update: (
      consultantId: string,
      fields: UpdateConsultantInput,
    ): Promise<ConsultantWriteResult> =>
      this.#http.request('PATCH', `sdk/consultants/${seg(consultantId)}`, { body: fields }),

    /** A HARD delete — there is no `deletedAt` and nothing to restore. */
    delete: (consultantId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `sdk/consultants/${seg(consultantId)}`),
  }

  /**
   * The first projects module. Feature-gated on `projects`, reads included.
   *
   * ⚠️ THE FIELD IS `name` ON THE WAY IN AND `title` ON THE WAY BACK. The write
   * contract accepts `name`; `Project.title` is what the same value is called
   * in every response. Sending `title` sets nothing and the server refuses the
   * call for a missing `name`.
   */
  projects = {
    list: (params: PaginationParams = {}): Promise<Paginated<Project>> =>
      this.#http.request('GET', 'sdk/projects', { query: { ...params } }),

    /**
     * Needs `projects:manage`, `projects:create` OR `projects:moderate`. That
     * third one is unusual for a create and is copied, not tidied.
     *
     * NO `status` DEFAULT is applied. "No status yet" is a real state a project
     * can be in, and inventing `PLANNING` here would make every SDK-created
     * project look different from every form-created one.
     */
    create: (input: CreateProjectInput): Promise<Project> => {
      const name = input?.name?.trim() ?? ''
      const description = input?.description?.trim() ?? ''

      if (!name || !description) {
        return Promise.reject(localValidation('A project needs a name and a description.'))
      }

      return this.#http.request('POST', 'sdk/projects', { body: { ...input, name, description } })
    },

    /**
     * The key's owner may ALWAYS edit what it created — authorship is checked
     * FIRST. Editing anyone else's needs `projects:manage`, `projects:create`,
     * `projects:moderate` or `projects:edit`.
     */
    update: (projectId: string, fields: UpdateProjectInput): Promise<Project> =>
      this.#http.request('PATCH', `sdk/projects/${seg(projectId)}`, { body: fields }),

    /**
     * Narrower than update, and not in the way the other sections are:
     * `projects:create` drops but `projects:edit` STAYS. Authorship still
     * counts. A HARD delete, and no `project.deleted` webhook announces it.
     */
    delete: (projectId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `sdk/projects/${seg(projectId)}`),
  }

  /**
   * The second projects module.
   *
   * A GENUINE PARALLEL MODULE, NOT A NEWER VERSION — the "2" is the platform's
   * name, not a deprecation marker this SDK invented. Some communities run this
   * one instead of `projects`, some run both, and nothing in a response tells
   * you which. So both are exposed rather than guessed at: a client that
   * silently read only one would return an empty list for half the platform's
   * communities, which is the worst possible failure — it reads as "this
   * community has no projects" rather than "you asked the wrong module".
   *
   * TWO GATES stand in front of every call here, refusing with different codes
   * because they send you to different people: `FEATURE_NOT_AVAILABLE` (the
   * PLAN lacks it — talk to whoever pays) and `FEATURE_DISABLED` (an admin
   * switched the module off — talk to them).
   *
   * The permission set matches `projects` but the NAMES do not: `projects2:*`.
   * A grant on the first module does nothing here.
   */
  projects2 = {
    list: (params: PaginationParams = {}): Promise<Paginated<Project>> =>
      this.#http.request('GET', 'sdk/projects2', { query: { ...params } }),

    create: (input: CreateProjectInput): Promise<Project> => {
      const name = input?.name?.trim() ?? ''
      const description = input?.description?.trim() ?? ''

      if (!name || !description) {
        return Promise.reject(localValidation('A project needs a name and a description.'))
      }

      return this.#http.request('POST', 'sdk/projects2', { body: { ...input, name, description } })
    },

    update: (projectId: string, fields: UpdateProjectInput): Promise<Project> =>
      this.#http.request('PATCH', `sdk/projects2/${seg(projectId)}`, { body: fields }),

    delete: (projectId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `sdk/projects2/${seg(projectId)}`),
  }

  /**
   * The catalogue of medals this community DEFINES.
   *
   * THIS IS NOT A LIST OF AWARDS ANYONE RECEIVED. Each row is a medal that
   * exists; who holds it, and since when, lives on the grant and not here —
   * which is why every `Award.awardedAt` comes back null.
   *
   * `awards:manage` on all three verbs, with NO authorship shortcut: a medal is
   * a community-wide object, not a member's own content, so there is nothing to
   * own. Feature-gated on `awards`, reads included.
   */
  awards = {
    list: (params: PaginationParams = {}): Promise<Paginated<Award>> =>
      this.#http.request('GET', 'sdk/awards', { query: { ...params } }),

    /**
     * DEFINE a medal. This does NOT give it to anybody.
     *
     * GRANTING IS NOT ON THIS SURFACE AT ALL, and that is a product decision
     * rather than a gap. Granting writes recipient rows, can name every member
     * of a community in one call, notifies and pushes to each of them, and
     * emits an event carrying every recipient's identity — it turns a catalogue
     * into a public statement about named people. Shipping it quietly alongside
     * CRUD would be publishing a "broadcast member identities" endpoint under
     * the heading "awards write support".
     *
     * `icon` IS A PRESET KEY such as `"trophy"`, not a URL. `color` must be hex.
     */
    create: (input: CreateAwardInput): Promise<Award> => {
      const name = input?.name?.trim() ?? ''
      const icon = input?.icon?.trim() ?? ''
      const color = input?.color?.trim() ?? ''

      if (!name || !icon || !color) {
        return Promise.reject(
          localValidation('An award needs a name, an icon preset key and a hex color.'),
        )
      }

      // The hex FORMAT is left to the server on purpose: a second copy of that
      // pattern here is a second thing to keep in sync, and being stricter than
      // Gurb would refuse a colour its own dialog accepts.
      return this.#http.request('POST', 'sdk/awards', { body: { ...input, name, icon, color } })
    },

    update: (awardId: string, fields: UpdateAwardInput): Promise<Award> =>
      this.#http.request('PATCH', `sdk/awards/${seg(awardId)}`, { body: fields }),

    /**
     * THIS CASCADES TO THE PEOPLE WHO EARNED IT: every recipient row goes with
     * the definition, so every member holding the medal loses it. That is
     * Gurb's own behaviour, not a harsher SDK one, and it is the reason this
     * deserves a confirmation step in whatever UI calls it.
     */
    delete: (awardId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `sdk/awards/${seg(awardId)}`),
  }

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  /**
   * The community's task board.
   *
   * TASKS ARE THREE LEVELS DEEP — section → heading → task — and only the last
   * is on this surface. `headingId` is required on create and there is no inbox
   * to fall back on; read the ids off the community's own board.
   *
   * ASSIGNMENT IS NOT PUBLISHED IN v1. You cannot choose who does a task
   * through this API, and you cannot read back who is on one — only how many,
   * via `Task.assignmentCount`. Shipping assign without unassign would leave an
   * integration unable to undo its own writes, and the internal assign call has
   * a `role: 'MEMBER'` mode that expands to EVERY approved member in one write
   * and notifies each of them. That needs its own endpoint, not a value in an
   * enum.
   *
   * WHAT STILL WORKS, and it is more than it sounds: assignment by
   * INHERITANCE. Creating a task copies every assignee the chosen heading and
   * its section already carry, so **choosing `headingId` IS the assignment
   * decision** in a community that assigns people to headings.
   *
   * Reading needs NO permission — Gurb's own route has no permission guard on
   * either read. Writing needs `tasks:manage`, with no authorship shortcut.
   * Feature-gated on `tasks`, reads included.
   */
  tasks = {
    /**
     * Listed rows are LIST rows: `sectionId`, `sectionName`, `headingName`,
     * `dependsOn`, `blocking` and `activityCount` are null or empty on every
     * one of them. That is a property of the endpoint, not of the task — use
     * `get()`. `list()` also filters to active tasks.
     */
    list: (params: TaskListParams = {}): Promise<Paginated<Task>> =>
      this.#http.request('GET', 'sdk/tasks', {
        query: {
          page: params.page,
          limit: params.limit,
          status: csv(params.status),
          priority: csv(params.priority),
          assigneeUserId: params.assigneeUserId,
          headingId: params.headingId,
          sectionId: params.sectionId,
          dueBefore: params.dueBefore,
          dueAfter: params.dueAfter,
          search: params.search,
        },
      }),

    /**
     * One task, with the five fields a list row cannot carry: its section, that
     * section's name, its heading's name, its dependency graph and its activity
     * count.
     *
     * This is also the ONLY way to see a hidden task (`isActive === false`),
     * which stays addressable by id after it drops off the board.
     */
    get: (taskId: string): Promise<TaskDetail> =>
      this.#http.request('GET', `sdk/tasks/${seg(taskId)}`),

    /**
     * `title` IS CAPPED AT 40 CHARACTERS upstream. That is genuinely surprising
     * and is not a typo; an integrator will hit it. The cap is left to the
     * server so this SDK cannot drift from it.
     *
     * `status` is NOT accepted on create — the insert hardcodes `PENDING`. Send
     * an update immediately after if you need a task that starts in progress.
     */
    create: (input: CreateTaskInput): Promise<Task> => {
      const headingId = input?.headingId?.trim() ?? ''
      const title = input?.title?.trim() ?? ''

      if (!headingId || !title) {
        return Promise.reject(localValidation('A task needs a headingId and a title.'))
      }

      return this.#http.request('POST', 'sdk/tasks', { body: { ...input, headingId, title } })
    },

    /**
     * THREE FIELDS HAVE CONSEQUENCES THEIR NAMES DO NOT ADVERTISE:
     *
     *   - `status: 'COMPLETED'` stamps a completion time and announces the
     *     completion — but only on the TRANSITION. Re-sending COMPLETED on an
     *     already-completed task is a plain update, and moving away from it is
     *     a reopen. Exactly one announcement leaves per call, so an integration
     *     mirroring state can rely on it.
     *   - `autoAssignNewMembers: true` assigns this task to everyone approved
     *     into the community FROM NOW ON. Never retroactive, and suppressed
     *     entirely when the parent section is restricted to specific members.
     *   - `isActive: false` is the product's HIDE, not a delete: the task drops
     *     out of `list()` and keeps its id. Nothing is announced.
     */
    update: (taskId: string, fields: UpdateTaskInput): Promise<Task> =>
      this.#http.request('PATCH', `sdk/tasks/${seg(taskId)}`, { body: fields }),

    /**
     * A HARD delete, unlike a blog on this same surface: the row and everything
     * cascading from it — assignments, dependencies, the activity log — are
     * gone. If you want it off the board but recoverable,
     * `update(id, { isActive: false })` is the operation you actually want.
     */
    delete: (taskId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `sdk/tasks/${seg(taskId)}`),
  }

  // ─── Comments and likes ────────────────────────────────────────────────────

  /**
   * Comments, and the likes ON comments.
   *
   * COMMENTING NEEDS NO PERMISSION, AND THAT IS THE OPPOSITE OF POSTING — worth
   * saying out loud because every other write surface here opens by naming a
   * permission. Answering is what an ordinary member does, so MEMBERSHIP is the
   * whole gate. A key whose owner was granted nothing — which is every plain
   * member, since `MEMBER` is an empty permission set in Gurb — cannot publish
   * a post and CAN comment on one.
   *
   * WHAT DOES REFUSE YOU: the parent's FEATURE GATE (blogs, albums and events
   * are plan-gated on the LIST as well as the write; tweets are not), the
   * parent's own `allowComments` switch, and TIME on edit and delete.
   *
   * THE PARENT IS ALWAYS IN THE PATH, even for editing a comment whose id is
   * already unique. Gurb's comment table is keyed by (resource type, resource
   * id) and has NO community column, so naming the parent is the only way the
   * server can check the comment is inside the community your key is pinned to.
   * The wrong parent for a real comment id is a 404, not a silent
   * cross-community edit.
   */
  comments = {
    /**
     * PAGINATION COUNTS TOP-LEVEL COMMENTS ONLY. Replies travel nested inside
     * their parent (`Comment.replies`, to unlimited depth), so a page of 20 may
     * contain far more than 20 comments in total.
     */
    list: (
      parent: CommentParent,
      parentId: string,
      params: PaginationParams = {},
    ): Promise<Paginated<Comment>> =>
      this.#http.request('GET', commentBase(parent, parentId), { query: { ...params } }),

    /**
     * Post a comment, or a reply.
     *
     * ONE METHOD, NOT TWO. Gurb's own system splits them because a multipart
     * form cannot nest; this surface is JSON, where the parent comment is just
     * a field, and two endpoints differing only in where one id travels would
     * be two things to learn and one more place for them to disagree.
     *
     * `parentCommentId` must name a comment on THIS parent, or you get a 404.
     * Omit it entirely for a top-level comment — a blank string is refused
     * locally rather than quietly posted at top level, because it almost always
     * means a variable that failed to resolve, and silently turning someone's
     * reply into a new thread is worse than an error.
     */
    create: (
      parent: CommentParent,
      parentId: string,
      input: CreateCommentInput,
    ): Promise<Comment> => {
      const content = input?.content?.trim() ?? ''
      if (!content) {
        // Caught locally so an empty draft costs no round trip and no
        // rate-limit budget — and comments ARE rate limited, at 20 with a
        // one-per-second refill.
        return Promise.reject(localValidation('A comment needs content.'))
      }

      const body: { content: string; parentCommentId?: string } = { content }
      if (input.parentCommentId !== undefined) {
        const parentCommentId = input.parentCommentId.trim()
        if (!parentCommentId) {
          return Promise.reject(
            localValidation(
              'parentCommentId must name a comment; omit it entirely for a top-level comment.',
            ),
          )
        }
        body.parentCommentId = parentCommentId
      }

      return this.#http.request('POST', commentBase(parent, parentId), { body })
    },

    /**
     * Edit a comment.
     *
     * AUTHOR ONLY, WITHIN 15 MINUTES, AND NO PERMISSION OVERRIDES IT. There is
     * no moderator escape hatch on either surface — nobody edits another
     * member's words; a moderator who needs a comment gone deletes it. So this
     * succeeds only for comments the KEY'S OWNER wrote, and only just after
     * they wrote them.
     */
    update: (
      parent: CommentParent,
      parentId: string,
      commentId: string,
      input: UpdateCommentInput,
    ): Promise<Comment> => {
      const content = input?.content?.trim() ?? ''
      if (!content) return Promise.reject(localValidation('A comment needs content.'))

      return this.#http.request('PATCH', `${commentBase(parent, parentId)}/${seg(commentId)}`, {
        body: { content },
      })
    },

    /**
     * Delete a comment.
     *
     * A WIDER RULE THAN EDIT, and the asymmetry is real: the author may delete
     * within 30 minutes (not 15), and a community ADMIN or MODERATOR may delete
     * at any time with no window at all. That moderator power is a ROLE, not a
     * grantable permission, which is why no permission name appears here.
     *
     * THE DELETE CASCADES TO REPLIES, and exactly one deletion is announced —
     * the one you asked for.
     */
    delete: (parent: CommentParent, parentId: string, commentId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `${commentBase(parent, parentId)}/${seg(commentId)}`),

    /**
     * Does the KEY'S OWNER like this comment, and how many people do?
     *
     * `liked` is about the one human the key was minted for and nobody else — a
     * server key cannot express "did this visitor like it", which is what embed
     * sessions are for. `likeCount` is everybody's.
     */
    likeState: (parent: CommentParent, parentId: string, commentId: string): Promise<LikeState> =>
      this.#http.request('GET', commentLikePath(parent, parentId, commentId)),

    /** Idempotent — liking twice leaves one like. Rate limited. */
    like: (parent: CommentParent, parentId: string, commentId: string): Promise<LikeState> =>
      this.#http.request('POST', commentLikePath(parent, parentId, commentId)),

    /**
     * Answers the same shape as `like()`, so a UI can render straight from the
     * response of the action it just took, with no follow-up read.
     */
    unlike: (parent: CommentParent, parentId: string, commentId: string): Promise<LikeState> =>
      this.#http.request('DELETE', commentLikePath(parent, parentId, commentId)),
  }

  /**
   * Liking a post, a blog or an album — as the key's owner.
   *
   * LIKING NEEDS NO PERMISSION, like commenting and unlike posting. Gurb's own
   * like routes are authentication, membership and a rate limiter, with no
   * permission guard anywhere.
   *
   * THREE PARENTS, NOT FOUR. There is no event like: the platform's own service
   * answers "not yet implemented" and publishes no route, so offering one would
   * be a contract promising something that does not exist. Comments are
   * likeable too, but through `comments.like()` — a comment like is addressed
   * by parent AND comment id.
   *
   * WHAT CAN REFUSE YOU: the parent's FEATURE GATE (blogs and albums are
   * plan-gated on the read as well as the write; tweets are not), MODERATION on
   * tweets ONLY — the one parent whose like runs the community's
   * member-restriction check, so a muted key owner gets 403 RESTRICTION_BLOCKED
   * there and nowhere else — and the RATE LIMITER on both verbs.
   */
  likes = {
    state: (parent: LikeableParent, parentId: string): Promise<LikeState> =>
      this.#http.request('GET', likePath(parent, parentId)),

    like: (parent: LikeableParent, parentId: string): Promise<LikeState> =>
      this.#http.request('POST', likePath(parent, parentId)),

    unlike: (parent: LikeableParent, parentId: string): Promise<LikeState> =>
      this.#http.request('DELETE', likePath(parent, parentId)),
  }

  // ─── Customization ─────────────────────────────────────────────────────────

  /**
   * The community's navigation menu.
   *
   * EVERY METHOD HERE, READS INCLUDED, needs the `homepage_widgets` feature on
   * the community's plan. Gurb gates the whole module at router level — the
   * reads on purpose, because per-route gating once left them open and that gap
   * was closed deliberately. Mirroring only the write gate would re-open it
   * from the API side.
   *
   * Reading needs no permission beyond membership, which the key already proves
   * on every request. Writing needs `homepage:customize` OR `settings:manage`.
   *
   * THE HOME-PAGE WIDGETS ARE NOT HERE. `settings.homeWidgets` is a key in the
   * settings blob and is written through `community.updateSettings()`, where
   * its merge semantics live. Two endpoints writing one JSON key would be two
   * merge paths to keep in step.
   */
  sidebar = {
    get: (): Promise<SidebarConfig> => this.#http.request('GET', 'sdk/customization/sidebar'),

    /**
     * Replace the menu.
     *
     * ⚠️ PUT, NOT PATCH, AND THAT IS NOT AN OVERSIGHT. This is the one write on
     * this whole surface that is genuinely a replace, and the SDK mirrors the
     * platform's verb rather than normalising it: sending `items` REPLACES THE
     * WHOLE ARRAY. There is no per-item merge, so a menu built by appending one
     * entry to a stale read loses everything the read did not contain. Omitting
     * `items` keeps the stored menu untouched.
     *
     * What it does NOT replace is the rest of the community's settings — a
     * sidebar write swaps only the sidebar key.
     *
     * `items` is passed through UNVALIDATED on purpose. The server renames
     * legacy menu ids, validates the shape and sanitises every label; checking
     * here would duplicate all three and would reject ids the rename step
     * deliberately accepts. Icon names come from `icons()`.
     */
    update: (input: UpdateSidebarInput): Promise<SidebarConfig> => {
      if (input?.items === undefined && input?.enabled === undefined) {
        return Promise.reject(localValidation('sidebar.update needs items and/or enabled.'))
      }
      return this.#http.request('PUT', 'sdk/customization/sidebar', {
        body: {
          ...(input.items === undefined ? {} : { items: input.items }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        },
      })
    },

    /**
     * Reset the menu to the platform default.
     *
     * NOT A FULL WIPE, and the asymmetry is the platform's rather than this
     * SDK's: uploaded section BANNERS survive a reset while custom ICONS do
     * not. A banner is a photograph an admin would have to go and find again;
     * an icon is a pick from a list.
     */
    reset: (): Promise<SidebarConfig> =>
      this.#http.request('DELETE', 'sdk/customization/sidebar'),

    /** The default menu, unsaved — useful for diffing before calling `reset()`. */
    default: (): Promise<SidebarConfig> =>
      this.#http.request('GET', 'sdk/customization/sidebar/default'),

    /**
     * The icon names a menu item may use.
     *
     * Published as the bare list it is rather than mapped into objects: it IS
     * the vocabulary, and reshaping it would create a second name for every
     * icon that `update()` would then have to translate back.
     */
    icons: async (): Promise<string[]> => {
      const data = await this.#http.request<{ icons?: unknown }>(
        'GET',
        'sdk/customization/sidebar/icons',
      )
      return Array.isArray(data?.icons) ? data.icons.filter((i): i is string => typeof i === 'string') : []
    },
  }

  /**
   * A community's advertisement placements.
   *
   * ⚠️ READ THIS BEFORE DEBUGGING A 403 HERE. EVERY method in this section,
   * including `listActive()` — the member-facing widget feed, which carries no
   * permission requirement at all — is behind the `ads_management` plan
   * feature. A community without it gets 403 FEATURE_NOT_AVAILABLE on its own
   * ad widget.
   *
   * That exact combination has already been misdiagnosed in production:
   * members could not see ads, everyone went looking for a missing permission,
   * and the answer was an entitlement gap. An entitlement is not a permission.
   * No grant, no role and no key fixes it — only the community's plan does.
   *
   * `listActive()` needs no permission. `list()`, `update()` and `delete()`
   * need `ads:manage` OR `homepage:customize` — `list()` returns inactive and
   * expired ads, which makes it an admin view, which is why it carries the
   * writes' permission rather than none.
   *
   * THERE IS NO CREATE, AND THERE CANNOT BE ONE YET. An ad is its image, the
   * image is a file upload, and this surface has no uploads; Gurb's own create
   * refuses a request without a file. Accepting an external `imageUrl` instead
   * would write a value the web app's asset resolver was never taught to
   * render. Create ads in the dashboard and manage their schedule, targeting
   * and activation here.
   */
  advertisements = {
    /**
     * The ads a member would actually see right now: active, in date, and — if
     * you ask — in one position. NOT PAGINATED; it is a widget feed, and it is
     * short by construction.
     */
    listActive: async (params: { position?: AdPosition } = {}): Promise<Advertisement[]> => {
      const data = await this.#http.request<{ items?: unknown }>(
        'GET',
        'sdk/customization/advertisements/active',
        { query: { position: params.position } },
      )
      return Array.isArray(data?.items) ? (data.items as Advertisement[]) : []
    },

    /** Every ad, including the inactive and the expired. An ADMIN view. */
    list: (params: PaginationParams = {}): Promise<Paginated<Advertisement>> =>
      this.#http.request('GET', 'sdk/customization/advertisements', { query: { ...params } }),

    /**
     * Change an ad's schedule, link, placement or activation. No authorship
     * shortcut — an ad belongs to the community, not to whoever uploaded it.
     *
     * `linkUrl: null` clears the link. `isGuestVisible: true` can fail for a
     * PRIVATE community, with its own code — a real product rule, not a
     * permission problem.
     *
     * An id naming another community's ad is a 404, identical to an id naming
     * nothing, so this cannot be used to discover what exists elsewhere.
     */
    update: (adId: string, fields: UpdateAdvertisementInput): Promise<Advertisement> =>
      this.#http.request('PATCH', `sdk/customization/advertisements/${seg(adId)}`, {
        body: fields,
      }),

    /**
     * A HARD delete — the row goes, and its impression and click counts with
     * it. There is no `deletedAt` and nothing to restore. If you want the ad
     * off the page but the numbers kept, `update(id, { isActive: false })` is
     * the operation you actually want.
     */
    delete: (adId: string): Promise<DeletedResult> =>
      this.#http.request('DELETE', `sdk/customization/advertisements/${seg(adId)}`),
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
     * ONE PATH, AND EVERYTHING ELSE IN THE FRAGMENT. This used to be
     * `/embed/{slug}/{section}#t=…`, and it did not work: the page that answers
     * the handshake lives at `/embed` and reads `token`, so the URL named a
     * route that does not exist and a fragment key nothing reads. Both halves
     * had passing tests; neither suite crossed the boundary between them.
     *
     * THE SLUG IS OPTIONAL AND UNUSED, kept only so existing call sites still
     * compile. The token's server-side envelope already carries the
     * communityId — it was pinned when the host minted the session — so the
     * community is decided by the credential, not by a path segment. A slug
     * alongside it could only ever agree or contradict, and there is no useful
     * behaviour for the contradiction.
     *
     * Fragment, not query string: fragments are never sent to a server, so the
     * token stays out of nginx access logs, `Referer` headers on outbound links
     * and whatever analytics the host page runs. In a query string it would be
     * written to disk in three places before the page finished loading.
     */
    buildUrl: (args: { slug?: string; section: EmbedSection; token: string }): string => {
      const fragment = new URLSearchParams({ token: args.token })
      // Omitted entirely for the whole-community frame: absence means "the
      // community home", which is where the page sends an arriving member
      // anyway. This matches @gurb/embed's contract exactly — see the boundary
      // tests there, which pin this shape on the other side.
      if (!isWholeCommunity(args.section)) fragment.set('section', args.section)

      return `${this.#http.baseUrl}/embed#${fragment.toString()}`
    },

    /**
     * A plain `<iframe>` string and nothing else. NO external script, NO CDN,
     * NO npm.
     *
     * Reach for this when you do not want a third-party script on your page's
     * critical path, when your CSP forbids one, or when you render HTML on the
     * server and there is no `@gurb/embed` in the browser at all. Everything
     * the embed actually needs is here: the URL, the token in the fragment, and
     * the frame.
     *
     * What you give up versus `@gurb/embed`'s `mount()` is auto-resize, so pick
     * a `height` that suits your layout — the frame will not grow by itself.
     *
     * The default height follows the SHAPE being embedded: a whole community at
     * 600px shows a navigation bar and little else in the moment before a
     * member decides the integration is broken.
     */
    iframe: (args: {
      section: EmbedSection
      token: string
      height?: number
      /** Extra CSS, appended after the defaults so it wins. */
      style?: string
    }): string => {
      const src = this.embed.buildUrl({ section: args.section, token: args.token })
      const attrs: Record<string, string> = {
        src,
        title: `Gurb — ${args.section}`,
        loading: 'lazy',
        style: `width:100%;height:${args.height ?? defaultEmbedHeight(args.section)}px;border:0;${args.style ?? ''}`,
        // Least privilege, and each of these is load-bearing:
        //   allow-same-origin — WITHOUT IT THE EMBED CANNOT WORK AT ALL. The
        //     page stores its session in sessionStorage and rewrites its own
        //     URL; an opaque origin makes both throw.
        //   allow-scripts     — it is a React app.
        //   allow-forms       — posting, commenting, joining.
        //   allow-popups + …popups-to-escape-sandbox — external links in member
        //     content open as ordinary pages rather than inheriting this
        //     sandbox.
        // Deliberately ABSENT: allow-top-navigation. Nothing inside the frame
        // should be able to navigate the host's page away.
        sandbox:
          'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
      }

      const rendered = Object.entries(attrs)
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join('')

      return `<iframe${rendered}></iframe>`
    },
  }
}

export function createGurbClient(options: GurbClientOptions): GurbClient {
  return new GurbClient(options)
}
