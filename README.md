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
