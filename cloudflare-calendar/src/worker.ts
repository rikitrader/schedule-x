/// <reference types="@cloudflare/workers-types" />
import { bearerToken, principalFromHub, resolvePrincipal, SESSION_COOKIE, SESSION_TTL_SECONDS, type Principal } from './auth'
import { handleAdmin, handleEmployeeApi, type EventDeps } from './departments'
import { hubConfigured, hubDeniedPage, hubHome, hubIdentity, hubLoginRedirect, hubRequired, pendingReturn } from './hub'
import { isMessageKey, t, type Locale } from './i18n'
import { brandName, crmHost, employeeMode, employeeWorkspace, isDefaultTenant, locale, serviceName, timezone, type Env } from './tenant'
import { ClientError, digest, encoder, equalBytes, error, hex, hmac, hmacBytes, json, readCookie, requireSameOrigin, sha256 } from './util'

export type { Env }

type EventInput = { title: string; start: string; end: string; isAllDay?: boolean; calendarId?: string; description?: string; location?: string }
type EventRow = Record<string, unknown>
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000
function validWorkspaceId(value: string | null): value is string { return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) }
function validEventId(value: string) { return /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,191}$/u.test(value) }

async function passwordSession(request: Request, env: Env) { const token = readCookie(request, SESSION_COOKIE); if (!token || env.SESSION_SECRET.length < 32) return false; const [expires, signature] = token.split('.'); if (!expires || !signature || !/^\d+$/u.test(expires) || Number(expires) <= Date.now()) return false; const expected = await hmac(expires, env.SESSION_SECRET); return equalBytes(encoder.encode(signature), encoder.encode(expected)) }
// Password-mode (MiPolitico) administrators: hub Owner/Manager/Staff, or the shared password until HUB_REQUIRED=true.
async function isAdmin(request: Request, env: Env) { const hub = await hubIdentity(request, env); if (hub.status === 'ok' && hub.user.level <= 3) return true; return !hubRequired(env) && passwordSession(request, env) }
async function readJson(request: Request, lang: Locale = 'es') { const type = request.headers.get('content-type') || ''; if (!type.toLowerCase().startsWith('application/json')) throw new ClientError(t(lang, 'mustBeJson')); return request.json() }

