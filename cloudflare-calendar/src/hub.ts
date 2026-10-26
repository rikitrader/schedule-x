/// <reference types="@cloudflare/workers-types" />
import type { Role } from './auth'
import { employeeMode, type Env } from './tenant'
import { escapeHtml, readCookie, sha256 } from './util'

// Project-hub single sign-on (rikitrader/project-hub, contract src/rpc.ts). The hub owns identity and
// app authorization; the calendar has no login of its own. Every request hands the browser's hub_session
// cookie (scoped to the project's parent domain) to HUB.verify over the service binding. No secret is
// shared, so another project's hub session is unknown here, and the project field is checked anyway.
export type HubIdentity =
  | { ok: true; project: string; sessionId: string; userId: string; email: string; name: string; level: number; levelName: string; departments: string[]; allowed: boolean; reason?: string }
  | { ok: false; project: string; reason: string }
export interface HubBinding { verify(cookieOrToken: string, appKey: string): Promise<HubIdentity>; sessionActive(sessionId: string): Promise<boolean> }
export type HubUser = { email: string; name: string; level: number; departments: string[] }
export type HubResult = { status: 'ok'; user: HubUser } | { status: 'none' } | { status: 'denied'; reason: 'wrong_project' | 'app_denied' | 'password_change_required' }

export const HUB_APP_KEY = 'calendar'
const RETURN_COOKIE = '__Host-calendar_return'
const CACHE_MS = 15_000 // Bounds how long a hub logout or revocation can lag here.
const HUB_TOKEN = /(?:^|;\s*)hub_session=([A-Za-z0-9_-]{43})(?:;|$)/u
const cache = new Map<string, { at: number; result: HubResult }>()
export const __resetHubCache = () => cache.clear()

export const hubConfigured = (env: Env) => Boolean(env.HUB && env.HUB_PROJECT && env.HUB_LOGIN_URL)
// Employee tenants (WCPR, Mozaico) have no other sign-in. MiPolitico keeps its admin password until HUB_REQUIRED=true.
export const hubRequired = (env: Env) => employeeMode(env) || env.HUB_REQUIRED === 'true'
export const hubHome = (env: Env) => new URL('/', env.HUB_LOGIN_URL).toString()

/** Hub level → calendar access. 1 Owner → admin, 2 Manager → manager everywhere, 3 Staff → operator and 4 Limited → viewer on their hub departments. */
export function rolesForHubLevel(level: number, departments: string[], allDepartments: string[]): { admin: boolean; roles: Map<string, Role> } {
  if (level === 1) return { admin: true, roles: new Map(allDepartments.map((key) => [key, 'manager'])) }
  if (level === 2) return { admin: false, roles: new Map(allDepartments.map((key) => [key, 'manager'])) }
  const role: Role = level === 3 ? 'operator' : 'viewer'
  return { admin: false, roles: new Map(departments.filter((key) => allDepartments.includes(key)).map((key) => [key, role])) }
}

export async function hubIdentity(request: Request, env: Env): Promise<HubResult> {
  if (!hubConfigured(env)) return { status: 'none' }
  const token = (request.headers.get('cookie') || '').match(HUB_TOKEN)?.[1]; if (!token) return { status: 'none' }
  const key = `${env.HUB_PROJECT}:${await sha256(token)}`; const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result
  const who = await env.HUB!.verify(`hub_session=${token}`, HUB_APP_KEY).catch(() => ({ ok: false, project: '', reason: 'hub_unavailable' }) as HubIdentity)
  const result: HubResult = !who.ok ? { status: 'none' }
    : who.project !== env.HUB_PROJECT ? { status: 'denied', reason: 'wrong_project' }
    : who.reason === 'password_change_required' ? { status: 'denied', reason: 'password_change_required' }
    : !who.allowed ? { status: 'denied', reason: 'app_denied' }
    : { status: 'ok', user: { email: who.email.trim().toLowerCase(), name: who.name || who.email, level: who.level, departments: who.departments } }
  cache.set(key, { at: Date.now(), result }); return result
}

const SAFE_RETURN = /^\/(?!\/)[A-Za-z0-9/_.~%=&?:@+,-]{0,500}$/u
/** Sends a signed-out browser to the hub. The hub only honors its own paths in next=, so the page to come back to is parked in a short-lived cookie here. */
export function hubLoginRedirect(request: Request, env: Env) {
  const url = new URL(request.url); const back = `${url.pathname}${url.search}`; const headers = new Headers({ location: env.HUB_LOGIN_URL!, 'cache-control': 'no-store' })
  if (back !== '/' && SAFE_RETURN.test(back) && !url.pathname.startsWith('/api/')) headers.append('set-cookie', `${RETURN_COOKIE}=${encodeURIComponent(back)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`)
  return new Response(null, { status: 302, headers })
}
/** After the hub sends the user back to the calendar root, finish the trip to the page they asked for. */
export function pendingReturn(request: Request) {
  const raw = readCookie(request, RETURN_COOKIE); if (!raw) return null
  let back: string; try { back = decodeURIComponent(raw) } catch { return null }
  return SAFE_RETURN.test(back) ? new Response(null, { status: 302, headers: { location: back, 'cache-control': 'no-store', 'set-cookie': `${RETURN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } }) : null
}

const DENIED: Record<Extract<HubResult, { status: 'denied' }>['reason'], [string, string]> = {
  wrong_project: ['Wrong sign-in', 'This session belongs to a different organization.'],
  app_denied: ['Access denied', 'Your access level does not include the calendar.'],
  password_change_required: ['Password change required', 'Change your password in the hub, then open the calendar again.'],
}
export function hubDeniedPage(env: Env, reason: Extract<HubResult, { status: 'denied' }>['reason']) {
  const [title, text] = DENIED[reason]; const home = escapeHtml(hubHome(env))
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:440px;margin:15vh auto;padding:0 16px;line-height:1.5"><h1 style="font-size:20px">${title}</h1><p>${text}</p><p><a href="${home}">Go to the hub</a></p></body>`, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } })
}
