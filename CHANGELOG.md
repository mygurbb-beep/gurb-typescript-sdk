# Changelog

This package and [`gurb/sdk`](https://github.com/mygurbb-beep/gurb-php-sdk) track each
other **version for version**. They are written against one route contract and are
meant to be interchangeable on the wire, so `@gurb/server` 1.6.0 and `gurb/sdk` 1.6.0
speak the same API — same paths, same request bodies, same local guards, same error
codes. They differ only in call-site shape, which is language idiom rather than
contract.

> **The jump from 0.5.0 to 1.6.0 is deliberate**, and it is the version numbers being
> corrected rather than fifteen releases happening at once. The PHP SDK had already
> been tagged 1.0 through 1.5 while this package was still numbered 0.x, so the two
> had drifted apart despite shipping the same contract. The entries below 1.6.0
> describe releases that were never published to npm; 1.6.0 is the first.

## @gurb/server 1.10.0 + @gurb/api-types 1.10.0 (gurb/sdk 1.10.0)

`@gurb/embed` stays at 1.8.0 (unchanged). The PHP SDK ships the same contract as `gurb/sdk` 1.10.0.

### Added — event registration: guests, approval and questions (feat/event-guests)

«تسجيل الزوار في الفعاليات» — the organiser's surface. The visitor's own flow (register, verify the
e-mailed code, book, cancel) is browser-only on Gurb's shared event page and is not in this SDK.

- `events.listRegistrations(eventId, { status? })` → `GET /api/sdk/events/{id}/registrations` —
  «طلبات التسجيل»: members and guests (`isGuest`) who registered, their `answers` and the decision.
  `status`: `PENDING` (default), `GOING`, `DECLINED` or `ALL`; `counts` per status.
- `events.approveRegistration(eventId, userId)` → `POST /api/sdk/events/{id}/registrations/{userId}/approve`
  — `PENDING` → `GOING`.
- `events.declineRegistration(eventId, userId, { reason? })` →
  `POST /api/sdk/events/{id}/registrations/{userId}/decline` — `PENDING` → `DECLINED`; the reason
  (≤ 500) is sent to the person.
- `CreateEventInput` / `UpdateEventInput` and `Event` gain the optional `guestRegistration`,
  `approvalGuests`, `approvalMembers` and `registrationQuestions` (the join-form document, questions only).
  `guestRegistration` works on free AND paid events: on a paid one the visitor pays the ticket price on
  the shared page and returns to it with the ticket. Approval stays free-only.
  The three calls need `calendar:manage` or `calendar:moderate` (approve/decline: a `write` key); the
  settings ride on `events.create` / `events.update` and need what those need.
- Types: `JoinText`, `JoinFormQuestionType`, `JoinFormQuestion`, `JoinFormSection`, `JoinFormDocument`,
  `JoinChoiceAnswer`, `JoinAnswerValue`, `JoinAnswers`, `EventRegistrationStatus`,
  `ListEventRegistrationsParams`, `EventRegistration`, `EventRegistrationList`,
  `DeclineEventRegistrationInput`.
- Error codes: `REGISTRATION_NOT_PENDING`, `EVENT_FULL`, `EVENT_NOT_BOOKABLE`,
  `APPROVAL_REQUIRES_FREE_EVENT`,
  `EVENT_REGISTRATION_SETTING_INVALID` (a setting that is not true/false) — none retryable.

Requires a Gurb backend with feat/event-guests deployed — that branch adds the `/api/sdk` routes above
(`src/sdk/routes/event-registrations.sdk.routes.ts`) and the four settings on `POST|PATCH /api/sdk/events`.
Do not publish before it is live in production.

## @gurb/server 1.9.0 + @gurb/api-types 1.9.0 (gurb/sdk 1.9.0)

`@gurb/embed` stays at 1.8.0 (unchanged). The PHP SDK ships the same contract as `gurb/sdk` 1.9.0.

### Added — event reminders and content invitations

- `events.sendReminder(eventId, { channels })` → `POST /api/sdk/events/{id}/reminders` — «إرسال تذكير»:
  remind the event's attendees now by `email`, `push` and/or `inApp`. Same permission as Gurb's web app
  (`calendar:manage | calendar:moderate`); one manual reminder per event per 10 minutes.
- `contentInvitations.create({ resourceType, resourceId, inviteeIds, message? })` →
  `POST /api/sdk/content-invitations` and `contentInvitations.listMine(...)` →
  `GET /api/sdk/content-invitations/mine` — «دعوة للمشاهدة» for a blog post, an album or an event.
  Needs the item section's manage or moderate permission (`INSUFFICIENT_PERMISSION` otherwise — regular
  members do not invite); once per invitee per item; 20 per call, 100 per day.