function validateEvent(value: unknown, lang: Locale = 'es'): EventInput {
  const invalid = (key: Parameters<typeof t>[1]) => new ClientError(t(lang, key))
  if (!value || typeof value !== 'object') throw invalid('invalidEvent')
  const body = value as Record<string, unknown>; const title = typeof body.title === 'string' ? body.title.trim() : ''; const start = typeof body.start === 'string' ? body.start : ''; const end = typeof body.end === 'string' ? body.end : ''; const calendarId = typeof body.calendarId === 'string' ? body.calendarId : 'public'; const isAllDay = body.isAllDay === true; const description = typeof body.description === 'string' ? body.description.trim() : ''; const location = typeof body.location === 'string' ? body.location.trim() : ''
  if (!title || title.length > 200) throw invalid('invalidTitle')
  if (!start || !end || start >= end) throw invalid('invalidRange')
  if (!['public', 'team', 'private'].includes(calendarId)) throw invalid('invalidCategory')
  if (description.length > 4000 || location.length > 300) throw invalid('tooLong')
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u; const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?\[[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+\]$/u; const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u
  if (isAllDay ? !(dateOnly.test(start) && dateOnly.test(end)) : !((zoned.test(start) || instant.test(start)) && (zoned.test(end) || instant.test(end)))) throw invalid('invalidDate')
  return { title, start, end, isAllDay, calendarId, description, location }
}

function eventFromRow(row: EventRow, withDepartment = false) { return { id: row.id, workspaceId: row.workspace_id, ...(withDepartment ? { departmentKey: row.department_key } : {}), title: row.title, start: row.start_at, end: row.end_at, isAllDay: row.is_all_day === 1, calendarId: row.calendar_id, description: row.description, location: row.location, source: row.source, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } }
function workspaceForRequest(request: Request, admin: boolean) { const requested = new URL(request.url).searchParams.get('workspace'); return admin && validWorkspaceId(requested) ? requested : 'public' }
async function ensureWorkspace(env: Env, workspaceId: string, name = workspaceId, source: 'local' | 'crm' = 'crm') { const now = new Date().toISOString(); await env.CALENDAR_DB.prepare(`INSERT INTO calendar_workspaces (id,name,source,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,source=excluded.source,updated_at=excluded.updated_at`).bind(workspaceId, name.slice(0, 160), source, now, now).run() }

async function listEvents(request: Request, env: Env) {
  const url = new URL(request.url); const admin = await isAdmin(request, env); const workspaceId = workspaceForRequest(request, admin); const from = url.searchParams.get('from'); const to = url.searchParams.get('to'); let statement = 'SELECT * FROM calendar_events WHERE workspace_id = ?'; const values: string[] = [workspaceId]
  if (!admin) statement += " AND calendar_id = 'public'"
  if (from && to) { statement += ' AND end_at >= ? AND start_at <= ?'; values.push(from, to) }
  statement += ' ORDER BY start_at ASC LIMIT 5000'; const result = await env.CALENDAR_DB.prepare(statement).bind(...values).all(); return json({ workspaceId, events: result.results.map((row) => eventFromRow(row as EventRow)) })
}

function outboxStatement(env: Env, workspaceId: string, eventId: string, eventType: string, payload: unknown, now: string) { return env.CALENDAR_DB.prepare(`INSERT INTO calendar_webhook_outbox (id,workspace_id,event_id,event_type,payload_json,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,'pending',0,?,?,?)`).bind(crypto.randomUUID(), workspaceId, eventId, eventType, JSON.stringify(payload), now, now, now) }

async function createEvent(request: Request, env: Env, ctx: ExecutionContext) {
  const input = validateEvent(await readJson(request)); const workspaceId = workspaceForRequest(request, true); const id = crypto.randomUUID(); const now = new Date().toISOString(); const event = { id, workspaceId, ...input, source: 'calendar', revision: 1, createdAt: now, updatedAt: now }
  await ensureWorkspace(env, workspaceId, workspaceId, workspaceId === 'public' ? 'local' : 'crm')
  await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare(`INSERT INTO calendar_events (workspace_id,id,title,start_at,end_at,is_all_day,calendar_id,description,location,source,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'calendar',1,?,?)`).bind(workspaceId, id, input.title, input.start, input.end, input.isAllDay ? 1 : 0, input.calendarId, input.description, input.location, now, now), outboxStatement(env, workspaceId, id, 'calendar.event.created', { event }, now)])
  ctx.waitUntil(drainWebhookOutbox(env)); return json({ event }, 201)
}

async function updateEvent(request: Request, env: Env, id: string, ctx: ExecutionContext) {
  const input = validateEvent(await readJson(request)); const workspaceId = workspaceForRequest(request, true); const existing = await env.CALENDAR_DB.prepare('SELECT revision FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id).first<{ revision: number }>(); if (!existing) return error('Evento no encontrado.', 404)
  const revision = Number(existing.revision) + 1; const now = new Date().toISOString(); const event = { id, workspaceId, ...input, source: 'calendar', revision, updatedAt: now }
  await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare(`UPDATE calendar_events SET title=?,start_at=?,end_at=?,is_all_day=?,calendar_id=?,description=?,location=?,source='calendar',revision=?,updated_at=? WHERE workspace_id=? AND id=?`).bind(input.title, input.start, input.end, input.isAllDay ? 1 : 0, input.calendarId, input.description, input.location, revision, now, workspaceId, id), outboxStatement(env, workspaceId, id, 'calendar.event.updated', { event }, now)])
  ctx.waitUntil(drainWebhookOutbox(env)); const row = await env.CALENDAR_DB.prepare('SELECT * FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id).first(); return json({ event: eventFromRow(row as EventRow) })
}

