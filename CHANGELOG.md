# Changelog

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