- Types: `ReminderChannel`, `SendEventReminderInput`, `EventReminderResult`, `ContentInviteType`,
  `CreateContentInvitationsInput`, `ContentInviteSkipReason`, `ContentInvitationsResult`.
- Error codes: `EVENT_REMINDER_COOLDOWN`, `EVENT_NOT_REMINDABLE`, `EVENT_ALREADY_STARTED`,
  `EVENT_REMINDER_NO_RECIPIENTS`, `INVITES_DAILY_LIMIT`, `RESTRICTION_BLOCKED` — none retryable, so the
  two 429s no longer read as a generic `RATE_LIMITED` a client would retry.

### Added — reminder audience, invitation channels, four more sections (feat/invite-reminder-audience)

Folded into 1.9.0 because 1.9.0 was never published. Every new field is optional: a 1.9.0 call
written against the first draft behaves the same.

- `sendReminder(eventId, { channels, audience?, userIds?, message? })` — `audience` is `going` (default,
  the confirmed), `interested`, `all` (every approved member) or `members` (the 1–200 `userIds` you
  pick; non-members among them are dropped). `message` (≤ 300) is shown under the reminder. The result
  gains `audience`. New type `ReminderAudience`.
- `contentInvitations.create({ …, channels? })` — `channels` defaults to `['push', 'inApp']`; the result
  gains `channels` and `emailQueued`. `ContentInviteType` gains `tweet`, `project`, `project2`,
  `consultant`.
- Error codes: `INVITE_CHANNEL_INVALID`, `REMINDER_AUDIENCE_INVALID`, `REMINDER_MEMBERS_REQUIRED`,
  `REMINDER_MEMBERS_TOO_MANY`, `REMINDER_MESSAGE_TOO_LONG` (all 400).

Requires a Gurb backend with feat/remind-invite AND feat/invite-reminder-audience deployed — the
second includes the `migrate-widen-content-invitation-types` migration, without which an invitation
to the four new sections is a 500.

## @gurb/server 1.8.0 + @gurb/api-types 1.8.0 (gurb/sdk 1.8.0)

`@gurb/embed` stays at 1.8.0 (unchanged). The PHP SDK ships the same contract as `gurb/sdk` 1.8.0.

### Added — partner events (Gurb Partner Sign-In, events contract v1)

`GurbPartnerEvents` builds and sends the signed events a **host** site uses to keep a Gurb
community in step with its own members: `accessChanged`, `sessionRevoked`, `memberUpdated`,
`memberDeleted`, `snapshot` (split into pages of ≤ 500 under one `snapshot_id`) and `ping`.

- Keyed by the community's **events secret** (`whsec_…`); an API key is refused at construction,
  as the existing clients refuse each other's keys. Two secrets during a rotation.
- Standard Webhooks signing with `node:crypto` — no new dependency. Pinned by a test vector
  produced with the `standardwebhooks` library Gurb's receiver verifies with.
- Build and send are separate on purpose: a built event is plain data for the host's outbox;
  `send()` re-signs with a fresh timestamp and reports `delivered` / `rejected` / `retry`
  without ever retrying itself (the contract puts retries in the host's outbox).
- Builders apply the receiver's own limits and refuse before anything is sent, as every local
  guard does: `GurbApiError` with `VALIDATION_ERROR` and `status: 0`.

### Added — Partner Sign-In error codes

`JOIN_THROUGH_HOST_ONLY`, `HOST_MEMBER_BLOCKED`, `MEMBER_NOT_ACTIVE`, `ACCOUNT_NOT_USABLE`,
`EXTERNAL_IDENTITY_MANUAL_LINK_REQUIRED`, `EXTERNAL_IDENTITY_INVALID_INPUT` are now known
`GurbErrorCode` values.

### Fixed — a refusal whose code is only in `code` mapped to a generic one

Some Gurb errors carry their stable code in `code` rather than `error` (for example
`JOIN_THROUGH_HOST_ONLY` raised from a service). `GurbApiError.code` now reads `error`, then
`code` — still only ever a code this SDK knows.

## @gurb/embed 1.8.0

Browser package only. `@gurb/server` and `@gurb/api-types` are unchanged at 1.7.0,
so the PHP SDK has nothing to match.

### Added — the frame renews an expired session

Gurb now ends a session that a host started with an embed token after 60 minutes,
absolute. When that happens, the Gurb page inside the frame posts
`{ source: 'gurb-embed', type: 'session-expired' }` to its parent, and `mount()`
answers it: it calls your `fetchToken` again and reloads the frame with the new
token. The member sees a short reload, not a sign-in screen.

- One renewal at a time, at most one every 30 seconds, and none after `destroy()`,
  so a host backend that keeps failing cannot cause a loop.
- New option **`onSessionExpired`**: called once when renewal fails (`fetchToken`
  threw, or the new token could not be applied). Use it to show your own
  "sign in again" message.
- The message is accepted only from the mounted iframe on the Gurb origin, like
  every other frame message.

Needs Gurb's server side of the 60-minute session (rolled out with the RIYADAH
integration). Against an older Gurb the frame never sends the message, and nothing
changes.

