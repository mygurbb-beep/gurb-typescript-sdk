/**
 * "The customer's own website."
 *
 * The only thing worth studying here is the shape of /api/gurb-token: the key
 * lives in this process, the browser gets a token that dies in 120 seconds, and
 * the customer's own login is what decides who gets one.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createGurbClient } from '@gurb/server'

const here = dirname(fileURLToPath(import.meta.url))

const GURB_URL = process.env.GURB_URL ?? 'http://localhost:5099'
// Demo key. A real one is minted from the community dashboard and lives in an env var.
const API_KEY = process.env.GURB_API_KEY ?? `gurb_a1b2c3d4e5f6_${'d'.repeat(43)}`

const gurb = createGurbClient({ apiKey: API_KEY, baseUrl: GURB_URL })

/** Pretend this came from the host site's own session cookie. */
const currentUser = { id: 'shop-user-42', name: 'سارة العتيبي' }

export function createHostServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)

    if (req.method === 'POST' && url.pathname === '/api/gurb-token') {
      try {
        const session = await gurb.embed.createSession({
          externalUserId: currentUser.id,
          displayName: currentUser.name,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ token: session.token }))
      } catch (error) {
        // Never forward the SDK error verbatim: it can name the community and
        // the key's state, and this response goes to a browser.
        res.writeHead(502, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Could not start the community session' }))
      }
    }

    if (url.pathname === '/gurb-embed.js') {
      const js = await readFile(join(here, '../../packages/embed/dist/index.global.js'))
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      return res.end(js)
    }

    if (url.pathname === '/') {
      const html = (await readFile(join(here, 'index.html'), 'utf8')).replace('__GURB_URL__', GURB_URL)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    res.writeHead(404).end('Not found')
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createHostServer().listen(4099, () => console.log('host site  → http://localhost:4099'))
}
