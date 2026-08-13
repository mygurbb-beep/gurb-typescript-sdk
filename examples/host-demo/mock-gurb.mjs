/**
 * A stand-in for the Gurb backend, implementing exactly the contract the SDK
 * expects. It exists so the whole surface can be exercised end to end BEFORE
 * the real endpoints ship — and so this repo's integration tests have something
 * honest to talk to over real HTTP.
 *
 * Every rule enforced here is a rule the real backend must also enforce. If you
 * change one, change it in the design spec too. In particular the authority
 * rules — which key may call which route, and what a role may grant — are the
 * security model, not fixture convenience.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const COMMUNITY_KEY_PATTERN = /^gurb_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/
const ADMIN_KEY_PATTERN = /^gurb_sa_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}$/
const TOKEN_TTL_MS = 120_000
const BULK_LIMIT = 500

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Fixed sample data. The shapes match `@gurb/api-types` exactly, so anything
 * you write against this mock keeps compiling against the real API.
 */
const FIXTURES = {
  community: {
    id: 'cmt_demo',
    slug: 'demo',
    name: 'مجتمع المتجر',
    description: 'مساحة نتحدث فيها عن الجديد، ونجيب أسئلتكم، ونشارك ما نعمل عليه.',
    logoUrl: null,
    bannerUrl: null,
    type: 'PUBLIC',
    memberCount: 128,
    createdAt: '2026-01-15T09:00:00.000Z',
  },
  tweets: [1, 2, 3, 4, 5].map((n) => ({
    id: `twt_${n}`,
    content: ['أهلاً بالجميع في المجتمع', 'تم نشر جدول الفعاليات القادمة', 'تذكير: اجتماع الأعضاء يوم الخميس', 'صور اللقاء الأخير متاحة الآن', 'نرحب بالأعضاء الجدد'][n - 1],
    author: { userId: `usr_${n}`, displayName: `عضو ${n}`, avatarUrl: null },
    imageUrls: [],
    likeCount: n * 3,
    commentCount: n,
    createdAt: `2026-08-0${n}T10:00:00.000Z`,
    editedAt: null,
  })),
  events: [1, 2].map((n) => ({
    id: `evt_${n}`,
    title: ['اجتماع الأعضاء', 'ورشة عمل'][n - 1],
    description: null,
    location: 'الرياض',
    coverUrl: null,
    startsAt: `2026-09-0${n}T17:00:00.000Z`,
    endsAt: null,
    attendeeCount: n * 12,
  })),
  albums: [
    { id: 'alb_1', title: 'اللقاء السنوي', description: null, coverUrl: null, photoCount: 24, createdAt: '2026-07-01T08:00:00.000Z' },
  ],
}

/**
 * What each role grants. The real catalogue is larger; this is the shape, and
 * the important part is that it is a HAND-CURATED list per role rather than
 * "everything" — a permission added to the platform is not silently handed to
 * every admin.
 */
const ROLE_PERMISSIONS = {
  ADMIN: [
    'CREATE_POST', 'EDIT_ANY_POST', 'DELETE_ANY_POST',
    'CREATE_EVENT', 'EDIT_ANY_EVENT', 'DELETE_ANY_EVENT',
    'CREATE_BLOG', 'EDIT_ANY_BLOG', 'DELETE_ANY_BLOG',
    'CREATE_ALBUM', 'EDIT_ANY_ALBUM', 'DELETE_ANY_ALBUM',
    'UPLOAD_MEDIA', 'INVITE_MEMBERS', 'REMOVE_MEMBERS', 'APPROVE_JOIN_REQUESTS',
    'ASSIGN_ROLES', 'MANAGE_PERMISSIONS', 'MODERATE_CONTENT', 'RESTRICT_MEMBERS',
    'VIEW_REPORTS', 'EDIT_COMMUNITY_SETTINGS', 'MANAGE_API_KEYS', 'VIEW_ANALYTICS',
  ],
  MODERATOR: [
    'CREATE_POST', 'EDIT_ANY_POST', 'DELETE_ANY_POST',
    'CREATE_EVENT', 'UPLOAD_MEDIA', 'INVITE_MEMBERS',
    'APPROVE_JOIN_REQUESTS', 'MODERATE_CONTENT', 'RESTRICT_MEMBERS', 'VIEW_REPORTS',
  ],
  MEMBER: ['CREATE_POST', 'UPLOAD_MEDIA'],
}

