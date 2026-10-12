# Gurb TypeScript SDK

Official TypeScript SDK for the [Gurb](https://mygurb.com) community platform.

Two packages, split along the one line that matters: **who is allowed to hold your secret key.**

| Package | Runs in | Holds the API key | Use it for |
|---|---|---|---|
| `@gurb/server` | Node 20+ | yes | Reading and writing your community; members; minting embed sessions |
| `@gurb/embed` | Browser | **never** | Rendering a community section inside your page |
| `@gurb/api-types` | both | — | Shared types |

## Install

```bash
npm install @gurb/server @gurb/embed
```

## Read and write your community (server-side)

```ts
import { createGurbClient } from '@gurb/server'

const gurb = createGurbClient({ apiKey: process.env.GURB_API_KEY! })

const community = await gurb.community.get()
const feed = await gurb.tweets.list({ limit: 20 })

await gurb.tweets.create({ content: 'أهلاً بالجميع 👋' })
```

The key is pinned to one community — there is no `communityId` argument anywhere, and a key
can never read a community other than the one it was minted for.

## Publish content

Ten sections are writable — posts, events, blogs, albums, groups, consultants, projects,
projects-2, awards and tasks — plus comments and likes on top of them.

```ts
await gurb.tweets.create({ content: 'أهلاً بالجميع 👋' })
await gurb.events.create({ title: 'Meetup', titleArabic: 'لقاء', startDate: iso, endDate: iso })
await gurb.blogs.create({ title: 'Welcome', contentHtml: '<p>…</p>', status: 'PUBLISHED' })
await gurb.groups.create({ name: 'القراءة', description: 'نادٍ', isPrivate: false, iconUrl })
await gurb.tasks.create({ headingId: 'h1', title: 'راجع الطلبات' })
await gurb.comments.create('tweets', 't1', { content: 'شكراً' })
await gurb.likes.like('tweets', 't1')
```

### The permissions differ per section, and that is on purpose

Every write uses **the same permission Gurb's own web app checks** for that action — never
stricter, never looser. An admin who grants `blogs:create` in the dashboard expects it to mean
the same thing through an integration, and any divergence would make the dashboard's
permission screen a lie. So they cannot be unified:

| Section | Create | Update | Delete |
|---|---|---|---|
| `tweets` | `posts:manage \| posts:create` | those, or **the author** | those, or **the author** |
| `events` | `calendar:manage \| calendar:create` | those, or **the author** | those, or **the author** |
| `blogs` | `blogs:manage \| blogs:create` | those, or **the author** | those, or **the author** |
| `albums` | `albums:manage \| albums:create` | those, or **the author** | those, or **the author** |
| `groups` | `groups:manage \| groups:create` | those + `groups:moderate`, or **the author** | `groups:manage \| groups:moderate` — **no author branch** |
| `consultants` | `consultants:manage` | same | same — no author branch |
| `projects` / `projects2` | `*:manage \| *:create \| *:moderate` | those + `*:edit`, or **the author** | `*:manage \| *:moderate \| *:edit`, or **the author** |
| `awards` | `awards:manage` | same | same — no author branch |
| `tasks` | `tasks:manage` | same | same — no author branch |
| `comments` / `likes` | **none** | author, 15 min | author 30 min, or ADMIN/MODERATOR |
| settings / branding / legal / sidebar / ads | — | `settings:manage \| homepage:customize` (sidebar and ads also accept `homepage:customize` / `ads:manage`) | — |

**A plain member holds none of them.** `MEMBER` resolves to an *empty* permission set in Gurb —
publishing is a capability an admin grants, not one membership confers. So a key whose owner was
granted nothing reads everything and publishes nothing. That is correct behaviour, not a
misconfiguration, and re-minting the key will not change it.

Commenting and liking are the exception, and it is the opposite of the rule: they need **no
permission at all**, because answering is what an ordinary member does. Membership is the whole
gate.

### Editing someone else's content

Where the table says "or the author", authorship is checked **first** — and on this surface the
author is the **key's owner**. So a key can always edit what it published, and needs
`*:manage` / `*:moderate` for anyone else's. Expect 403s against content your key did not create.

### Feature gates are not permissions

Where a section is plan-gated, a community whose plan lacks the flag gets
`403 FEATURE_NOT_AVAILABLE` on **every call in that section, reads included**. No grant fixes it —
it is a billing question, not an admin one. `projects2` adds a second gate, `FEATURE_DISABLED`,
meaning an admin switched the module off. They send you to different people; do not collapse them.

### Uploads are not supported yet

These endpoints are text and JSON only. An album is created empty, a tweet carries no attachment,
a group's `iconUrl` is a URL string rather than a file, and there is **no** `advertisements.create`
at all — an ad *is* its image. Uploads need storage-budget accounting this surface does not
implement, and shipping them without it would let a community silently exceed the storage its plan
pays for.

### Two shapes that will otherwise look like bugs

- **Projects take `name` and return `title`.** The column is `name`; every response calls it
  `title`. Sending `title` sets nothing and the call fails for a missing `name`.
- **`awards.create` defines a medal; it does not give it to anybody.** Granting writes recipient
  rows, can name every member in one call and notifies each of them. That needs its own endpoint,
  not a field.

## Customize the community

```ts
const settings = await gurb.community.getSettings()

await gurb.community.updateSettings({ pageVisibility: { news: false } })
await gurb.community.updateBranding({ primaryColor: '#093431', city: 'الرياض' })
await gurb.community.updateLegal({ terms: 'نص الشروط…' })

await gurb.sidebar.update({ items: menu })          // PUT — replaces the whole menu
await gurb.advertisements.update('ad1', { isActive: false })
```

⚠️ **Never read the settings and write the whole blob back.** The server merges
`{ ...stored, ...yourPatch }` with a deep merge for `pageVisibility` and *nothing else*. Every
other key you send replaces its stored counterpart wholesale — so a read-modify-write round trip
overwrites `homeWidgets`, `widgetConfig` and `guestAccess` with whatever your process happened to
be holding. The response says success. Nobody finds out until a member reports a missing menu.

Two other sharp edges worth knowing before you touch them:

- **`updateLegal({ terms: '' })` is a real instruction** — it restores the platform's standard
  template. An absent field leaves the stored text alone. Conflating the two either ignores a
  deliberate reset or wipes a founder's hand-written terms.
- **`updateBranding({ type })` is not a flag.** PUBLIC → PRIVATE resets the guest-preview opt-in on
  every row of every section, in the same transaction, and flipping back does **not** restore them.

`sidebar.*` and `advertisements.*` are behind the `homepage_widgets` and `ads_management` plan
features **on their reads too** — including `advertisements.listActive()`, the member-facing widget
feed that needs no permission. That combination has already been misdiagnosed in production as a
missing permission; it is an entitlement, and only a plan change fixes it.

## Embed the community in your site

Three steps, and the middle one is the whole security model: **your backend mints the token,
your browser never sees the key.**

### The whole community, or one section

`section: 'community'` frames **the community page itself** — its navigation and every section the
plan enables — exactly as a member sees it after signing in. They land where a normal sign-in puts
them and move around inside the frame. Reach for it when the frame *is* the page.

The others (`tweets`, `events`, `blogs`, `albums`) are chrome-less panes meant to sit inside your
own layout: your header, your navigation, one Gurb panel among your content. They have no menu and
cannot navigate anywhere.

The trade is real. A whole community brings its own scroll height, its own internal routing — your
back button will not follow it — and links that may try to leave the frame. A pane brings none of
that. Heights default accordingly: **900px for a community, 600px for a pane.**

### Gurb must allow your origin to frame it

Framing is refused unless the Gurb deployment sends `Content-Security-Policy: frame-ancestors`
covering your site on the `/embed` path. `X-Frame-Options` cannot express a list of origins,
`ALLOW-FROM` is dead in current browsers, and sending both headers makes browsers ignore the CSP
list entirely — so it must be CSP, and `X-Frame-Options` must be *absent* on that path. If the
frame stays blank with a console message about `X-Frame-Options`, that is server configuration on
Gurb's side, not a bug in your integration.

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

### Three ways to render it

```ts
// (a) The loader, with a fetch callback. Auto-resizes; the token never enters your HTML.
mount({ target: '#community', section: 'community', fetchToken })

// (b) The loader, with a token you already minted this request.
mount({ target: '#community', section: 'community', token })

// (c) A plain iframe string, rendered on your server. No script, no CDN, nothing to load.
res.send(gurb.embed.iframe({ section: 'community', token }))
```

`(a)` is the default choice: tokens live ~120 seconds and are single-use, so one baked into
server-rendered HTML is often already dead by the time a user scrolls to the frame — and a dead
token renders an empty pane with no obvious cause.

`(c)` is the one to reach for when a third-party script on your critical path is unwelcome or your
CSP forbids one. What you give up is auto-resize, so pick a `height` that suits your layout — the
frame will not grow by itself. `gurb.embed.buildUrl({ section, token })` gives you just the URL if
you would rather write the element yourself.

All three put the token in the **URL fragment**, never a query string. A fragment is never
transmitted to a server, so the token stays out of Gurb's access logs, out of yours if you proxy,
and out of the `Referer` header of every outbound link the framed page renders. It is a live
credential; that is the difference between a short-lived secret and a logged one.

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

### Who owns the community you create

By default the community is founded by **whoever the key acts for** — and a platform key can only
be minted by a Gurb super admin, so by default that is the platform admin, not you. Communities
created that way belong to someone else, and nobody notices until they ask why.

Name the owner by e-mail:

```ts
const community = await admin.communities.create({
  name: 'نادي القراءة',
  slug: 'book-club',
  ownerEmail: 'ahmed@corp.com',      // ← this account founds it
  ownerFirstName: 'أحمد',            // only used if the account is new
})
```

That account becomes the community's sole `COMMUNITY_ADMIN`. If it has no Gurb account yet, one is
created; if it already exists it is **reused and never modified** — no password change, no name
overwrite, no role anywhere except inside the community it is about to found. Naming an address
that already belongs to somebody hands them a community; it cannot take their account over.

Ask the platform which account your key acts for **before** you create anything:

```ts
import { effectiveOwner } from '@gurb/server'

const me = await admin.me()
if (me.actsForIssuer) {
  throw new Error('This key names no subject — pass ownerEmail, or ask for a new key.')
}
effectiveOwner(me).email
```

`owner` (a full `ExternalOwner` backed by a registered identity provider) does the same job with a
provider assertion behind it. Send one or the other — both together is refused before any request
leaves, because they answer the same question two ways and there is no useful behaviour for the
contradiction.

### Creating a community takes exactly two fields

`{ name, slug }` plus the optional owner above, and nothing else. There is no `description` and no
`type`, because the endpoint does not honour them: **visibility is decided server-side (PRIVATE).**
Accepting those and dropping them would be worse than not offering them — a caller who passes
`type: 'PUBLIC'`, gets a private community and no error has been lied to by an API that looked like
it was listening.

- **`name`** — the human-facing name, usually Arabic. Trimmed before sending, at most **100
  characters**, counted as characters and not UTF-16 units, so a 100-character Arabic name fits.
- **`slug`** — lowercase letters, digits and hyphens only, **3–50 characters**, no leading or
  trailing hyphen, no consecutive hyphens.

The slug is checked **before any HTTP call**, and the message names the rule you broke rather than
saying "invalid slug":

```ts
await admin.communities.create({ name: 'نادي', slug: 'Book-Club' })
// GurbApiError: Community slugs are lowercase: "Book-Club" is not valid,
// but "book-club" would be. …    (code VALIDATION_ERROR, status 0)
```

Status `0` is the tell: nothing was sent, so nothing was created. Uniqueness is *not* checked
locally — a client cannot know it — so a taken slug still arrives as a `400 VALIDATION_ERROR` from
the server, and that is a normal form error rather than an exceptional condition.

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
// { memberId: 'mem_2', userId: 'usr_9', role: 'MEMBER',
//   effective: [], granted: [], revoked: [] }

// Let one member run events without making them a moderator
await gurb.members.updatePermissions('mem_2', { grant: ['CREATE_EVENT'] })
// → effective: ['CREATE_EVENT'], granted: ['CREATE_EVENT']

// Or take something away that the role would otherwise give
await gurb.members.updatePermissions('mem_2', { revoke: ['CREATE_POST'] })

await gurb.members.setRole('mem_2', 'MODERATOR')
```

**`effective: []` for a plain `MEMBER` is correct, not a failure.** The role resolves to an
*empty* permission set in Gurb — every capability is granted, none is inherited from
membership. An empty array in the console reads like a bug and is the expected answer;
`granted` is where a member's abilities actually come from.

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

## Partner events (Partner Sign-In)

For a **host** site whose members sign in to a Gurb community through it (RIYADAH is the first):
tell Gurb, by signed events, who may still be inside and what their name, email and photo are.
This uses the community's **events secret** (`whsec_…`, handed over by a Gurb super admin) —
a different credential from the API key, and the class refuses an API key.

```ts
import { GurbPartnerEvents } from '@gurb/server'

const events = new GurbPartnerEvents({
  communityId: process.env.GURB_COMMUNITY_ID!,
  secret: process.env.GURB_EVENTS_SECRET!,      // during a rotation: [newest, previous]
  baseUrl: 'https://community.example.com',     // default https://mygurb.com
})

// 1. Build — pure, plain data. Save it in YOUR outbox, in the same DB transaction as the change.
const evt = events.accessChanged({ sub: member.externalId, stateVersion: member.version, access: 'blocked' })
await db.outbox.insert({ id: evt.id, payload: JSON.stringify(evt) })

// 2. Send — from your outbox worker. Never throws for HTTP or network failures.
const result = await events.send(JSON.parse(row.payload))
if (result.outcome === 'delivered') markDelivered(row)          // 2xx: applied, duplicate, stale or unknown member
else if (result.outcome === 'retry') scheduleRetry(row)        // 408/429/5xx/network: back off and try again
else alertHuman(row, result.code)                               // 400/401/403/404: retrying cannot help
```

| Builder | When |
|---|---|
| `accessChanged({ sub, stateVersion, access })` | every change to a member's access (`'allowed'` / `'blocked'`) |
| `sessionRevoked({ sub, stateVersion })` | a password reset or email change ended their login on your side |
| `memberUpdated({ sub, stateVersion, name?, email?, avatarUrl?, locale? })` | a shared identity field changed — **a full replacement**: an omitted email moves the member to a placeholder, an omitted photo removes it |
| `memberDeleted({ sub, stateVersion, requestedAt? })` | an approved erasure request — irreversible |
| `snapshot({ members, snapshotId?, generatedAt?, pageSize? })` | nightly: the FULL list, returned as pages of ≤ 500; send every page |
| `ping({ message? })` | "Test connection" |

What Gurb does with them:

- **Newest `stateVersion` wins** per member, so delivery may be duplicated and out of order. Give
  each member a monotonic version (a change timestamp in ms works).
- **`send()` never retries on its own.** Retries belong to your outbox (back-off for up to 72 h);
  every send re-signs with a fresh timestamp while `id` and body stay identical, so Gurb applies a
  retried event exactly once.
- **The snapshot blocks the absent.** Once every page of one snapshot has arrived, members Gurb
  knows who are missing from it are blocked — so list every member account. If that would block
  more than 10% of them, Gurb blocks nobody and waits for a super admin; a change of more than 1%
  raises an alert on Gurb's side either way.
- **Builders refuse what Gurb would refuse** before anything is sent — the usual local-guard shape,
  `GurbApiError` with `VALIDATION_ERROR` and `status: 0`: an
  empty or over-long `sub`, a negative or fractional version, control characters, a placeholder
  email, a photo that is not `https://` on port 443, a member listed twice in a snapshot.

A member that a host blocked is refused by `embed.createSession` with `HOST_MEMBER_BLOCKED` —
show them "membership inactive", not an error.

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

Partner Sign-In communities add these, mostly from `embed.createSession` and `members.bulkUpsert`:

| `code` | Meaning |
|---|---|
| `JOIN_THROUGH_HOST_ONLY` | the community admits members only through its host site, and this key is not the host's |
| `HOST_MEMBER_BLOCKED` | the host blocked this member — show "membership inactive" |
| `MEMBER_NOT_ACTIVE` | the member was removed or banned in this community |
| `ACCOUNT_NOT_USABLE` | the Gurb account behind the member is deactivated or expired |
| `EXTERNAL_IDENTITY_MANUAL_LINK_REQUIRED` | a concurrent request claimed the same identity — retry once |
| `EXTERNAL_IDENTITY_INVALID_INPUT` | the `externalUserId` or `email` cannot be acted on |

## Development

```bash
npm install
npm run build      # builds @gurb/api-types first — the others resolve its types
npm test
```

Design rationale lives in [`docs/specs/2026-08-11-gurb-typescript-sdk-design.md`](docs/specs/2026-08-11-gurb-typescript-sdk-design.md).

## Status

The typed clients, the error mapping and the embed mounter are implemented and tested. The SDK is
exercised against a stubbed transport in the unit suite and against the reference mock server
(`examples/host-demo/mock-gurb.mjs`) over real HTTP.

This package behaves identically on the wire to the [PHP SDK](https://github.com/mygurbb-beep/gurb-php-sdk).
Both were written against the same route contract, and the shared pieces — the two key patterns,
the `X-Api-Key` header, the `{ success, data }` unwrapping, the 500-row bulk limit, the local
validation messages — are deliberately duplicated rather than approximated, so the two SDKs cannot
disagree about what is valid.

The embed URL shape (`/embed#token=…`, with `section` omitted for a whole community) is the
contract with `app/embed/page.tsx` in the Gurb web app, pinned by boundary tests in **both**
`@gurb/embed` and `@gurb/server`. Changing one requires changing the others in the same commit.
