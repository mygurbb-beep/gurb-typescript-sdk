# Gurb TypeScript SDK — Design

**Date:** 2026-08-11
**Status:** Design approved, v1 in progress
**Repo:** `gurb-typescript-sdk` (new, standalone)

## Problem

A Gurb community admin wants to put their community inside their own website. Today the only
options are sending users to `mygurb.com` (they leave the site, they log in again) or the
marketing badge in `src/widget/` (branding + member count, no identity, no content).

There is also no way for that admin to read their community's data programmatically.

## Scope of v1

Deliberately narrow. Each of these was a decision, not an omission:

| Decision | Choice | Why |
|---|---|---|
| Who holds the secret key | A single community's admin | One key, one `communityId`. A leaked key damages one community, never an account or the platform. |
| Which user types cross the boundary | Only "logged-in user of the host site" | Anonymous browsing already has a home (guest preview). Linking a *pre-existing* Gurb account is the one path where a compromised host can steal a real account — excluded on purpose. |
| What the iframe renders | One section, chosen by the host | A chrome-less feed/events/blogs pane composes into the host's own layout. Full-app-in-a-frame drags in scroll height, internal routing, and links escaping the frame. |
| Type generation | Hand-written for the v1 surface | The v1 surface is ~8 endpoints. Generating from the existing `swagger-jsdoc` spec means first curating that spec — backend work we do not own. Migration path documented below. |

Out of scope for v1: anonymous embeds, moderator/admin roles through the frame, account
linking, write endpoints beyond posting to the embedded section, PHP SDK.

## Backend dependency

This SDK sits on top of a community-scoped API key system (`gurb_<id>_<secret>`) that is
being built in `rootnex_backend` by a separate workstream. **This repo does not modify the
backend.** The contract we consume:

- `X-Api-Key: gurb_...` authenticates a request and pins it to one `communityId`.
- The key's authority never exceeds the live `CommunityMember.role` of the admin who minted it.
- Read/write scopes are enforced by HTTP method server-side.

Two endpoints do not exist yet and are specified here as the SDK's requirement:

```
POST /api/embed/sessions        (X-Api-Key)  → mints a short-lived embed token
POST /api/embed/sessions/exchange (embed token) → returns a normal session JWT
```

Until they ship, `@gurb/server`'s embed methods are exercised against a mocked transport.

## Embed trust model

The host's backend holds the key. The host's browser never does.

```
host backend --[X-Api-Key + {externalUserId, name}]--> POST /api/embed/sessions
                                                        │ resolve or JIT-create identity
                                                        │ ensure CommunityMember(MEMBER)
             <--[{token, expiresAt}]---------------------┘
host page: <iframe src="https://mygurb.com/embed/{slug}/{section}#t={token}">
iframe bootstrap: exchange token once ──> normal session JWT ──> every existing guard applies
```

**Why a minted token and not OAuth:** the client here is the host's *backend*, which already
holds a secret we issued. OAuth's redirect dance exists to establish trust with a client we
cannot trust; that problem is already solved. Building an authorization server (consent UI,
code store, client registry) buys nothing.

**Why not cookie SSO:** the web app authenticates with a bearer token from localStorage, not
cookies. Safari ITP and third-party-cookie partitioning break cookies inside a cross-origin
iframe; a bearer token held in the frame's own JS is unaffected.

Token rules — each one closes a specific hole:

- **URL fragment, never query string.** Fragments are not sent to the server, so the token
  never lands in nginx access logs, `Referer` headers, or the host's analytics.
- **TTL ≤ 120s, single-use `jti`.** A token that leaks is already expired; a token replayed
  is rejected.
- **`aud: "embed"`.** The embed token is accepted by exactly one endpoint (the exchange).
  It is an entry ticket, not an API credential.
- **`allowedOrigins` on the key** drives `Content-Security-Policy: frame-ancestors` on
  `/embed/*`, `postMessage` origin pinning in `@gurb/embed`, and `Origin` validation on the
  exchange call.

**Identity mapping.** A new public-schema table `ExternalIdentity` maps
`(communityId, externalUserId) → User.id`, unique on the pair, modelled on `UserOAuthAccount`.
The host's user id is opaque to us. First sight of an id creates a `User` and a
`CommunityMember` with role `MEMBER` — the same just-in-time provisioning the Zid OAuth flow
already runs in production. Every downstream permission check, feature gate, and moderation
rule then works unchanged, because the durable record is an ordinary member row.

The host cannot pass a role. There is no field for it.

## Repo shape

npm workspaces monorepo. Three packages, split so that leaking the key requires importing a
package you have no reason to import in a browser bundle:

```
packages/
  types/    @gurb/api-types  — shared response/request types. No runtime code.
  server/   @gurb/server     — Node only. Holds the API key. Typed API client + embed mint.
  embed/    @gurb/embed      — Browser only. Accepts an embed token. Never an API key.
```

Three layers keep the key out of the browser:

1. Separate package — a bundler cannot tree-shake its way into shipping it.
2. `exports` map with no `browser` condition.
3. `GurbClient`'s constructor throws when `typeof window !== 'undefined'`.

And `@gurb/embed`'s public types cannot *express* an API key: `mount()` takes a `token`
string or a `fetchToken` callback that hits the host's own backend. There is no `apiKey`
field to fill in by mistake.

Build with `tsup` (ESM + CJS + `.d.ts`), test with `vitest`, version with `changesets`.
`@gurb/embed` also ships a UMD build for hosts that do not use npm.

## Type surface (v1)

Hand-written in `@gurb/api-types`, covering what v1 actually exposes: community profile,
tweets, events, blogs, albums, members, plus the embed session shapes.

Migration to generation is a two-step, both in the backend repo and neither in ours:
tag SDK-exposed routes in their JSDoc, emit a curated `openapi.public.json` artifact, then
gate it in CI exactly like `check:webhook-orphans` gates event names. At that point this
package's contents are replaced by `openapi-typescript` output and the hand-written types
are deleted. Types only — full client codegen produces poor ergonomics and fights us on auth
injection and error shapes.

## Error handling

One error class, `GurbApiError`, carrying `status`, `code`, and `requestId`. Backend error
messages are English with stable codes by project convention; the SDK never translates them.
Network and parse failures surface as `GurbApiError` with `code: 'NETWORK_ERROR'` so a
consumer has exactly one thing to catch.

The key-shape check happens in the constructor, not on first request — an integrator who
pasted a JWT gets told immediately instead of at 401 time.

## Testing

- `@gurb/server`: key validation, browser-guard, header injection, error mapping, embed
  session request shape — against a stubbed `fetch`, no network.
- `@gurb/embed`: iframe src uses a fragment not a query string, `postMessage` from an
  unregistered origin is ignored, resize messages are honoured, token is never placed in a
  logged position.
- `examples/host-demo`: a minimal host page proving the full slice once the backend endpoints exist.

## First vertical slice

API key → `createEmbedSession()` for one host user → iframe renders that community's tweet
feed as that member. One demo exercises key auth, identity mapping, token exchange, and
framing policy at once.