## 1.6.0

Every section Gurb has, plus the two things that decide who owns what you create.
Matches the PHP SDK's 1.6.0 on the wire.

**The first release published to npm.** Everything below this line was developed in the
repository and never had a package on the registry, so there is no upgrade path to
worry about — install it fresh.

### Added — the sections that were missing

The SDK could read ten sections and write four. It can now write all of them, and
reach three it could not see at all.

- **`groups`, `consultants`, `projects`, `projects2`, `awards`** — `create`,
  `update`, `delete` on each.
- **`tasks`** — a whole section that was absent: `list`, `get`, `create`,
  `update`, `delete`.
- **`comments` and `likes`** — also absent, and the pair that matters most: an
  integration could display a community but nobody could respond to it. Comments
  hang off `tweets`, `blogs`, `albums` and `events`; likes off `tweets`, `blogs`
  and `albums`. Events have no like route in Gurb, so `LikeableParent` has no
  case for one rather than promising something the platform does not do.
- **Customization** — `community.getSettings()` / `updateSettings()`,
  `updateBranding()`, `getLegal()` / `updateLegal()`, plus `sidebar` and
  `advertisements`.

### Added — who founds a community

- **`admin.communities.create({ ownerEmail })`.** By default a community is
  founded by whoever the key acts for, and a platform key can only be minted by a
  super admin — so by default it belongs to the platform admin rather than to
  you. Naming an address makes that account the sole `COMMUNITY_ADMIN`. An
  account is created if none exists; an existing one is reused and never
  modified. `ownerFirstName` / `ownerFamilyName` are used only for a new account.

  Mutually exclusive with `owner`, and sending both is refused before any request
  leaves: they answer the same question two ways and there is no useful behaviour
  for the contradiction.

- **`admin.me()`** — who this key acts for, returning `SdkIdentity`. Call it
  before anything irreversible: if `actsForIssuer` is true, everything you create
  will belong to somebody else. `effectiveOwner()` and `realPhone()` are exported
  alongside it.

### Added — embedding

- **`section: 'community'`** — the community page itself in a frame, navigation
  and all, rather than a single chrome-less pane. Heights now default per shape:
  **900px for a community, 600px for a pane**, because a community at 600px shows
  a navigation bar and little else in the moment before anything resizes, and
  that moment is when someone decides the integration is broken.
- **`gurb.embed.iframe()`** — a plain frame string with no loader script, no CDN
  and nothing to load, for server-rendered pages where a third-party script is
  unwelcome or a CSP forbids one. `mount()` is unchanged and still the right
  choice when you want auto-resize or a token fetched after page load.

### Fixed

- **`gurb.embed.buildUrl()` pointed at a route that does not exist.** It built
  `/embed/{slug}/{section}#t=…`; the page that answers the handshake lives at
  `/embed` and reads a fragment key named `token`. So the URL named a missing
  route *and* a key nothing reads. `@gurb/embed` was corrected in 0.5.x; this is
  the same fix on the server side, and both are now pinned by boundary tests that
  assert the shape rather than the code that produces it.

  `slug` is now **optional and ignored** on both `buildUrl()` and `mount()`,
  kept so existing call sites still compile. The token's server-side envelope
  already carries the communityId, so a slug in the path could only agree with
  it or contradict it. It was still marked *required* on `MountOptions` — a
  mandatory argument that does nothing, which reads as a choice the caller made
  when it is not. Omit it in new code.

- **`examples/host-demo` modelled the same wrong route**, which is exactly why
  the integration suite never caught it. A mock that agrees with your bug proves
  nothing.

### Behaviour worth knowing before you integrate

