# Gurb TypeScript SDK

Official TypeScript SDK for the [Gurb](https://mygurb.com) community platform.

Two packages, split along the one line that matters: **who is allowed to hold your secret key.**

| Package | Runs in | Holds the API key | Use it for |
|---|---|---|---|
| `@gurb/server` | Node 20+ | yes | Reading your community's data; minting embed sessions |
| `@gurb/embed` | Browser | **never** | Rendering a community section inside your page |
| `@gurb/api-types` | both | — | Shared types |

## Install

```bash
npm install @gurb/server @gurb/embed
```

## Read your community's data (server-side)

```ts
import { createGurbClient } from '@gurb/server'

const gurb = createGurbClient({ apiKey: process.env.GURB_API_KEY! })

const community = await gurb.community.get()
const feed = await gurb.tweets.list({ limit: 20 })
```

The key is pinned to one community — there is no `communityId` argument anywhere, and a key
can never read a community other than the one it was minted for.

## Embed a community section in your site

Three steps, and the middle one is the whole security model: **your backend mints the token,
your browser never sees the key.**

**1. Your backend exposes an endpoint for your own logged-in users:**

```ts
// POST /api/gurb-token  (your app, your auth)
app.post('/api/gurb-token', async (req, res) => {
  const session = await gurb.embed.createSession({
    externalUserId: req.user.id,      // your id for this human, stable forever
    displayName: req.user.name,
  })
  res.json({ token: session.token })
})
```

First time Gurb sees an `externalUserId`, it creates a user and adds them to your community
as a `MEMBER`. After that the same id always resolves to the same person.

**2. Your page mounts the frame:**

```ts
import { mount } from '@gurb/embed'

const embed = mount({
  target: '#community',
  slug: 'my-community',
  section: 'tweets',                  // one section per frame
  fetchToken: () => fetch('/api/gurb-token', { method: 'POST' })
    .then(r => r.json())
    .then(d => d.token),
})

// on unmount
embed.destroy()
```

**3. There is no step three.** Permissions, feature gates, and moderation all apply inside
the frame exactly as they do on mygurb.com, because the embedded user is an ordinary member.

### What you cannot do, on purpose

- **Pass a role.** There is no field for it. Every embedded user is a `MEMBER`. A leaked key
  can create fake members in one community; it can never manufacture a moderator.
- **Log in as an existing Gurb account.** Embedded identities are separate. Otherwise any
  host could claim someone's email and take their account.
- **Send an API key to the browser.** `mount()` rejects any token starting with `gurb_`, and
  `createGurbClient()` throws if it detects a `window`.

## Platform administration

Creating communities and minting keys are **not** things an ordinary integration does, so they
live in a different client with a different credential:

| Client | Key | Can do |
|---|---|---|
| `GurbClient` | `gurb_<id>_<secret>` | One community: read, members, permissions, embed |
| `GurbAdminClient` | `gurb_sa_<id>_<secret>` | The platform: create communities, mint and revoke keys |

The two are **not interchangeable**, and each refuses the other's key at construction:

```ts
createGurbClient({ apiKey: 'gurb_sa_...' })
// → That is a super-admin key, not a community API key. Use GurbAdminClient…
```

That is not politeness. The blast radius differs by orders of magnitude — a leaked community key
creates junk in one community, a leaked admin key can create communities and mint further keys —
so the wrong one must fail loudly at construction, not quietly at the first 403.

```ts
import { createGurbAdminClient } from '@gurb/server'

const admin = createGurbAdminClient({ adminKey: process.env.GURB_ADMIN_KEY! })

const community = await admin.communities.create({ name: 'مجتمع الحرفيين', slug: 'crafts' })

// The plaintext key is in this response and nowhere else, ever.
const key = await admin.apiKeys.create({ communityId: community.id, name: 'zapier' })
console.log(key.key)   // gurb_a1b2…  — hand it over now or mint another
```

Keys default to `['read']`. Ask for `['write']` only when the integration genuinely writes: a
read-only key that leaks is an incident you can close.

## Creating a community by approval

A community key cannot create a community outright. It files a request that a platform admin
decides on — the same gate the dashboard uses:

```ts
const request = await gurb.community.requestCreation({ name: 'مجتمع الحرفيين', slug: 'crafts' })
// request.status === 'PENDING', request.communityId === null

// …later, on the admin side
const approved = await admin.communityRequests.approve(request.id)
// approved.status === 'APPROVED', approved.communityId === 'cmt_…'

await admin.communityRequests.reject(otherId, 'الاسم محجوز لعلامة تجارية')
```

A rejection reason is required, not optional — the requester is shown it, and "rejected" with no
explanation generates a support ticket every time. Approving an already-decided request fails
rather than creating a second community: the decision is what is idempotent, not the click.

## Per-member permissions

Not every member should be able to edit or moderate. A member's abilities come from their role,
plus individual grants and revocations on top of it:

```ts
const perms = await gurb.members.getPermissions('mem_2')
// { role: 'MEMBER', effective: ['CREATE_POST', 'UPLOAD_MEDIA'], granted: [], revoked: [] }

// Let one member run events without making them a moderator
await gurb.members.updatePermissions('mem_2', { grant: ['CREATE_EVENT'] })

// Or take something away that the role would otherwise give
await gurb.members.updatePermissions('mem_2', { revoke: ['CREATE_POST'] })

await gurb.members.setRole('mem_2', 'MODERATOR')
```

Grants and revocations travel in **one** request. Two calls cannot be made atomic from outside,
and a member briefly holding a permission you meant to remove is a real window, not a theoretical
one. Sending the same permission in both lists is rejected rather than silently resolved — there
is no correct guess at what was meant.

`CommunityRole` is `ADMIN | MODERATOR | MEMBER`. `SUPER_ADMIN` is deliberately absent: it is
platform-level, not a community membership, and no API call may ever grant it. Leaving it out of
the type means there is no way to ask for it.

## Bulk members

```ts
const result = await gurb.members.bulkUpsert([
  { externalUserId: 'shop-1', displayName: 'أحمد' },
  { externalUserId: 'shop-2', displayName: 'نورة', email: 'noura@example.com' },
  { externalUserId: 'shop-3', displayName: 'خالد', role: 'MODERATOR' },
])

result.created  // first time
result.updated  // on a re-run — matched on externalUserId, so this is a sync, not a re-import
result.failed   // [{ index: 1, externalUserId: 'shop-2', code: 'VALIDATION_ERROR', message: '…' }]
```

**Row failures do not throw.** One bad email in a list of 500 must not discard the other 499, so
`failed` being empty is the only proof that everything landed. Each failure carries the `index`
from the array you sent, so you can map it back to its input.

Up to 500 per call. Longer lists are rejected locally rather than sent — a request that large is
likely to die at a proxy timeout with no way to know which half landed. A duplicate id inside one
batch is rejected too: it would race against itself server-side and the winner would be arbitrary.

## Errors

Everything throws `GurbApiError` with a stable `code`:

```ts
import { GurbApiError } from '@gurb/server'

try {
  await gurb.blogs.list()
} catch (e) {
  if (e instanceof GurbApiError && e.code === 'FEATURE_NOT_AVAILABLE') {
    // blogs are not on this community's plan
  }
}
```

Messages are English by design — your app owns translation. Unrecognised backend error
strings never leak into `code`, so a `switch` on it will not break when the backend adds one.

## Development

```bash
npm install
npm run build      # @gurb/api-types must build first — the others resolve its types
npm test
```

Design rationale lives in [`docs/specs/2026-08-11-gurb-typescript-sdk-design.md`](docs/specs/2026-08-11-gurb-typescript-sdk-design.md).

## Status

The typed client and the embed mounter are implemented and tested. The two platform endpoints
they call — `POST /api/embed/sessions` and the token exchange behind `/embed/*` — are not
publicly available yet; until they ship, the embed path runs against the stub in `examples/`.
