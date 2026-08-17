# Changelog

## 0.6.0

Every section Gurb has, plus the two things that decide who owns what you create.
Matches the PHP SDK's 1.5.0 on the wire.

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

  `buildUrl()`'s `slug` is now optional and unused, kept so existing call sites
  still compile. The token's server-side envelope already carries the
  communityId, so a slug in the path could only agree or contradict.

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