const ROLE_RANK = { MEMBER: 0, MODERATOR: 1, ADMIN: 2 }

// ─── Mutable state ───────────────────────────────────────────────────────────

const liveTokens = new Map() // jti -> { expiresAt, userId, displayName }
const identities = new Map() // externalUserId -> memberId
const members = new Map() // memberId -> Member
const requests = new Map() // requestId -> CommunityRequest
const communities = new Map([[FIXTURES.community.id, FIXTURES.community]])
const apiKeys = new Map() // keyId -> ApiKeySummary
const overrides = new Map() // memberId -> { granted:Set, revoked:Set }

for (const n of [1, 2, 3]) {
  const memberId = `mem_${n}`
  members.set(memberId, {
    userId: `usr_${n}`,
    memberId,
    displayName: `عضو ${n}`,
    avatarUrl: null,
    role: n === 1 ? 'ADMIN' : 'MEMBER',
    joinedAt: `2026-0${n}-10T12:00:00.000Z`,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

const fail = (res, status, error, message) => json(res, status, { success: false, error, message })

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

function paginate(rows, url) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
  const start = (page - 1) * limit
  return {
    items: rows.slice(start, start + limit),
    page,
    limit,
    total: rows.length,
    hasMore: start + limit < rows.length,
  }
}

function effectivePermissions(member) {
  const override = overrides.get(member.memberId) ?? { granted: new Set(), revoked: new Set() }
  const base = new Set(ROLE_PERMISSIONS[member.role])
  for (const p of override.granted) base.add(p)
  for (const p of override.revoked) base.delete(p)
  return {
    memberId: member.memberId,
    userId: member.userId,
    role: member.role,
    effective: [...base].sort(),
    granted: [...override.granted].sort(),
    revoked: [...override.revoked].sort(),
  }
}

/**
 * Which key is calling, and is it the right kind for this route?
 *
 * Returning a discriminated answer rather than a boolean is what lets each
 * route refuse the *other* credential with a specific message instead of a
 * generic 401 that sends an integrator to debug the wrong thing.
 */
function identify(req) {
  const key = req.headers['x-api-key']
  if (typeof key !== 'string') return { kind: 'none' }
  if (ADMIN_KEY_PATTERN.test(key)) return { kind: 'admin', key }
  if (COMMUNITY_KEY_PATTERN.test(key)) return { kind: 'community', key }
  return { kind: 'malformed' }
}

// ─── Server ──────────────────────────────────────────────────────────────────

export function createMockGurb({ allowedOrigins = ['http://localhost:4099'] } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname
    const caller = identify(req)

    // ── Embed: mint a session ────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/embed/sessions') {
      if (caller.kind !== 'community') {
        return fail(res, 401, 'INVALID_API_KEY', 'A community API key is required')
      }

      const body = await readBody(req)
      if (!body.externalUserId || !body.displayName) {
        return fail(res, 400, 'VALIDATION_ERROR', 'externalUserId and displayName are required')
      }
      // The host cannot elevate anyone. Even if it sends a role, we never read it.
      if ('role' in body) {
        return fail(res, 400, 'VALIDATION_ERROR', 'role is not accepted — embedded users are always MEMBER')
      }

      const member = upsertMember({ externalUserId: body.externalUserId, displayName: body.displayName })
      const jti = randomUUID()
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)
      liveTokens.set(jti, { expiresAt: expiresAt.getTime(), userId: member.userId, displayName: member.displayName })

      return json(res, 200, {
        success: true,
        data: { token: `et_${jti}`, expiresAt: expiresAt.toISOString(), userId: member.userId },
      })
    }

    // ── Embed: exchange the entry ticket ─────────────────────────────────────
    if (req.method === 'POST' && path === '/api/embed/sessions/exchange') {
      // The exchange is called BY THE FRAME, so its Origin is Gurb's own — not
      // the host's. Rejecting anything else keeps a stolen token from being
      // redeemed by a page the customer never registered.
      const origin = req.headers.origin
      const selfOrigin = `http://${req.headers.host}`
      if (origin && origin !== selfOrigin && !allowedOrigins.includes(origin)) {
        return fail(res, 403, 'FORBIDDEN_SURFACE', 'Origin not allowed')
      }

      const { token } = await readBody(req)
      const jti = typeof token === 'string' && token.startsWith('et_') ? token.slice(3) : null
      const record = jti ? liveTokens.get(jti) : undefined

      if (!record) {
        // Covers both "never existed" and "already used" — a replay is
        // indistinguishable from a forgery, which is the point.
        return fail(res, 401, 'INVALID_API_KEY', 'Embed token is invalid or already used')
      }
      liveTokens.delete(jti)

      if (Date.now() > record.expiresAt) {
        return fail(res, 401, 'INVALID_API_KEY', 'Embed token expired')
      }

      return json(res, 200, {
        success: true,
        data: { sessionToken: `jwt_for_${record.userId}`, userId: record.userId, displayName: record.displayName },
      })
    }

    // ── Platform administration ──────────────────────────────────────────────
    if (path.startsWith('/api/admin/sdk/')) {
      if (caller.kind === 'community') {
        // The single most important rule in this file: a community key must not
        // reach an admin route, and must be told why rather than getting a
        // generic 401 it will misread as "my key is wrong".
        return fail(res, 403, 'FORBIDDEN_SURFACE', 'A community API key cannot perform platform administration')
      }
      if (caller.kind !== 'admin') {
        return fail(res, 401, 'INVALID_API_KEY', 'A super-admin key is required')
      }
      return handleAdmin(req, res, url, path.slice('/api/admin/sdk/'.length))
    }

    // ── Community surface ────────────────────────────────────────────────────
    if (path.startsWith('/api/sdk/')) {
      if (caller.kind === 'admin') {
        return fail(res, 403, 'FORBIDDEN_SURFACE', 'A super-admin key has no community context; mint a community key instead')
      }
      if (caller.kind !== 'community') {
        return fail(res, 401, 'INVALID_API_KEY', 'Invalid API key')
      }
      return handleCommunity(req, res, url, path.slice('/api/sdk/'.length))
    }

    // ── The framed page ──────────────────────────────────────────────────────
    const embedMatch = path.match(/^\/embed\/([^/]+)\/([^/]+)$/)
    if (req.method === 'GET' && embedMatch) {
      const [, slug, section] = embedMatch
      // Only the registered origins may frame this. Without it, any site could.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `frame-ancestors ${allowedOrigins.join(' ')}`,
        'Access-Control-Allow-Origin': '*',
      })
      return res.end(frameHtml(slug, section))
    }

    fail(res, 404, 'NOT_FOUND', 'No such route')
  })
}

