/**
 * @gurb/embed — mounts a Gurb community section inside your page.
 *
 * This package is the browser half of the SDK and it is deliberately incapable
 * of holding a secret: the only credential it accepts is a short-lived embed
 * token minted by YOUR backend via `@gurb/server`. There is no `apiKey` option
 * to fill in by mistake.
 */
import { defaultEmbedHeight, type EmbedSection } from '@gurb/api-types'

export type { EmbedSection }

export interface MountOptions {
  /** Where to put the iframe. A CSS selector or the element itself. */
  target: string | HTMLElement
  /**
   * @deprecated Ignored, and safe to delete from your call.
   *
   * It named the community back when the frame URL carried it in the path. It
   * does not any more: the token's server-side envelope already pins the
   * communityId, so the community is decided by the credential. A slug passed
   * alongside could only agree with the token or contradict it, and there is no
   * useful behaviour for the contradiction.
   *
   * Kept as an accepted-and-ignored option only because removing it outright
   * would break every existing call site for no benefit. It is optional, so new
   * code should simply omit it.
   */
  slug?: string
  /** Which single section to render. One section per frame by design. */
  section: EmbedSection
  /**
   * A token from your backend, or a callback that fetches one.
   *
   * Prefer the callback: tokens live ~120 seconds and are single-use, so a
   * token baked into server-rendered HTML is often already dead by the time a
   * user gets to it. The callback lets the frame ask for a fresh one.
   *
   * It is also how a frame RENEWS: a Gurb session started from an embed token
   * ends after 60 minutes (absolute), and the frame then reports
   * `session-expired`. With `fetchToken`, the frame is reloaded with a fresh
   * token automatically — your backend decides again whether this user may
   * still be in the community. With a fixed `token`, `onSessionExpired` (or,
   * failing that, `onError`) is called instead.
   */
  token?: string
  fetchToken?: () => Promise<string>
  /** Gurb origin. Override only for staging. */
  baseUrl?: string
  /**
   * Initial height before the frame reports its own.
   *
   * Defaults PER SHAPE — 900 for a whole community, 600 for a single pane — so
   * that "unspecified" follows what is being embedded. A whole community at
   * 600px shows a navigation bar and little else in the moment before
   * auto-resize lands, and that moment is when someone decides the integration
   * is broken. Passing a number still wins.
   */
  initialHeight?: number
  /** Let the frame drive its own height. Default true. */
  autoResize?: boolean
  onReady?: () => void
  onError?: (error: Error) => void
  /**
   * The frame's Gurb session ended and could not be renewed automatically
   * (no `fetchToken`). Mint a new token and mount again.
   */
  onSessionExpired?: () => void
}

export interface EmbedHandle {
  /** The created iframe, for styling. Do not read its contentWindow — cross-origin. */
  readonly iframe: HTMLIFrameElement
  /** Remove the frame and stop listening. Always call this on unmount. */
  destroy(): void
}

const DEFAULT_BASE_URL = 'https://mygurb.com'

/** See renewSession: a session that expires again this soon is not retried. */
const RENEW_MIN_INTERVAL_MS = 30_000

/** A message from the frame. Anything not matching this shape is ignored. */
interface FrameMessage {
  source: 'gurb-embed'
  type: 'ready' | 'resize' | 'error' | 'session-expired'
  height?: number
  message?: string
}

function resolveTarget(target: string | HTMLElement): HTMLElement {
  const el = typeof target === 'string' ? document.querySelector(target) : target
  if (!el || !(el instanceof HTMLElement)) {
    throw new Error(`Gurb embed: target ${typeof target === 'string' ? target : ''} not found`)
  }
  return el
}

/**
 * Reject anything that looks like a secret.
 *
 * The type signature already has no place to put an API key, but a developer
 * wiring this up quickly may pass one into `token` because both are "the Gurb
 * credential". Catching it here means the key never reaches a URL — failing
 * loudly in development beats a key sitting in a user's browser history.
 */
function assertNotASecret(token: string): void {
  if (token.startsWith('gurb_')) {
    throw new Error(
      'Gurb embed: that is a secret API key, not an embed token. Never send an API key to the browser — mint an embed token on your server with @gurb/server.',
    )
  }
  if (token.length === 0) {
    throw new Error('Gurb embed: empty embed token')
  }
}

