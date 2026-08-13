# Changelog

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