// ─── Community routes ────────────────────────────────────────────────────────

function upsertMember({ externalUserId, displayName, email, role = 'MEMBER' }) {
  const existingId = identities.get(externalUserId)
  if (existingId) {
    const member = members.get(existingId)
    const updated = { ...member, displayName, ...(email ? { email } : {}), role }
    members.set(existingId, updated)
    return updated
  }
  const memberId = `mem_${randomUUID().slice(0, 8)}`
  const member = {
    userId: `usr_${randomUUID().slice(0, 8)}`,
    memberId,
    displayName,
    avatarUrl: null,
    role,
    joinedAt: new Date().toISOString(),
  }
  identities.set(externalUserId, memberId)
  members.set(memberId, member)
  return member
}

async function handleCommunity(req, res, url, route) {
  const { method } = req

  if (method === 'GET' && route === 'community') {
    return json(res, 200, { success: true, data: FIXTURES.community })
  }

  // Stands in for a module the community's plan does not include, so error
  // handling is something you can actually try rather than read about.
  if (method === 'GET' && route === 'blogs') {
    return json(res, 403, {
      success: false,
      error: 'FEATURE_NOT_AVAILABLE',
      message: "Blogs are not enabled on this community's plan",
      requestId: 'req_demo_403',
    })
  }

  if (method === 'GET' && (route === 'tweets' || route === 'events' || route === 'albums')) {
    return json(res, 200, { success: true, data: paginate(FIXTURES[route], url) })
  }

  // ── Community creation requests ────────────────────────────────────────────

  if (method === 'POST' && route === 'community-requests') {
    const body = await readBody(req)
    if (!body.name || !body.slug) {
      return fail(res, 400, 'VALIDATION_ERROR', 'name and slug are required')
    }
    if ([...communities.values()].some((c) => c.slug === body.slug)) {
      return fail(res, 400, 'VALIDATION_ERROR', `The slug "${body.slug}" is already taken`)
    }

    const request = {
      id: `creq_${randomUUID().slice(0, 8)}`,
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
      status: 'PENDING',
      requestedByUserId: 'usr_requester',
      decidedByUserId: null,
      decidedAt: null,
      rejectionReason: null,
      communityId: null,
      createdAt: new Date().toISOString(),
    }
    requests.set(request.id, request)
    return json(res, 201, { success: true, data: request })
  }

  if (method === 'GET' && route === 'community-requests') {
    const status = url.searchParams.get('status')
    const rows = [...requests.values()].filter((r) => !status || r.status === status)
    return json(res, 200, { success: true, data: paginate(rows, url) })
  }

  if (method === 'GET' && route.startsWith('community-requests/')) {
    const request = requests.get(route.slice('community-requests/'.length))
    if (!request) return fail(res, 404, 'NOT_FOUND', 'No such request')
    return json(res, 200, { success: true, data: request })
  }

  // ── Members ────────────────────────────────────────────────────────────────

  if (method === 'GET' && route === 'members') {
    const role = url.searchParams.get('role')
    const rows = [...members.values()].filter((m) => !role || m.role === role)
    return json(res, 200, { success: true, data: paginate(rows, url) })
  }

  if (method === 'POST' && route === 'members/bulk') {
    const body = await readBody(req)
    const rows = Array.isArray(body.members) ? body.members : []

    if (rows.length === 0) return fail(res, 400, 'VALIDATION_ERROR', 'members must be a non-empty array')
    if (rows.length > BULK_LIMIT) {
      return fail(res, 400, 'VALIDATION_ERROR', `At most ${BULK_LIMIT} members per call`)
    }

    const created = []
    const updated = []
    const failed = []

    rows.forEach((row, index) => {
      // One bad row must not discard the batch — that is the whole contract of
      // a bulk endpoint. Collect the failure and keep going.
      if (!row?.externalUserId || !row?.displayName) {
        failed.push({
          index,
          externalUserId: row?.externalUserId ?? '',
          code: 'VALIDATION_ERROR',
          message: 'externalUserId and displayName are required',
        })
        return
      }
      if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) {
        failed.push({ index, externalUserId: row.externalUserId, code: 'VALIDATION_ERROR', message: `Invalid email: ${row.email}` })
        return
      }
      if (row.role && !(row.role in ROLE_RANK)) {
        failed.push({ index, externalUserId: row.externalUserId, code: 'VALIDATION_ERROR', message: `Unknown role: ${row.role}` })
        return
      }

      const existed = identities.has(row.externalUserId)
      const member = upsertMember(row)
      ;(existed ? updated : created).push(member)
    })

    return json(res, 200, { success: true, data: { created, updated, failed, total: rows.length } })
  }

  const memberRoute = route.match(/^members\/([^/]+)(?:\/(role|permissions))?$/)
  if (memberRoute) {
    const [, memberId, sub] = memberRoute
    const member = members.get(memberId)
    if (!member) return fail(res, 404, 'NOT_FOUND', 'No such member')

    if (method === 'GET' && !sub) return json(res, 200, { success: true, data: member })

    if (method === 'DELETE' && !sub) {
      members.delete(memberId)
      return json(res, 200, { success: true, data: null })
    }

    if (method === 'PATCH' && sub === 'role') {
      const { role } = await readBody(req)
      if (!(role in ROLE_RANK)) {
        return fail(res, 400, 'VALIDATION_ERROR', `Unknown role: ${role}`)
      }
      // A community key acts as an ADMIN here; the real backend derives this
      // from the live CommunityMember row of whoever minted the key, which is
      // what makes a key stop working when its owner is demoted.
      const updated = { ...member, role }
      members.set(memberId, updated)
      return json(res, 200, { success: true, data: updated })
    }

    if (method === 'GET' && sub === 'permissions') {
      return json(res, 200, { success: true, data: effectivePermissions(member) })
    }

    if (method === 'PATCH' && sub === 'permissions') {
      const { grant = [], revoke = [] } = await readBody(req)
      const conflicting = grant.filter((p) => revoke.includes(p))
      if (conflicting.length > 0) {
        return fail(res, 400, 'VALIDATION_ERROR', `Cannot grant and revoke the same permission: ${conflicting.join(', ')}`)
      }

      const unknown = [...grant, ...revoke].filter((p) => !ROLE_PERMISSIONS.ADMIN.includes(p))
      if (unknown.length > 0) {
        return fail(res, 400, 'VALIDATION_ERROR', `Unknown permission(s): ${unknown.join(', ')}`)
      }

      const current = overrides.get(memberId) ?? { granted: new Set(), revoked: new Set() }
      for (const p of grant) {
        current.granted.add(p)
        current.revoked.delete(p)
      }
      for (const p of revoke) {
        current.revoked.add(p)
        current.granted.delete(p)
      }
      overrides.set(memberId, current)

      return json(res, 200, { success: true, data: effectivePermissions(members.get(memberId)) })
    }
  }

  fail(res, 404, 'NOT_FOUND', 'No such route')
}

