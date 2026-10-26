/// <reference types="@cloudflare/workers-types" />
import type { MessageKey } from './i18n'
import { adminEmails, authProvider, employeeWorkspace, type Env } from './tenant'
import { base64Url, encoder, equalStrings, fromBase64Url, hex, hmac, readCookie, sha256 } from './util'

// Employee sign-in against the project's own mail/CRM accounts. The auth database is only ever SELECTed from.
export type Role = 'viewer' | 'operator' | 'manager'
export type Principal = { kind: 'user' | 'agent'; email: string; name: string; admin: boolean; roles: Map<string, Role> }
type LoginResult = { ok: true; email: string; name: string } | { ok: false; status: number; key: MessageKey }

export const SESSION_COOKIE = '__Host-calendar_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 12
const MAX_PBKDF2_ITERATIONS = 100_000 // Workers rejects PBKDF2 above 100k iterations.
const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, manager: 3 }
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILED_LOGINS = 10
export const roleAtLeast = (role: Role | undefined, minimum: Role) => Boolean(role && ROLE_RANK[role] >= ROLE_RANK[minimum])
export const validEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) { const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)) }
const fromHex = (value: string) => new Uint8Array((value.match(/../gu) || []).map((pair) => parseInt(pair, 16)))
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

// WCPR Mail format (wcpr-inbox workers/lib/employee-auth.ts): hex PBKDF2-SHA256, hex salt, per-row iterations.
async function verifyWcprEmployee(db: D1Database, email: string, password: string): Promise<LoginResult> {
  const row = await db.prepare("SELECT e.email, e.name, e.pass_hash, e.salt, e.iterations, e.active, e.must_change, e.locked_until, (SELECT t.status FROM two_factor_methods t WHERE t.email = e.email) AS mfa FROM employees e WHERE e.email = ?").bind(email).first<{ email: string; name: string; pass_hash: string; salt: string; iterations: number; active: number; must_change: number; locked_until: string | null; mfa: string | null }>()
  if (row?.locked_until && Date.parse(row.locked_until) > Date.now()) return { ok: false, status: 423, key: 'locked' }
  const iterations = Number(row?.iterations ?? MAX_PBKDF2_ITERATIONS)
  // Hash even for unknown accounts so response time does not reveal which emails exist.
  const actual = hex(await pbkdf2(password, fromHex(row?.salt ?? '0'.repeat(32)), Math.min(iterations, MAX_PBKDF2_ITERATIONS)))
  if (!row || row.active !== 1 || iterations > MAX_PBKDF2_ITERATIONS || !equalStrings(actual, row.pass_hash)) return { ok: false, status: 401, key: 'invalidCredentials' }
  if (row.must_change) return { ok: false, status: 403, key: 'mustChange' }
  if (row.mfa === 'VERIFIED') return { ok: false, status: 403, key: 'twoFactorBlocked' }
  return { ok: true, email: row.email.toLowerCase(), name: row.name || row.email }
}

// Mozaico CRM format (twenty-cf src/native-auth.ts): base64 PBKDF2-SHA256 at 100k, base64 salt; membership must be active.
async function verifyMozaicoUser(db: D1Database, workspaceId: string, email: string, password: string): Promise<LoginResult> {
  const row = await db.prepare("SELECT u.email, u.password_hash, u.password_salt, m.status AS member, (SELECT t.status FROM native_two_factor_methods t WHERE t.user_id = u.id AND t.status = 'VERIFIED' LIMIT 1) AS mfa FROM native_users u LEFT JOIN workspace_members m ON m.identity_subject = 'user:' || u.id AND m.workspace_id = ? WHERE u.email = ? COLLATE NOCASE LIMIT 1").bind(workspaceId, email).first<{ email: string; password_hash: string; password_salt: string; member: string | null; mfa: string | null }>()
  const actual = toBase64(await pbkdf2(password, fromBase64(row?.password_salt ?? 'AAAAAAAAAAAAAAAAAAAAAA=='), MAX_PBKDF2_ITERATIONS))
  if (!row || row.member !== 'active' || !equalStrings(actual, row.password_hash)) return { ok: false, status: 401, key: 'invalidCredentials' }
  if (row.mfa) return { ok: false, status: 403, key: 'twoFactor' }
  return { ok: true, email: row.email.toLowerCase(), name: row.email.toLowerCase() }
}

export async function verifyEmployeeLogin(env: Env, email: string, password: string): Promise<LoginResult> {
  if (!env.AUTH_DB) throw new Error('auth_db_not_configured')
  const since = new Date(Date.now() - LOGIN_WINDOW_MS).toISOString()
  const failures = await env.CALENDAR_DB.prepare('SELECT COUNT(*) AS count FROM calendar_login_attempts WHERE email = ? AND attempted_at > ?').bind(email, since).first<{ count: number }>()
  if (Number(failures?.count ?? 0) >= MAX_FAILED_LOGINS) return { ok: false, status: 429, key: 'tooManyAttempts' }
  const result = authProvider(env) === 'wcpr-employees' ? await verifyWcprEmployee(env.AUTH_DB, email, password) : await verifyMozaicoUser(env.AUTH_DB, employeeWorkspace(env), email, password)
  if (!result.ok && result.status === 401) await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare('INSERT INTO calendar_login_attempts (email, attempted_at) VALUES (?, ?)').bind(email, new Date().toISOString()), env.CALENDAR_DB.prepare('DELETE FROM calendar_login_attempts WHERE attempted_at < ?').bind(since)])
  if (result.ok) await env.CALENDAR_DB.prepare('DELETE FROM calendar_login_attempts WHERE email = ?').bind(email).run()
  return result
}

