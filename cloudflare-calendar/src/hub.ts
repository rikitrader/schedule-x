/// <reference types="@cloudflare/workers-types" />
import type { Role } from './auth'
import type { Env } from './tenant'
import { base64Url, encoder, equalStrings, escapeHtml, fromBase64Url, hmac, readCookie, SESSION_COOKIE, SESSION_TTL_SECONDS } from './util'

// Project-hub single sign-on (rikitrader/project-hub, contract src/rpc.ts). The hub owns identity and
// app authorization; this Worker asks it over the HUB service binding who the browser is and whether
// `calendar` is allowed. No secret is shared, so another project's hub session is simply unknown here.
export type HubIdentity =
  | { ok: true; project: string; sessionId: string; userId: string; email: string; name: string; level: number; levelName: string; departments: string[]; allowed: boolean; reason?: string }
  | { ok: false; project: string; reason: string }
export interface HubBinding { verify(cookieOrToken: string, appKey: string): Promise<HubIdentity>; sessionActive(sessionId: string): Promise<boolean> }
export type HubSession = { email: string; name: string; level: number; departments: string[]; hubSessionId: string }

export const HUB_APP_KEY = 'calendar'
const LIVENESS_CACHE_MS = 15_000
const liveness = new Map<string, { live: boolean; at: number }>()
export const __resetHubLivenessCache = () => liveness.clear()

export const hubConfigured = (env: Env) => Boolean(env.HUB && env.HUB_PROJECT && env.HUB_LOGIN_URL)
// The local password form stays reachable (at /?local=1) only while LOCAL_LOGIN=true.
export const localLoginAllowed = (env: Env) => !hubConfigured(env) || env.LOCAL_LOGIN === 'true'

/** Hub level → calendar access. 1 Owner → admin, 2 Manager → manager everywhere, 3 Staff → operator on their departments, 4 Limited → viewer on their departments. */
export function rolesForHubLevel(level: number, departments: string[], allDepartments: string[]): { admin: boolean; roles: Map<string, Role> } {
  if (level === 1) return { admin: true, roles: new Map(allDepartments.map((key) => [key, 'manager'])) }
  if (level === 2) return { admin: false, roles: new Map(allDepartments.map((key) => [key, 'manager'])) }
  const role: Role = level === 3 ? 'operator' : 'viewer'
  return { admin: false, roles: new Map(departments.filter((key) => allDepartments.includes(key)).map((key) => [key, role])) }
}

export async function hubSessionCookie(env: Env, who: Extract<HubIdentity, { ok: true }>) {
  if (env.SESSION_SECRET.length < 32) throw new Error('session_secret_not_configured')
  const expires = String(Date.now() + SESSION_TTL_SECONDS * 1000)
  const payload = base64Url(encoder.encode(JSON.stringify({ e: who.email.trim().toLowerCase(), n: who.name, l: who.level, d: who.departments, s: who.sessionId })))
  return `${SESSION_COOKIE}=hub.${expires}.${payload}.${await hmac(`hub.${expires}.${payload}`, env.SESSION_SECRET)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`
}

/** A hub-linked calendar session lives only as long as its hub session (logout, revocation, disabled user). */
export async function hubSession(request: Request, env: Env): Promise<HubSession | null> {
  if (!hubConfigured(env)) return null
  const token = readCookie(request, SESSION_COOKIE); if (!token || env.SESSION_SECRET.length < 32) return null
  const [kind, expires, payload, signature, extra] = token.split('.')
  if (kind !== 'hub' || extra !== undefined || !expires || !payload || !signature || !/^\d+$/u.test(expires) || Number(expires) <= Date.now()) return null
  if (!equalStrings(signature, await hmac(`hub.${expires}.${payload}`, env.SESSION_SECRET))) return null
  let data: { e?: unknown; n?: unknown; l?: unknown; d?: unknown; s?: unknown }
  try { data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) } catch { return null }
  if (typeof data.e !== 'string' || typeof data.s !== 'string' || typeof data.l !== 'number' || !Array.isArray(data.d)) return null
  const cached = liveness.get(data.s); let live: boolean
  if (cached && Date.now() - cached.at < LIVENESS_CACHE_MS) live = cached.live
  else { live = await env.HUB!.sessionActive(data.s).catch(() => false); liveness.set(data.s, { live, at: Date.now() }) }
  return live ? { email: data.e, name: typeof data.n === 'string' ? data.n : data.e, level: data.l, departments: data.d.filter((key): key is string => typeof key === 'string'), hubSessionId: data.s } : null
}

const page = (status: number, title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;max-width:440px;margin:15vh auto;padding:0 16px;line-height:1.5"><h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}</body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } })
export const hubLoginRedirect = (env: Env) => new Response(null, { status: 302, headers: { location: env.HUB_LOGIN_URL!, 'cache-control': 'no-store' } })

/** GET /api/auth/hub — the hub tile target (and where "/" sends anyone without a calendar session). */
export async function handleHubSignIn(request: Request, env: Env) {
  if (!hubConfigured(env)) return new Response(JSON.stringify({ error: 'hub sign-in is not configured' }), { status: 503, headers: { 'content-type': 'application/json' } })
  const who = await env.HUB!.verify(request.headers.get('cookie') ?? '', HUB_APP_KEY)
  if (!who.ok) return hubLoginRedirect(env)
  const hubHome = escapeHtml(new URL('/', env.HUB_LOGIN_URL).toString())
  if (who.project !== env.HUB_PROJECT) return page(403, 'Wrong sign-in', `<p>This session belongs to a different organization.</p><p><a href="${hubHome}">Go to the hub</a></p>`)
  if (who.reason === 'password_change_required') return page(403, 'Password change required', `<p>Change your password in the hub, then open the calendar again.</p><p><a href="${hubHome}password">Change password</a></p>`)
  if (!who.allowed) return page(403, 'Access denied', `<p>Your access level does not include the calendar.</p><p><a href="${hubHome}">Back to apps</a></p>`)
  liveness.set(who.sessionId, { live: true, at: Date.now() })
  return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store', 'set-cookie': await hubSessionCookie(env, who) } })
}
