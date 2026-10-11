# @gurb/embed

Mounts a [Gurb](https://mygurb.com) community section inside your page.

This package cannot hold a secret. The only credential it accepts is a short-lived
embed token minted by **your** backend with
[`@gurb/server`](https://www.npmjs.com/package/@gurb/server) — there is no `apiKey`
option to fill in by mistake.

```bash
npm install @gurb/embed
```

```ts
import { mount } from '@gurb/embed'

const embed = mount({
  target: '#community',
  section: 'tweets',
  fetchToken: () => fetch('/api/gurb-token', { method: 'POST' })
    .then(r => r.json())
    .then(d => d.token),
})

embed.destroy() // on unmount
```

When a host-started session reaches its 60-minute limit, the frame asks for a new
token: `fetchToken` is called again and the frame reloads on its own. If that
fails, `onSessionExpired` is called once:

```ts
mount({
  // ...
  onSessionExpired: () => showSignInAgainMessage(),
})
```

Also available as a UMD build for pages that do not use npm:

```html
<script src="https://unpkg.com/@gurb/embed"></script>
<script>GurbEmbed.mount({ /* ... */ })</script>
```

Full documentation: https://github.com/mygurbb-beep/gurb-typescript-sdk
