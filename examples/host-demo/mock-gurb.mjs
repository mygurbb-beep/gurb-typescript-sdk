/**
 * A stand-in for the Gurb backend, implementing exactly the contract the SDK
 * expects. It exists so the embed path can be exercised end to end BEFORE
 * `POST /api/embed/sessions` ships for real — and so this repo's integration
 * test has something honest to talk to over real HTTP.
 *
 * Every rule enforced here is a rule the real backend must also enforce. If you
 * change one, change it in the design spec too.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const KEY_PATTERN = /^gurb_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/
const TOKEN_TTL_MS = 120_000

/** jti -> { expiresAt, userId }. Deleting on use is what makes the token single-use. */
const liveTokens = new Map()
/** externalUserId -> userId. The real thing is the ExternalIdentity table. */
const identities = new Map()

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

export function createMockGurb({ allowedOrigins = ['http://localhost:4099'] } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)

    // ── Mint an embed session ────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/embed/sessions') {
      const key = req.headers['x-api-key']
      if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
        return json(res, 401, { success: false, error: 'INVALID_API_KEY', message: 'Invalid API key' })
      }

      const body = await readBody(req)
      if (!body.externalUserId || !body.displayName) {
        return json(res, 400, {
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'externalUserId and displayName are required',
        })
      }
      // The host cannot elevate anyone. Even if it sends a role, we never read it.
      if ('role' in body) {
        return json(res, 400, {
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'role is not accepted — embedded users are always MEMBER',
        })
      }

      // JIT identity: first sight of an external id creates the member.
      let userId = identities.get(body.externalUserId)
      if (!userId) {
        userId = `usr_${randomUUID().slice(0, 8)}`
        identities.set(body.externalUserId, userId)
      }

      const jti = randomUUID()
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)
      liveTokens.set(jti, { expiresAt: expiresAt.getTime(), userId, displayName: body.displayName })

      return json(res, 200, {
        success: true,
        data: { token: `et_${jti}`, expiresAt: expiresAt.toISOString(), userId },
      })
    }

    // ── Exchange the entry ticket for a real session ─────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/embed/sessions/exchange') {
      // The exchange is called BY THE FRAME, so its Origin is Gurb's own — not
      // the host's. Rejecting anything else keeps a stolen token from being
      // redeemed by a page the customer never registered.
      const origin = req.headers.origin
      const selfOrigin = `http://${req.headers.host}`
      if (origin && origin !== selfOrigin && !allowedOrigins.includes(origin)) {
        return json(res, 403, { success: false, error: 'FORBIDDEN_SURFACE', message: 'Origin not allowed' })
      }

      const { token } = await readBody(req)
      const jti = typeof token === 'string' && token.startsWith('et_') ? token.slice(3) : null
      const record = jti ? liveTokens.get(jti) : undefined

      if (!record) {
        // Covers both "never existed" and "already used" — the caller learns
        // nothing about which, and a replay looks identical to a forgery.
        return json(res, 401, { success: false, error: 'INVALID_API_KEY', message: 'Embed token is invalid or already used' })
      }
      liveTokens.delete(jti)

      if (Date.now() > record.expiresAt) {
        return json(res, 401, { success: false, error: 'INVALID_API_KEY', message: 'Embed token expired' })
      }

      return json(res, 200, {
        success: true,
        data: { sessionToken: `jwt_for_${record.userId}`, userId: record.userId, displayName: record.displayName },
      })
    }

    // ── A community section, rendered chrome-less ────────────────────────────
    const embedMatch = url.pathname.match(/^\/embed\/([^/]+)\/([^/]+)$/)
    if (req.method === 'GET' && embedMatch) {
      const [, slug, section] = embedMatch
      const html = frameHtml(slug, section)
      // Only the registered origins may frame this. Without it, any site could.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `frame-ancestors ${allowedOrigins.join(' ')}`,
        'Access-Control-Allow-Origin': '*',
      })
      return res.end(html)
    }

    json(res, 404, { success: false, error: 'NOT_FOUND', message: 'No such route' })
  })
}

function frameHtml(slug, section) {
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #fff; color: #093431 }
  .post { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px }
  .who { font-weight: 600; font-size: 14px }
  .meta { color: #6b7280; font-size: 12px; margin-bottom: 6px }
  #err { color: #b91c1c }
</style></head>
<body>
  <div id="app">جارٍ التحقق…</div>
  <script>
    // The token arrives in the fragment, which never reached this server.
    const token = new URLSearchParams(location.hash.slice(1)).get('t')
    const app = document.getElementById('app')
    const post = (msg) => parent.postMessage({ source: 'gurb-embed', ...msg }, '*')
    // Measure the CONTENT element, not body or documentElement: those stretch to
    // the iframe's own viewport, so once the host grows the frame the next
    // measurement is at least the new height — it can grow but never shrink.
    //
    // And measure only after a frame has been painted. A measurement taken
    // during load happens at zero width, every line wraps, and the height comes
    // back two or three times too large — which looks like a resize bug and is
    // really a timing bug.
    const reportHeight = () =>
      requestAnimationFrame(() => {
        if (app.getBoundingClientRect().width === 0) return
        post({ type: 'resize', height: Math.ceil(app.getBoundingClientRect().height) + 32 })
      })

    // Content can change height after first paint (images, fonts, new posts).
    new ResizeObserver(reportHeight).observe(app)

    fetch('/api/embed/sessions/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!ok) throw new Error(b.message || 'exchange failed')
        const name = b.data.displayName
        app.innerHTML =
          '<p class="meta">أنت داخل قسم <strong>' + ${JSON.stringify(section)} +
          '</strong> لمجتمع <strong>' + ${JSON.stringify(slug)} + '</strong> باسم <strong>' + name + '</strong></p>' +
          ['أهلاً بالجميع في المجتمع 👋', 'تم نشر جدول الفعاليات القادمة', 'تذكير: اجتماع الأعضاء يوم الخميس']
            .map((t, i) => '<div class="post"><div class="who">عضو ' + (i + 1) +
              '</div><div class="meta">قبل ' + (i + 1) + ' ساعات</div><div>' + t + '</div></div>').join('')
        post({ type: 'ready' })
        reportHeight()
      })
      .catch((e) => {
        app.innerHTML = '<p id="err">تعذّر الدخول: ' + e.message + '</p>'
        post({ type: 'error', message: e.message })
        reportHeight()
      })
  </script>
</body></html>`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMockGurb().listen(5099, () => console.log('mock Gurb  → http://localhost:5099'))
}