async function deleteEvent(env: Env, workspaceId: string, id: string, ctx: ExecutionContext) {
  const existing = await env.CALENDAR_DB.prepare('SELECT revision FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id).first<{ revision: number }>(); if (!existing) return error('Evento no encontrado.', 404)
  const now = new Date().toISOString(); const payload = { event: { id, workspaceId, revision: Number(existing.revision) + 1, updatedAt: now } }
  await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare('DELETE FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id), outboxStatement(env, workspaceId, id, 'calendar.event.deleted', payload, now)])
  ctx.waitUntil(drainWebhookOutbox(env)); return new Response(null, { status: 204 })
}

export async function verifyServiceRequest(request: Request, env: Pick<Env, 'CALENDAR_SYNC_SECRET'>, rawBody: string) {
  if (!env.CALENDAR_SYNC_SECRET || env.CALENDAR_SYNC_SECRET.length < 32) return false
  const timestamp = request.headers.get('x-calendar-timestamp') || ''; const signature = request.headers.get('x-calendar-signature') || ''
  if (!/^\d{13}$/u.test(timestamp) || !/^[a-f0-9]{64}$/u.test(signature) || Math.abs(Date.now() - Number(timestamp)) > SIGNATURE_WINDOW_MS) return false
  const url = new URL(request.url); const canonical = `${timestamp}.${request.method}.${url.pathname}.${await sha256(rawBody)}`; const expected = hex(await hmacBytes(canonical, env.CALENDAR_SYNC_SECRET)); return equalBytes(encoder.encode(signature), encoder.encode(expected))
}

async function handleInternalApi(request: Request, env: Env) {
  const url = new URL(request.url); const match = url.pathname.match(/^\/api\/internal\/v1\/workspaces\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/events(?:\/([A-Za-z0-9][A-Za-z0-9_.:@-]{0,191}))?$/u); if (!match) return error('Ruta no encontrada.', 404)
  const rawBody = request.method === 'GET' ? '' : await request.text(); if (!(await verifyServiceRequest(request, env, rawBody))) return error('Firma de servicio inválida.', 401)
  const workspaceId = match[1]; const eventId = match[2]; const requestId = request.headers.get('x-calendar-request-id') || ''
  // An employee-mode calendar serves exactly one CRM workspace; anything else is another tenant's data.
  if (employeeMode(env) && workspaceId !== employeeWorkspace(env)) return error('Ruta no encontrada.', 404)
  if (request.method !== 'GET' && !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(requestId)) return error('Identificador de solicitud inválido.', 400)
  if (request.method !== 'GET') { const replay = await env.CALENDAR_DB.prepare('SELECT response_status as status,response_json as body FROM calendar_service_requests WHERE request_id=? AND workspace_id=?').bind(requestId, workspaceId).first<{ status: number; body: string | null }>(); if (replay) return new Response(replay.body, { status: replay.status, headers: replay.body ? { 'content-type': 'application/json; charset=utf-8' } : {} }) }
  if (request.method === 'GET' && !eventId) { const rows = await env.CALENDAR_DB.prepare('SELECT * FROM calendar_events WHERE workspace_id=? ORDER BY start_at,id LIMIT 5000').bind(workspaceId).all(); return json({ workspaceId, events: rows.results.map((row) => eventFromRow(row as EventRow)) }) }
  if (request.method === 'PUT' && eventId && validEventId(eventId)) {
    const body = JSON.parse(rawBody) as Record<string, unknown>; const input = validateEvent(body); const revision = Math.max(1, Number(body.revision ?? 1)); const now = typeof body.updatedAt === 'string' && !Number.isNaN(Date.parse(body.updatedAt)) ? body.updatedAt : new Date().toISOString()
    await ensureWorkspace(env, workspaceId, typeof body.workspaceName === 'string' ? body.workspaceName : workspaceId, 'crm')
    await env.CALENDAR_DB.prepare(`INSERT INTO calendar_events (workspace_id,id,title,start_at,end_at,is_all_day,calendar_id,description,location,source,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'crm',?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,is_all_day=excluded.is_all_day,calendar_id=excluded.calendar_id,description=excluded.description,location=excluded.location,source='crm',revision=excluded.revision,updated_at=excluded.updated_at WHERE excluded.revision>=calendar_events.revision`).bind(workspaceId, eventId, input.title, input.start, input.end, input.isAllDay ? 1 : 0, input.calendarId, input.description, input.location, revision, now, now).run()
    const row = await env.CALENDAR_DB.prepare('SELECT * FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, eventId).first(); const responseBody = JSON.stringify({ event: eventFromRow(row as EventRow) }); await env.CALENDAR_DB.prepare('INSERT INTO calendar_service_requests (request_id,workspace_id,method,path,response_status,response_json,received_at) VALUES (?,?,?,?,200,?,?)').bind(requestId, workspaceId, request.method, url.pathname, responseBody, new Date().toISOString()).run(); return new Response(responseBody, { headers: { 'content-type': 'application/json; charset=utf-8' } })
  }
  if (request.method === 'DELETE' && eventId && validEventId(eventId)) { await env.CALENDAR_DB.prepare('DELETE FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, eventId).run(); await env.CALENDAR_DB.prepare('INSERT INTO calendar_service_requests (request_id,workspace_id,method,path,response_status,response_json,received_at) VALUES (?,?,?,?,204,NULL,?)').bind(requestId, workspaceId, request.method, url.pathname, new Date().toISOString()).run(); return new Response(null, { status: 204 }) }
  return error('Método no permitido.', 405)
}

export async function signedWebhookRequest(env: Env, outbox: Record<string, unknown>) {
  if (!env.CRM_WEBHOOK_URL || !env.CALENDAR_SYNC_SECRET) throw new Error('crm_webhook_not_configured')
  const destination = new URL(env.CRM_WEBHOOK_URL); if (destination.protocol !== 'https:' || destination.hostname !== crmHost(env) || destination.pathname !== '/api/integrations/calendar/webhook') throw new Error('crm_webhook_destination_invalid')
  const body = JSON.stringify({ id: outbox.id, type: outbox.event_type, workspaceId: outbox.workspace_id, occurredAt: outbox.created_at, ...JSON.parse(String(outbox.payload_json)) }); const timestamp = String(Date.now()); const canonical = `${timestamp}.POST.${destination.pathname}.${await sha256(body)}`; const signature = hex(await hmacBytes(canonical, env.CALENDAR_SYNC_SECRET))
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'x-calendar-timestamp': timestamp, 'x-calendar-signature': signature, 'x-calendar-request-id': String(outbox.id) }, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) }
  if (env.CRM_SERVICE) return env.CRM_SERVICE.fetch(new Request(`https://crm.internal${destination.pathname}`, init))
  return fetch(destination, init)
}

export async function drainWebhookOutbox(env: Env) {
  const now = new Date().toISOString(); const rows = await env.CALENDAR_DB.prepare("SELECT * FROM calendar_webhook_outbox WHERE status IN ('pending','failed') AND next_attempt_at<=? ORDER BY created_at LIMIT 25").bind(now).all<Record<string, unknown>>()
  for (const row of rows.results) {
    const claimed = await env.CALENDAR_DB.prepare("UPDATE calendar_webhook_outbox SET status='delivering',attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('pending','failed')").bind(now, row.id).run(); if (Number(claimed.meta.changes) !== 1) continue
    try { const response = await signedWebhookRequest(env, row); if (!response.ok) { const detail = (await response.text()).slice(0, 240); throw new Error(`crm_webhook_http_${response.status}:${detail}`) } await env.CALENDAR_DB.prepare("UPDATE calendar_webhook_outbox SET status='delivered',last_error=NULL,updated_at=? WHERE id=?").bind(new Date().toISOString(), row.id).run() }
    catch (caught) { const attempts = Number(row.attempts ?? 0) + 1; const next = new Date(Date.now() + Math.min(3600, 2 ** Math.min(attempts, 10) * 5) * 1000).toISOString(); await env.CALENDAR_DB.prepare("UPDATE calendar_webhook_outbox SET status='failed',last_error=?,next_attempt_at=?,updated_at=? WHERE id=?").bind(String(caught).slice(0, 500), next, new Date().toISOString(), row.id).run() }
  }
}

function employeeDeps(env: Env): EventDeps {
  const lang = locale(env)
  return { readJson: (request) => readJson(request, lang), validateEvent: (value) => validateEvent(value, lang), eventFromRow: (row) => eventFromRow(row, true), outboxStatement, drainWebhookOutbox, ensureWorkspace }
}

// The built index.html is the Spanish MiPolitico page. Other tenants get their brand, locale, and auth mode
// rewritten at the edge so there is no flash of the wrong language and no per-tenant build.
function tenantHtml(response: Response, env: Env) {
  const lang = locale(env); const brand = brandName(env)
  const rewriter = new HTMLRewriter()
    .on('body', { element(element) { if (hubConfigured(env)) { element.setAttribute('data-hub-url', hubHome(env)); if (hubRequired(env)) element.setAttribute('data-hub-required', 'true') } } })
  if (isDefaultTenant(env)) return rewriter.transform(response)
  return rewriter
    .on('html', { element(element) { element.setAttribute('lang', lang) } })
    .on('title', { element(element) { element.setInnerContent(`${t(lang, 'brandSub')} | ${brand}`) } })
    .on('meta[name="description"]', { element(element) { element.setAttribute('content', `${t(lang, 'pageTitle', brand)}.`) } })
    .on('body', { element(element) { element.setAttribute('data-locale', lang); element.setAttribute('data-auth-mode', employeeMode(env) ? 'employee' : 'password'); element.setAttribute('data-timezone', timezone(env)); element.setAttribute('data-brand', brand) } })
    .on('.brand', { element(element) { element.setAttribute('aria-label', `${brand} ${t(lang, 'brandSub')}`) } })
    .on('.brand-mark', { element(element) { element.setInnerContent(brand.slice(0, 1).toUpperCase()) } })
    .on('.brand strong', { element(element) { element.setInnerContent(brand) } })
    .on('[data-i18n]', { element(element) { const key = element.getAttribute('data-i18n') || ''; if (isMessageKey(key)) element.setInnerContent(t(lang, key, brand)) } })
    .on('[data-i18n-aria]', { element(element) { const key = element.getAttribute('data-i18n-aria') || ''; if (isMessageKey(key)) element.setAttribute('aria-label', t(lang, key, brand)) } })
    .transform(response)
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/internal/')) return handleInternalApi(request, env)
  if (url.pathname === '/api/health' && request.method === 'GET') { const db = await env.CALENDAR_DB.prepare('SELECT 1 AS ok').first<{ ok: number }>(); return json({ ok: db?.ok === 1, service: serviceName(env), crmSyncConfigured: Boolean(env.CALENDAR_SYNC_SECRET && env.CRM_WEBHOOK_URL) }) }
  if (url.pathname === '/api/auth/session' && request.method === 'GET') return json({ authenticated: await isAdmin(request, env) })
  if (url.pathname === '/api/auth/login' && request.method === 'POST') { if (!requireSameOrigin(request)) return error('Origen no autorizado.', 403); if (hubRequired(env)) return error('Inicia sesión desde el hub.', 403); const body = await readJson(request) as { password?: unknown }; const password = typeof body.password === 'string' ? body.password : ''; if (!env.CALENDAR_ADMIN_PASSWORD || password.length > 512 || !equalBytes(await digest(password), await digest(env.CALENDAR_ADMIN_PASSWORD))) return error('Credenciales inválidas.', 401); const expires = String(Date.now() + SESSION_TTL_SECONDS * 1000); const token = `${expires}.${await hmac(expires, env.SESSION_SECRET)}`; return json({ authenticated: true }, 200, { 'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}` }) }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') { if (!requireSameOrigin(request)) return error('Origen no autorizado.', 403); return json({ authenticated: false }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }) }
  if (url.pathname === '/api/workspaces' && request.method === 'GET') { if (!(await isAdmin(request, env))) return error('Autenticación requerida.', 401); const rows = await env.CALENDAR_DB.prepare('SELECT id,name,source,updated_at as updatedAt FROM calendar_workspaces ORDER BY name,id').all(); return json({ workspaces: rows.results }) }
  if (url.pathname === '/api/events' && request.method === 'GET') return listEvents(request, env)
  if (!requireSameOrigin(request)) return error('Origen no autorizado.', 403)
  if (!(await isAdmin(request, env))) return error('Autenticación requerida.', 401)
  if (url.pathname === '/api/events' && request.method === 'POST') return createEvent(request, env, ctx)
  const match = url.pathname.match(/^\/api\/events\/([A-Za-z0-9][A-Za-z0-9_.:@-]{0,191})$/u)
  if (match && request.method === 'PUT') return updateEvent(request, env, match[1], ctx)
  if (match && request.method === 'DELETE') return deleteEvent(env, workspaceForRequest(request, true), match[1], ctx)
  return error('Ruta no encontrada.', 404)
}

const HSTS = 'max-age=31536000; includeSubDomains'
function securedAsset(response: Response) { const headers = new Headers(response.headers); headers.set('x-content-type-options', 'nosniff'); headers.set('referrer-policy', 'strict-origin-when-cross-origin'); headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()'); headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"); return new Response(response.body, { status: response.status, statusText: response.statusText, headers }) }
// HTML is per-user (gated, tenant-rewritten) and must never be reused from a cache; Vite's hashed /assets/* files never change.
async function serveAsset(request: Request, env: Env) {
  const assetResponse = await env.ASSETS.fetch(request); const html = (assetResponse.headers.get('content-type') || '').includes('text/html')
  const response = securedAsset(html && (!isDefaultTenant(env) || hubConfigured(env)) ? tenantHtml(assetResponse, env) : assetResponse)
  if (html) { response.headers.set('cache-control', 'no-store'); response.headers.delete('etag') }
  else if (new URL(request.url).pathname.startsWith('/assets/') && response.ok) response.headers.set('cache-control', 'public, max-age=31536000, immutable')
  return response
}
const AGENT_PATHS = /^\/api\/(?:departments|events(?:\/[A-Za-z0-9][A-Za-z0-9_.:@-]{0,191})?)$/u

// The hub gate. When the hub is required, nothing but health and the signed CRM sync API answers without a
// valid hub session (department agents may use their bearer token on the events API only).
async function gate(request: Request, env: Env): Promise<Response | Principal> {
  const url = new URL(request.url)
  if (!hubConfigured(env)) return error('hub sign-in is not configured', 503)
  if (bearerToken(request) && AGENT_PATHS.test(url.pathname)) { const agent = await resolvePrincipal(request, env); return agent ?? error(t(locale(env), 'authRequired'), 401) }
  const hub = await hubIdentity(request, env)
  if (hub.status === 'ok') return principalFromHub(env, hub)
  if (hub.status === 'denied') return url.pathname.startsWith('/api/') ? error(t(locale(env), 'forbidden'), 403) : hubDeniedPage(env, hub.reason)
  return request.method === 'GET' || request.method === 'HEAD' ? hubLoginRedirect(request, env) : error(t(locale(env), 'authRequired'), 401)
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/api/health' || url.pathname.startsWith('/api/internal/')) return handleApi(request, env, ctx)
  if (hubRequired(env)) {
    const passed = await gate(request, env); if (passed instanceof Response) return passed
    if (url.pathname === '/api/auth/hub') return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } })
    if (url.pathname === '/' && request.method === 'GET') { const back = pendingReturn(request); if (back) return back }
    if (employeeMode(env)) {
      if (url.pathname.startsWith('/api/')) return handleEmployeeApi(request, env, ctx, employeeDeps(env), passed)
      if (url.pathname === '/admin') return handleAdmin(request, env, passed)
      return serveAsset(request, env)
    }
  } else if (url.pathname === '/api/auth/hub' && hubConfigured(env)) {
    // Optional hub sign-in for MiPolitico while the shared password is still allowed.
    const hub = await hubIdentity(request, env)
    if (hub.status === 'denied') return hubDeniedPage(env, hub.reason)
    return hub.status === 'ok' ? new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } }) : hubLoginRedirect(request, env)
  }
  if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx)
  return serveAsset(request, env)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.protocol === 'http:') { url.protocol = 'https:'; return new Response(null, { status: 301, headers: { location: url.toString(), 'strict-transport-security': HSTS } }) }
    let response: Response
    try { response = await route(request, env, ctx) }
    catch (caught) { console.error('request_failed', caught instanceof Error ? caught.message : 'unknown'); if (url.pathname.startsWith('/api/')) { const message = caught instanceof Error ? caught.message : 'Error inesperado.'; response = caught instanceof ClientError ? error(message, caught.status) : error(message, message.includes('JSON') || message.includes('válid') || message.includes('límite') ? 400 : 500) } else response = new Response('Internal Server Error', { status: 500 }) }
    const headers = new Headers(response.headers); headers.set('strict-transport-security', HSTS)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(drainWebhookOutbox(env)) },
} satisfies ExportedHandler<Env>