export function mount(options: MountOptions): EmbedHandle {
  // `slug` is deliberately not destructured: it is accepted and ignored, and
  // binding it would leave an unused variable that reads like an oversight.
  const {
    section,
    baseUrl = DEFAULT_BASE_URL,
    initialHeight = defaultEmbedHeight(section),
    autoResize = true,
  } = options

  const container = resolveTarget(options.target)
  const origin = new URL(baseUrl).origin

  const iframe = document.createElement('iframe')
  iframe.style.width = '100%'
  iframe.style.height = `${initialHeight}px`
  iframe.style.border = '0'
  iframe.setAttribute('title', `Gurb — ${section}`)
  iframe.setAttribute('loading', 'lazy')
  // Enough to run the app, not enough to navigate the host page away.
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
  )

  const onMessage = (event: MessageEvent): void => {
    // Origin pinning is the whole security boundary on this side: without it
    // any page or frame could post a message we would act on.
    if (event.origin !== origin) return
    if (event.source !== iframe.contentWindow) return

    const data = event.data as FrameMessage | null
    if (!data || typeof data !== 'object' || data.source !== 'gurb-embed') return

    if (data.type === 'resize' && autoResize && typeof data.height === 'number') {
      // Clamp: a hostile or buggy frame should not be able to make the host
      // page scroll for a million pixels.
      const height = Math.min(Math.max(data.height, 120), 20_000)
      iframe.style.height = `${height}px`
      return
    }
    if (data.type === 'ready') {
      options.onReady?.()
      return
    }
    if (data.type === 'error') {
      options.onError?.(new Error(data.message ?? 'Gurb embed failed'))
      return
    }
    if (data.type === 'session-expired') {
      renewSession()
    }
  }

  /**
   * The frame's session reached its fixed end (60 minutes). Ask the host's
   * backend for a new token and reload the frame — the host decides AGAIN
   * whether this user may still be here, which is the whole point of the cap.
   *
   * Two guards. One renewal at a time (a burst of messages is one expiry). And
   * no renewal within RENEW_MIN_INTERVAL_MS of the last one: a fresh session
   * that expires immediately means something is wrong (clock, a revoked user,
   * a broken backend), and looping would hammer the host's token endpoint.
   */
  let renewing = false
  let lastRenewalAt = 0
  let destroyed = false
  let reportedExpiry = false
  const renewSession = (): void => {
    if (destroyed) return
    if (!options.fetchToken) {
      // Said once: with a fixed token nothing here can change until the host
      // mounts again, so repeating it would only spam the callback.
      if (reportedExpiry) return
      reportedExpiry = true
      if (options.onSessionExpired) options.onSessionExpired()
      else options.onError?.(new Error('Gurb embed session expired. Pass fetchToken to renew it automatically.'))
      return
    }
    if (renewing) return
    const now = Date.now()
    if (now - lastRenewalAt < RENEW_MIN_INTERVAL_MS) {
      options.onError?.(new Error('Gurb embed session expired again right after renewal; not retrying.'))
      return
    }
    renewing = true
    lastRenewalAt = now
    options.fetchToken().then(
      (token) => {
        renewing = false
        if (destroyed) return
        try {
          applyToken(token)
        } catch (cause) {
          // e.g. assertNotASecret: the host's fetchToken returned an API key.
          options.onError?.(cause instanceof Error ? cause : new Error(String(cause)))
        }
      },
      (cause: unknown) => {
        renewing = false
        options.onError?.(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  }

  window.addEventListener('message', onMessage)
  container.appendChild(iframe)

  const applyToken = (token: string): void => {
    assertNotASecret(token)

    /**
     * ONE path, and everything else in the fragment.
     *
     * This used to be `/embed/{slug}/{section}#t=…`, and it did not work: the
     * page that answers the handshake lives at `/embed` and reads `token`, so
     * the loader was requesting a route that does not exist and naming the
     * token with a key nothing reads. Both halves had passing tests; neither
     * suite crossed the boundary between them.
     *
     * THE SLUG IS GONE, and that is a simplification rather than a workaround.
     * The token's server-side envelope already carries the communityId — it was
     * pinned when the host minted the session — so the community is determined
     * by the credential, not by a path segment. Passing a slug alongside could
     * only ever agree with the token or contradict it, and there is no useful
     * behaviour for the contradiction.
     *
     * Fragment, not query string: fragments are never sent to the server, so
     * the token stays out of access logs and Referer headers. `section` rides
     * along for the same reason it costs nothing to keep it there.
     */
    const fragment = new URLSearchParams({ token })
    // Omitted entirely for the whole-community frame: absence means "the
    // community home", which is where the page sends an arriving member anyway.
    if (section && section !== 'community') fragment.set('section', section)

    iframe.src = `${baseUrl.replace(/\/+$/, '')}/embed#${fragment.toString()}`
  }

  if (options.token !== undefined) {
    applyToken(options.token)
  } else if (options.fetchToken) {
    options.fetchToken().then(applyToken, (cause: unknown) => {
      options.onError?.(cause instanceof Error ? cause : new Error(String(cause)))
    })
  } else {
    window.removeEventListener('message', onMessage)
    iframe.remove()
    throw new Error('Gurb embed: pass either { token } or { fetchToken }')
  }

  return {
    iframe,
    destroy(): void {
      destroyed = true
      window.removeEventListener('message', onMessage)
      iframe.remove()
    },
  }
}