Every write uses **the same permission Gurb's own web app checks** — never
stricter, never looser — so the requirements differ per section and cannot be
unified. An admin who grants `blogs:create` in the dashboard expects it to mean
the same thing through an integration.

- **A plain member holds none of them.** `MEMBER` is an empty permission set in
  Gurb and publishing is a capability an admin grants, so a key whose owner was
  granted nothing reads everything and publishes nothing. Correct, not a
  misconfiguration.
- **Comments and likes need no permission at all** — membership is the gate. They
  are the exception because they are what an ordinary member does.
- **Update and delete check authorship first.** Your key may always edit what it
  published and needs `*:manage` or `*:moderate` for anyone else's. Group DELETE,
  consultants, awards and tasks have no author branch at all — that asymmetry is
  real upstream and is mirrored rather than smoothed out.
- **Feature gates are not permissions.** A plan lacking a section answers `403
  FEATURE_NOT_AVAILABLE` on every call to it, reads included — including
  `advertisements.listActive()`, the member-facing widget feed that needs no
  permission. That combination has already been misdiagnosed in production.
- **Projects write `name` and read `title`.** Reading a project and posting it
  straight back fails.
- **`tasks.create()` does not accept `status`** — every task starts `PENDING` —
  and the date field is `dueAt`. `title` caps at 40 characters upstream.
- **`sidebar.update()` is a PUT and replaces the whole menu.** The verb is the
  contract; spelling it PATCH would advertise a per-item merge that does not
  exist.
- **Settings updates must send only the keys you mean to change.** The server
  merges deeply for `pageVisibility` only; any other key you include replaces its
  counterpart wholesale. Never round-trip a read blob.
- **Uploads are still unsupported everywhere.** An album is created empty, a
  tweet carries no attachment, and there is no `advertisements.create` at all —
  an ad *is* its image. They need storage-budget accounting this surface does not
  implement, and shipping them without it would let a community exceed the
  storage its plan pays for.

### Not exposed, deliberately

Granting an award (it writes recipient rows and publishes every recipient's
identity in a webhook), task assignment (its notification fan-out lives outside
the service, and one call can address the whole community), project requests (a
different table with a different authorization model), and the platform's own
footer, help and legal pages (public tables with no community column — a
community key writing them would be a cross-tenant write).

## 0.5.0

The server side of bulk membership and embed sessions, and a way to create the
account that owns a community.

### Added

- **`admin.communities.create()` accepts an optional `owner`.** A person your
  identity provider vouches for founds the community, instead of the credential
  that made the call. This is what makes "sign in with Okta, get a community"
  one call instead of an impossible two — there is no public endpoint that mints
  a Gurb account from an e-mail, and there should not be.

  The response carries `owner: { userId, outcome }`. **Branch on `outcome`:**
  `CREATED` means a new passwordless account exists and its owner cannot sign in
  by any route you have not arranged; `LINKED` means an account that already had
  a history is now reachable through your provider, and Gurb has e-mailed its
  owner; `MATCHED` means nothing changed.

- **`members.bulkUpsert()` and `embed.createSession()` now have endpoints
  behind them.** Both were published in 0.2.0 against a server that did not
  implement them. The client shapes are unchanged, so no code needs editing —
  the calls simply stop 404ing.

### The identity rule, stated once

Both new paths bind a person on **(namespace, externalUserId)** and never on
their e-mail address. An e-mail is a label: editable by its owner and recycled by
employers, so keying on it would hand a leaver's account to their replacement.
Keep `externalUserId` stable forever; reusing one for a different human hands
them the first person's account.

An assertion may only attach to an account that ALREADY exists when it comes
from a registered, active provider that you named explicitly — which means only
`admin.communities.create({ owner })`. `bulkUpsert` and `createSession` carry no
provider field, so the authority behind them is your API key alone; a key is not
an e-mail verifier, and those two paths can never link to a pre-existing
account. A row whose e-mail already belongs to somebody comes back in `failed`.

### Behaviour worth knowing before you integrate

- **`bulkUpsert` applies `role` on creation only.** A sync that omits `role`
  would otherwise demote every moderator to MEMBER on its first run, so an
  absent role and `MEMBER` are different things. Sending `role` for an existing
  member is a no-op; the response returns their current role.
- **Banned members are refused, not reinstated** — `failed` with `CONFLICT`. A
  ban is this community's decision about a person and outranks your directory.
- **Members who LEFT are re-admitted.** Note that removal by an admin also
  records `LEFT`, so a removed member returns if your directory still lists
  them. Ban rather than remove when it must stick.
