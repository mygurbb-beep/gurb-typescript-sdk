/**
 * @gurb/embed — mounts a Gurb community section inside your page.
 *
 * This package is the browser half of the SDK and it is deliberately incapable
 * of holding a secret: the only credential it accepts is a short-lived embed
 * token minted by YOUR backend via `@gurb/server`. There is no `apiKey` option
 * to fill in by mistake.
 */
import type { EmbedSection } from '@gurb/api-types'

export type { EmbedSection }

export interface MountOptions {
  /** Where to put the iframe. A CSS selector or the element itself. */
  target: string | HTMLElement
  /** Your community's slug on Gurb. */
  slug: string
  /** Which single section to render. One section per frame by design. */
  section: EmbedSection
  /**
   * A token from your backend, or a callback that fetches one.
   *
   * Prefer the callback: tokens live ~120 seconds and are single-use, so a
   * token baked into server-rendered HTML is often already dead by the time a
   * user gets to it. The callback lets the frame ask for a fresh one.
   */
  token?: string
  fetchToken?: () => Promise<string>
  /** Gurb origin. Override only for staging. */
  baseUrl?: string
  /** Initial height before the frame reports its own. Default 600. */
  initialHeight?: number
  /** Let the frame drive its own height. Default true. */
  autoResize?: boolean
  onReady?: () => void
  onError?: (error: Error) => void
}

export interface EmbedHandle {
  /** The created iframe, for styling. Do not read its contentWindow — cross-origin. */
  readonly iframe: HTMLIFrameElement
  /** Remove the frame and stop listening. Always call this on unmount. */
  destroy(): void
}

const DEFAULT_BASE_URL = 'https://mygurb.com'

/** A message from the frame. Anything not matching this shape is ignored. */
interface FrameMessage {
  source: 'gurb-embed'
  type: 'ready' | 'resize' | 'error'
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
  const {
    slug,
    section,
    baseUrl = DEFAULT_BASE_URL,
    initialHeight = 600,
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
    }
  }

  window.addEventListener('message', onMessage)
  container.appendChild(iframe)

  const applyToken = (token: string): void => {
    assertNotASecret(token)
    // Fragment, not query string: fragments are never sent to the server, so
    // the token stays out of access logs and Referer headers.
    iframe.src = `${baseUrl.replace(/\/+$/, '')}/embed/${encodeURIComponent(slug)}/${section}#t=${encodeURIComponent(token)}`
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
      window.removeEventListener('message', onMessage)
      iframe.remove()
    },
  }
}
