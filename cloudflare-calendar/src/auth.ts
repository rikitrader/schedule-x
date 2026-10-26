/// <reference types="@cloudflare/workers-types" />
import { hubIdentity, rolesForHubLevel, type HubResult } from './hub'
import { adminEmails, type Env } from './tenant'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, sha256 } from './util'

export { SESSION_COOKIE, SESSION_TTL_SECONDS }

// Employee tenants authenticate people only through the project hub; department agents use bearer tokens.
export type Role = 'viewer' | 'operator' | 'manager'
export type Principal = { kind: 'user' | 'agent'; email: string; name: string; admin: boolean; roles: Map<string, Role> }

const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, manager: 3 }
export const roleAtLeast = (role: Role | undefined, minimum: Role) => Boolean(role && ROLE_RANK[role] >= ROLE_RANK[minimum])
export const validEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)

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

export async function principalFromHub(env: Env, hub: Extract<HubResult, { status: 'ok' }>): Promise<Principal> {
  // Hub level sets the baseline; explicit calendar grants can only raise it.
  const departments = await env.CALENDAR_DB.prepare('SELECT key FROM calendar_departments WHERE enabled = 1').all<{ key: string }>()
  const { email, name, level } = hub.user
  const base = rolesForHubLevel(level, hub.user.departments, departments.results.map((row) => row.key)); const admin = base.admin || adminEmails(env).has(email)
  const roles = admin ? await rolesFor(env, email, true) : base.roles
  if (!admin) for (const [key, role] of await rolesFor(env, email, false)) if (!roleAtLeast(roles.get(key), role)) roles.set(key, role)
  return { kind: 'user', email, name, admin, roles }
}

export const bearerToken = (request: Request) => request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/iu)?.[1]

export async function resolvePrincipal(request: Request, env: Env): Promise<Principal | null> {
  const bearer = bearerToken(request)
  if (bearer) return agentPrincipal(env, bearer)
  const hub = await hubIdentity(request, env)
  return hub.status === 'ok' ? principalFromHub(env, hub) : null
}
