# @gurb/server

Server-side SDK for the [Gurb](https://mygurb.com) community platform.

> ⚠️ **This package holds your secret API key.** It throws if it detects a browser
> environment. For anything running in a user's browser, use [`@gurb/embed`](https://www.npmjs.com/package/@gurb/embed).

```bash
npm install @gurb/server
```

```ts
import { createGurbClient } from '@gurb/server'

const gurb = createGurbClient({ apiKey: process.env.GURB_API_KEY! })

const feed = await gurb.tweets.list({ limit: 20 })

// Mint a short-lived token for one of your logged-in users
const session = await gurb.embed.createSession({
  externalUserId: user.id,
  displayName: user.name,
})
```

Requires Node 20+. Full documentation: https://github.com/mygurbb-beep/gurb-typescript-sdk
