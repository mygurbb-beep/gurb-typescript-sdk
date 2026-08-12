/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from './index.js'

const BASE = 'https://gurb.test'

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>'
})

function postFromFrame(iframe: HTMLIFrameElement, data: unknown, origin = BASE): void {
  window.dispatchEvent(
    new MessageEvent('message', { data, origin, source: iframe.contentWindow }),
  )
}

describe('mounting', () => {
  it('puts the token in the fragment so it never reaches a server log', () => {
    const { iframe } = mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'et_abc', baseUrl: BASE })

    expect(iframe.src).toBe('https://gurb.test/embed/demo/tweets#t=et_abc')
    expect(new URL(iframe.src).search).toBe('')
  })

  it('refuses a secret API key passed where the token goes', () => {
    expect(() =>
      mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'gurb_a1b2c3d4e5f6_secret', baseUrl: BASE }),
    ).toThrow(/secret API key, not an embed token/)
  })

  it('requires one of token or fetchToken, and leaves no orphan iframe when neither is given', () => {
    expect(() => mount({ target: '#host', slug: 'demo', section: 'tweets', baseUrl: BASE })).toThrow(
      /token.*fetchToken/,
    )
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })

  it('accepts a fetchToken callback', async () => {
    const { iframe } = mount({
      target: '#host',
      slug: 'demo',
      section: 'events',
      fetchToken: async () => 'et_late',
      baseUrl: BASE,
    })

    await vi.waitFor(() => expect(iframe.src).toContain('#t=et_late'))
  })

  it('throws when the target does not exist', () => {
    expect(() => mount({ target: '#nope', slug: 'd', section: 'tweets', token: 'et', baseUrl: BASE })).toThrow(
      /not found/,
    )
  })
})

describe('postMessage handling', () => {
  it('ignores a resize from an origin that is not Gurb', () => {
    const { iframe } = mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'et', baseUrl: BASE })

    postFromFrame(iframe, { source: 'gurb-embed', type: 'resize', height: 1200 }, 'https://evil.test')

    expect(iframe.style.height).toBe('600px')
  })

  it('honours a resize from the real frame', () => {
    const { iframe } = mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'et', baseUrl: BASE })

    postFromFrame(iframe, { source: 'gurb-embed', type: 'resize', height: 1200 })

    expect(iframe.style.height).toBe('1200px')
  })

  it('clamps an absurd height instead of letting the frame own the page', () => {
    const { iframe } = mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'et', baseUrl: BASE })

    postFromFrame(iframe, { source: 'gurb-embed', type: 'resize', height: 9_000_000 })

    expect(iframe.style.height).toBe('20000px')
  })

  it('ignores messages that are not ours', () => {
    const onReady = vi.fn()
    const { iframe } = mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'et', baseUrl: BASE, onReady })

    postFromFrame(iframe, { type: 'ready' })
    postFromFrame(iframe, 'ready')

    expect(onReady).not.toHaveBeenCalled()
  })

  it('calls onReady for a well-formed ready message', () => {
    const onReady = vi.fn()
    const { iframe } = mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'et', baseUrl: BASE, onReady })

    postFromFrame(iframe, { source: 'gurb-embed', type: 'ready' })

    expect(onReady).toHaveBeenCalledOnce()
  })
})

describe('destroy', () => {
  it('removes the frame and stops listening', () => {
    const onReady = vi.fn()
    const handle = mount({ target: '#host', slug: 'demo', section: 'tweets', token: 'et', baseUrl: BASE, onReady })
    const iframe = handle.iframe

    handle.destroy()
    postFromFrame(iframe, { source: 'gurb-embed', type: 'ready' })

    expect(document.querySelectorAll('iframe')).toHaveLength(0)
    expect(onReady).not.toHaveBeenCalled()
  })
})