// ─── Admin routes ────────────────────────────────────────────────────────────

async function handleAdmin(req, res, url, route) {
  const { method } = req

  if (method === 'GET' && route === 'communities') {
    return json(res, 200, { success: true, data: paginate([...communities.values()], url) })
  }

  if (method === 'POST' && route === 'communities') {
    const body = await readBody(req)
    if (!body.name || !body.slug) return fail(res, 400, 'VALIDATION_ERROR', 'name and slug are required')
    if ([...communities.values()].some((c) => c.slug === body.slug)) {
      return fail(res, 400, 'VALIDATION_ERROR', `The slug "${body.slug}" is already taken`)
    }

    const community = {
      id: `cmt_${randomUUID().slice(0, 8)}`,
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      logoUrl: null,
      bannerUrl: null,
      type: body.type ?? 'PRIVATE',
      memberCount: 0,
      createdAt: new Date().toISOString(),
    }
    communities.set(community.id, community)
    return json(res, 201, { success: true, data: community })
  }

  if (method === 'GET' && route === 'community-requests') {
    const status = url.searchParams.get('status')
    const rows = [...requests.values()].filter((r) => !status || r.status === status)
    return json(res, 200, { success: true, data: paginate(rows, url) })
  }

  const decision = route.match(/^community-requests\/([^/]+)(?:\/(approve|reject))?$/)
  if (decision) {
    const [, requestId, action] = decision
    const request = requests.get(requestId)
    if (!request) return fail(res, 404, 'NOT_FOUND', 'No such request')

    if (method === 'GET' && !action) return json(res, 200, { success: true, data: request })

    if (method === 'POST' && action) {
      // The decision is what must be idempotent, not the click: approving twice
      // would otherwise create a second community.
      if (request.status !== 'PENDING') {
        return fail(res, 400, 'VALIDATION_ERROR', `This request was already ${request.status.toLowerCase()}`)
      }

      if (action === 'approve') {
        const community = {
          id: `cmt_${randomUUID().slice(0, 8)}`,
          slug: request.slug,
          name: request.name,
          description: request.description,
          logoUrl: null,
          bannerUrl: null,
          type: 'PRIVATE',
          memberCount: 0,
          createdAt: new Date().toISOString(),
        }
        communities.set(community.id, community)
        Object.assign(request, {
          status: 'APPROVED',
          communityId: community.id,
          decidedByUserId: 'usr_superadmin',
          decidedAt: new Date().toISOString(),
        })
      } else {
        const { reason } = await readBody(req)
        if (!reason) return fail(res, 400, 'VALIDATION_ERROR', 'A rejection reason is required')
        Object.assign(request, {
          status: 'REJECTED',
          rejectionReason: reason,
          decidedByUserId: 'usr_superadmin',
          decidedAt: new Date().toISOString(),
        })
      }
      return json(res, 200, { success: true, data: request })
    }
  }

  if (method === 'GET' && route === 'api-keys') {
    const communityId = url.searchParams.get('communityId')
    const rows = [...apiKeys.values()].filter((k) => !communityId || k.communityId === communityId)
    return json(res, 200, { success: true, data: paginate(rows, url) })
  }

  if (method === 'POST' && route === 'api-keys') {
    const body = await readBody(req)
    if (!body.communityId || !body.name) {
      return fail(res, 400, 'VALIDATION_ERROR', 'communityId and name are required')
    }
    if (!communities.has(body.communityId)) {
      return fail(res, 404, 'NOT_FOUND', 'No such community')
    }

    const keyId = randomUUID().replace(/-/g, '').slice(0, 12)
    const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 11)
    const summary = {
      id: keyId,
      communityId: body.communityId,
      name: body.name,
      scopes: body.scopes ?? ['read'],
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    }
    apiKeys.set(keyId, summary)

    // The plaintext appears here and nowhere else, ever. There is no read-back
    // route by design.
    return json(res, 201, { success: true, data: { ...summary, key: `gurb_${keyId}_${secret}` } })
  }

  const revoke = route.match(/^api-keys\/([^/]+)\/revoke$/)
  if (method === 'POST' && revoke) {
    const key = apiKeys.get(revoke[1])
    if (!key) return fail(res, 404, 'NOT_FOUND', 'No such key')
    key.revokedAt = key.revokedAt ?? new Date().toISOString()
    return json(res, 200, { success: true, data: key })
  }

  fail(res, 404, 'NOT_FOUND', 'No such route')
}