// Re-checked on every request so disabled employees and forced password changes take effect immediately.
async function activeIdentity(env: Env, email: string) {
  if (!env.AUTH_DB) return null
  if (authProvider(env) === 'wcpr-employees') return env.AUTH_DB.prepare('SELECT email, name FROM employees WHERE email = ? AND active = 1 AND must_change = 0').bind(email).first<{ email: string; name: string }>()
  const row = await env.AUTH_DB.prepare("SELECT u.email FROM native_users u JOIN workspace_members m ON m.identity_subject = 'user:' || u.id WHERE u.email = ? COLLATE NOCASE AND m.workspace_id = ? AND m.status = 'active' LIMIT 1").bind(email, employeeWorkspace(env)).first<{ email: string }>()
  return row ? { email: row.email, name: row.email } : null
}

// Mozaico single sign-on: the CRM session cookie is scoped to .mozaico.xyz, validated exactly as mail.mozaico.xyz does.
async function crmSessionEmail(request: Request, env: Env) {
  if (!env.AUTH_DB || authProvider(env) !== 'mozaico-crm') return null
  const token = readCookie(request, 'mozaico_session'); if (!token || !/^[a-zA-Z0-9_-]{16,128}$/u.test(token)) return null
  const row = await env.AUTH_DB.prepare("SELECT u.email FROM native_sessions s JOIN native_users u ON u.id = REPLACE(s.identity_subject, 'user:', '') JOIN workspace_members m ON m.identity_subject = s.identity_subject AND m.workspace_id = ? AND m.status = 'active' WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? LIMIT 1").bind(employeeWorkspace(env), token, new Date().toISOString()).first<{ email: string }>()
  return row?.email.toLowerCase() ?? null
}

export async function employeeSessionCookie(env: Env, email: string) {
  if (env.SESSION_SECRET.length < 32) throw new Error('session_secret_not_configured')
  const expires = String(Date.now() + SESSION_TTL_SECONDS * 1000); const subject = base64Url(encoder.encode(email))
  return `${SESSION_COOKIE}=${expires}.${subject}.${await hmac(`${expires}.${subject}`, env.SESSION_SECRET)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`
}

export async function sessionEmail(request: Request, env: Pick<Env, 'SESSION_SECRET'>) {
  const token = readCookie(request, SESSION_COOKIE); if (!token || env.SESSION_SECRET.length < 32) return null
  const [expires, subject, signature, extra] = token.split('.'); if (extra !== undefined || !expires || !subject || !signature || !/^\d+$/u.test(expires) || Number(expires) <= Date.now()) return null
  if (!equalStrings(signature, await hmac(`${expires}.${subject}`, env.SESSION_SECRET))) return null
  try { return new TextDecoder().decode(fromBase64Url(subject)) } catch { return null }
}

export async function rolesFor(env: Env, email: string, admin: boolean) {
  const roles = new Map<string, Role>()
  if (admin) { const rows = await env.CALENDAR_DB.prepare('SELECT key FROM calendar_departments WHERE enabled = 1').all<{ key: string }>(); for (const row of rows.results) roles.set(row.key, 'manager'); return roles }
  const rows = await env.CALENDAR_DB.prepare("SELECT g.department_key AS key, g.role FROM calendar_grants g JOIN calendar_departments d ON d.key = g.department_key AND d.enabled = 1 WHERE g.subject IN (?, '*')").bind(email).all<{ key: string; role: Role }>()
  for (const row of rows.results) if (!roleAtLeast(roles.get(row.key), row.role)) roles.set(row.key, row.role)
  return roles
}

async function agentPrincipal(env: Env, token: string): Promise<Principal | null> {
  if (!/^calagt_[A-Za-z0-9_-]{32,128}$/u.test(token)) return null
  // A token stops working when its department is disabled or reassigned to a different agent.
  const row = await env.CALENDAR_DB.prepare('SELECT t.agent_key, t.department_key, t.role, d.agent_name FROM calendar_agent_tokens t JOIN calendar_departments d ON d.key = t.department_key AND d.enabled = 1 AND d.agent_key = t.agent_key WHERE t.token_hash = ? AND t.revoked_at IS NULL').bind(await sha256(token)).first<{ agent_key: string; department_key: string; role: Role; agent_name: string }>()
  return row ? { kind: 'agent', email: row.agent_key, name: row.agent_name || row.agent_key, admin: false, roles: new Map([[row.department_key, row.role]]) } : null
}

export async function resolvePrincipal(request: Request, env: Env): Promise<Principal | null> {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/iu)?.[1]
  if (bearer) return agentPrincipal(env, bearer)
  const email = (await sessionEmail(request, env)) ?? (await crmSessionEmail(request, env)); if (!email) return null
  const identity = await activeIdentity(env, email); if (!identity) return null
  const normalized = identity.email.toLowerCase(); const admin = adminEmails(env).has(normalized)
  return { kind: 'user', email: normalized, name: identity.name || normalized, admin, roles: await rolesFor(env, normalized, admin) }
}