- **No webhook fires for bulk-imported members.** `member.joined` names one
  member and there is no batch event yet, so emitting per row would be a
  notification storm. An integrator mirroring membership will not see these
  until a batch event exists.
- **Bulk-imported members receive no notifications and no auto-assigned tasks or
  awards.** Deliberate: 500 imports must not mean 500 pushes.
- **An embed token is not a JWT.** It is opaque, single-use, ~120s, and asserts
  nothing — a leaked copy reveals no user, community or name. Put it in the URL
  **fragment**, never the query string.

## 0.4.0

Community creation narrowed to what the endpoint actually honours.

### Changed

- **BREAKING — `admin.communities.create()` takes a name and a slug, nothing else.**

  ```ts
  // before
  await admin.communities.create({ name: 'مجتمع', slug: 'club', type: 'PUBLIC', description: '…' })
  // after
  await admin.communities.create({ name: 'مجتمع', slug: 'club' })
  ```

  `description`, `type` and `ownerUserId` were removed rather than accepted and
  ignored. Visibility is decided server-side (always `PRIVATE`; an admin changes
  it in the dashboard when they mean to), and the owner comes from the credential
  so the audit trail names whoever performed the action. A caller who passed
  `type: 'PUBLIC'` and received a private community had been lied to by an API
  that looked like it was listening — an ignored field in a request body is a
  promise nobody is keeping.

- The slug rule is now enforced locally, before any HTTP call: 3–50 characters of
  lowercase letters, digits and hyphens, with no leading, trailing or repeated
  hyphen. A slug that is already taken still comes back from the server as a 400
  `VALIDATION_ERROR` — slugs are unique platform-wide, so that is a normal
  outcome, not a bug.

### Fixed

- `npm run typecheck` now actually type-checks. It ran `tsc -b` against a root
  `tsconfig.json` that was never committed, so it failed immediately on a fresh
  clone with TS5083 and had never verified anything. It now checks each package
  in turn.

## 0.3.0

Every content section the platform serves.

### Added

- `groups`, `consultants`, `projects`, `projects2` and `awards` resources, and a
  real `blogs` listing — eleven sections in total, matching the backend's public
  `/api/sdk` surface.
- Types `Group`, `Consultant`, `Project` and `Award`.

### Notes on two fields that are always null

- **`Consultant.title`** has no backing column. The underlying table models an
  offered *service*, not a person — which is also why `specialties` comes from a
  relation rather than a field. The field stays in the shape so the contract
  need not change when a title column arrives.
- **`Award.awardedAt`** is null because `awards` is the *catalogue* of medals a
  community defines. When a medal was granted belongs to the grant
  (`award_recipients`), not to the definition. Real timestamps need a separate
  `awards/:id/recipients` resource, which would publish member identities and so
  was not added silently.

`Group.isPrivate` is published as a field rather than filtered on: an SDK caller
acts for the community and may legitimately list its private groups. Filtering
would have made the field a constant `false`.

## 0.2.0

Administration, permissions and bulk membership.

### Added

- **`GurbAdminClient`** — platform administration behind a separate credential
  (`gurb_sa_<id>_<secret>`). Create communities, decide on requests, mint and revoke
  community keys. Deliberately a separate class: `communities.create()` should not be
  something you reach by autocompleting from a client you built for reading a feed.
- **Community creation by approval** — `community.requestCreation()` files a request;
  a platform admin approves or rejects it. A rejection reason is required.
- **Per-member permissions** — `members.getPermissions()`, `members.updatePermissions()`
  (grants and revocations in one request), `members.setRole()`.
- **Bulk membership** — `members.bulkUpsert()`, matched on `externalUserId` so a re-run is
  a sync rather than a duplicate import. Row failures are reported, not thrown.
- `LICENSE` (MIT), per-package READMEs, npm publish metadata, and a `prepublishOnly`
  build step.

### Changed

- The two credential shapes are now mutually exclusive and each client rejects the
  other's key at construction with a message naming the mistake.
- HTTP concerns moved into a shared internal transport so authentication, error shaping
  and timeouts cannot drift between the community and admin surfaces.
- Local validation failures now **reject** rather than throwing synchronously. Previously
  the same logical error surfaced in two different shapes depending on which guard
  tripped, so a caller using `.catch()` without a surrounding `try/catch` would crash
  instead of handling it.

### Fixed

- The example mock built its DOM with `innerHTML` and a host-supplied display name — an
  XSS in code a reader might copy. It now builds nodes with `textContent`.

## 0.1.0

Initial public release: typed community client and browser embed.