// ─── The framed page ─────────────────────────────────────────────────────────

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
    const app = document.getElementById('app')
    const post = (msg) => parent.postMessage({ source: 'gurb-embed', ...msg }, '*')

    const el = (tag, className, text) => {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }
    const strong = (text) => el('strong', '', text)
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

    new ResizeObserver(reportHeight).observe(app)

    // The token arrives in the fragment, which never reached this server.
    const token = new URLSearchParams(location.hash.slice(1)).get('t')

    fetch('/api/embed/sessions/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!ok) throw new Error(b.message || 'exchange failed')

        // Built with DOM calls, not innerHTML. displayName comes from the host
        // platform — it is user-controlled data crossing a trust boundary, and
        // concatenating it into markup is how an XSS gets shipped. textContent
        // cannot execute anything, whatever the string contains.
        app.textContent = ''
        const intro = el('p', 'meta')
        intro.append(
          'أنت داخل قسم ', strong(${JSON.stringify(section)}),
          ' لمجتمع ', strong(${JSON.stringify(slug)}),
          ' باسم ', strong(b.data.displayName),
        )
        app.append(intro)

        ;['أهلاً بالجميع في المجتمع 👋', 'تم نشر جدول الفعاليات القادمة', 'تذكير: اجتماع الأعضاء يوم الخميس']
          .forEach((text, i) => {
            const card = el('div', 'post')
            card.append(
              el('div', 'who', 'عضو ' + (i + 1)),
              el('div', 'meta', 'قبل ' + (i + 1) + ' ساعات'),
              el('div', '', text),
            )
            app.append(card)
          })

        post({ type: 'ready' })
        reportHeight()
      })
      .catch((e) => {
        app.textContent = ''
        app.append(el('p', '', 'تعذّر الدخول: ' + e.message))
        app.firstChild.id = 'err'
        post({ type: 'error', message: e.message })
        reportHeight()
      })
  </script>
</body></html>`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMockGurb().listen(5099, () => console.log('mock Gurb  → http://localhost:5099'))
}
