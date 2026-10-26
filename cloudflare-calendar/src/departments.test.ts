/// <reference types="vite/client" />
import { beforeEach, describe, expect, it } from 'vitest'
import worker, { signedWebhookRequest, type Env } from './worker'
import { calendarSchema, createD1 } from './test/d1'
import { crmHost, isDefaultTenant } from './tenant'

const seeds = import.meta.glob('../seeds/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const encoder = new TextEncoder()
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const ORIGIN_WCPR = 'https://calendar.wcpr.pro'
const ORIGIN_MOZAICO = 'https://calendar.mozaico.xyz'
const WCPR_WORKSPACE = 'b633df69-d087-4422-a2ec-86651a400602'
const MOZAICO_WORKSPACE = 'c84365d1-e564-4690-a7d4-2268085bc5a2'
const SYNC_SECRET = 'calendar-sync-secret-that-is-at-least-32-bytes'

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>) { const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256)) }
async function wcprHash(password: string) { const salt = crypto.getRandomValues(new Uint8Array(16)); return { hash: hex(await pbkdf2(password, salt)), salt: hex(salt) } }
async function mozaicoHash(password: string) { const salt = crypto.getRandomValues(new Uint8Array(16)); return { hash: btoa(String.fromCharCode(...await pbkdf2(password, salt))), salt: btoa(String.fromCharCode(...salt)) } }

const WCPR_AUTH_SCHEMA = `CREATE TABLE employees (email TEXT PRIMARY KEY, name TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'employee', active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 1, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT);
CREATE TABLE two_factor_methods (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, status TEXT NOT NULL);`
const MOZAICO_AUTH_SCHEMA = `CREATE TABLE native_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL);
CREATE TABLE workspace_members (workspace_id TEXT NOT NULL, identity_subject TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (workspace_id, identity_subject));
CREATE TABLE native_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, identity_subject TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE native_two_factor_methods (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL);`

type TestEnv = Env & { CALENDAR_DB: ReturnType<typeof createD1>; AUTH_DB: ReturnType<typeof createD1> }
const ctx = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext
const call = (env: Env, request: Request) => worker.fetch(request, env, ctx)

async function wcprEnv(): Promise<TestEnv> {
  const auth = createD1(WCPR_AUTH_SCHEMA)
  const add = async (email: string, password: string, extra: { active?: number; must_change?: number; locked_until?: string | null } = {}) => { const { hash, salt } = await wcprHash(password); auth.raw.prepare('INSERT INTO employees (email, name, pass_hash, salt, iterations, active, must_change, locked_until) VALUES (?, ?, ?, ?, 100000, ?, ?, ?)').run(email, email.split('@')[0], hash, salt, extra.active ?? 1, extra.must_change ?? 0, extra.locked_until ?? null) }
  await add('rprieto@wcpr.pro', 'owner-password-123'); await add('ana@wcpr.pro', 'ana-password-123'); await add('ben@wcpr.pro', 'ben-password-123')
  await add('gone@wcpr.pro', 'gone-password-123', { active: 0 }); await add('new@wcpr.pro', 'new-password-123', { must_change: 1 }); await add('locked@wcpr.pro', 'locked-password-123', { locked_until: new Date(Date.now() + 600_000).toISOString() }); await add('mfa@wcpr.pro', 'mfa-password-123')
  auth.raw.prepare("INSERT INTO two_factor_methods (id, email, status) VALUES ('m1', 'mfa@wcpr.pro', 'VERIFIED')").run()
  return { CALENDAR_DB: createD1(...calendarSchema, seeds['../seeds/wcpr.sql']), AUTH_DB: auth, ASSETS: {} as Fetcher, CALENDAR_ADMIN_PASSWORD: '', SESSION_SECRET: 'wcpr-session-secret-at-least-32-bytes-long', CALENDAR_SYNC_SECRET: SYNC_SECRET, CRM_WEBHOOK_URL: 'https://crm.wcpr.pro/api/integrations/calendar/webhook', AUTH_MODE: 'employee', AUTH_PROVIDER: 'wcpr-employees', WORKSPACE_ID: WCPR_WORKSPACE, ADMIN_EMAILS: 'rprieto@wcpr.pro', BRAND_NAME: 'WCPR', SERVICE_NAME: 'wcpr-calendar', CRM_HOST: 'crm.wcpr.pro', LOCALE: 'en', TIMEZONE: 'America/Los_Angeles' } as TestEnv
}

async function mozaicoEnv(): Promise<TestEnv> {
  const auth = createD1(MOZAICO_AUTH_SCHEMA)
  const add = async (id: string, email: string, password: string, status = 'active', workspace = MOZAICO_WORKSPACE) => { const { hash, salt } = await mozaicoHash(password); auth.raw.prepare('INSERT INTO native_users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)').run(id, email, hash, salt); auth.raw.prepare("INSERT INTO workspace_members (workspace_id, identity_subject, role, status) VALUES (?, ?, 'member', ?)").run(workspace, `user:${id}`, status) }
  await add('u1', 'rprieto@mozaico.xyz', 'owner-password-123'); await add('u2', 'sam@mozaico.xyz', 'sam-password-123'); await add('u3', 'old@mozaico.xyz', 'old-password-123', 'suspended'); await add('u4', 'other@mozaico.xyz', 'other-password-123', 'active', 'some-other-workspace')
  auth.raw.prepare("INSERT INTO native_sessions (id, workspace_id, identity_subject, expires_at) VALUES ('sso-session-token-0001', ?, 'user:u2', ?)").run(MOZAICO_WORKSPACE, new Date(Date.now() + 600_000).toISOString())
  return { CALENDAR_DB: createD1(...calendarSchema, seeds['../seeds/mozaico.sql']), AUTH_DB: auth, ASSETS: {} as Fetcher, CALENDAR_ADMIN_PASSWORD: '', SESSION_SECRET: 'mozaico-session-secret-at-least-32-bytes', CALENDAR_SYNC_SECRET: SYNC_SECRET, CRM_WEBHOOK_URL: 'https://mozaico.xyz/api/integrations/calendar/webhook', AUTH_MODE: 'employee', AUTH_PROVIDER: 'mozaico-crm', WORKSPACE_ID: MOZAICO_WORKSPACE, ADMIN_EMAILS: 'rprieto@mozaico.xyz', BRAND_NAME: 'Mozaico', SERVICE_NAME: 'mozaico-calendar', CRM_HOST: 'mozaico.xyz', LOCALE: 'en' } as TestEnv
}

const api = (origin: string, path: string, init: RequestInit & { cookie?: string } = {}) => new Request(`${origin}${path}`, { ...init, headers: { 'content-type': 'application/json', origin, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } })
async function login(env: Env, origin: string, email: string, password: string) { const response = await call(env, api(origin, '/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })); return { response, cookie: (response.headers.get('set-cookie') || '').split(';')[0] } }
const grant = (env: TestEnv, department: string, subject: string, role: string) => env.CALENDAR_DB.raw.prepare("INSERT INTO calendar_grants (id, department_key, subject, role, created_by, created_at) VALUES (?, ?, ?, ?, 'test', '2026-10-26T00:00:00Z')").run(crypto.randomUUID(), department, subject, role)
const eventBody = (departmentKey: string, title = 'Roof inspection') => JSON.stringify({ title, start: '2026-11-02T09:00:00-08:00[America/Los_Angeles]', end: '2026-11-02T10:00:00-08:00[America/Los_Angeles]', calendarId: 'team', departmentKey })
const insertEvent = (env: TestEnv, id: string, department: string) => env.CALENDAR_DB.raw.prepare("INSERT INTO calendar_events (workspace_id, id, title, start_at, end_at, department_key) VALUES (?, ?, 'Existing', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z', ?)").run(WCPR_WORKSPACE, id, department)

async function signed(method: string, path: string, body = '') {
  const timestamp = String(Date.now()); const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body))))
  const key = await crypto.subtle.importKey('raw', encoder.encode(SYNC_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${method}.${path}.${digest}`))))
  return new Request(`https://calendar.internal${path}`, { method, headers: { 'content-type': 'application/json', 'x-calendar-timestamp': timestamp, 'x-calendar-signature': signature, 'x-calendar-request-id': crypto.randomUUID() }, body: method === 'GET' ? undefined : body })
}

describe('tenant configuration', () => {
  it('keeps MiPolitico defaults when no tenant vars are set', async () => {
    const env = { CALENDAR_DB: createD1(...calendarSchema), CALENDAR_SYNC_SECRET: SYNC_SECRET, CRM_WEBHOOK_URL: 'https://crm.mipolitico.com/api/integrations/calendar/webhook' } as unknown as Env
    expect(isDefaultTenant(env)).toBe(true)
    expect(await (await call(env, new Request('https://calendar.mipolitico.com/api/health'))).json()).toEqual({ ok: true, service: 'mipolitico-calendar', crmSyncConfigured: true })
    expect(await (await call(env, new Request('https://calendar.mipolitico.com/api/auth/session'))).json()).toEqual({ authenticated: false })
  })

  it('pins webhook destinations to the configured, allowlisted CRM host', async () => {
    expect(() => crmHost({ CRM_HOST: 'evil.example.com' })).toThrow('crm_host_not_allowed')
    const outbox = { id: 'delivery-1', event_type: 'calendar.event.created', workspace_id: WCPR_WORKSPACE, created_at: new Date().toISOString(), payload_json: '{"event":{}}' }
    // A WCPR calendar must never deliver to MiPolitico's or Mozaico's CRM, even if the URL var is wrong.
    await expect(signedWebhookRequest({ CRM_HOST: 'crm.wcpr.pro', CRM_WEBHOOK_URL: 'https://crm.mipolitico.com/api/integrations/calendar/webhook', CALENDAR_SYNC_SECRET: SYNC_SECRET } as Env, outbox)).rejects.toThrow('crm_webhook_destination_invalid')
    await expect(signedWebhookRequest({ CRM_HOST: 'crm.wcpr.pro', CRM_WEBHOOK_URL: 'https://mozaico.xyz/api/integrations/calendar/webhook', CALENDAR_SYNC_SECRET: SYNC_SECRET } as Env, outbox)).rejects.toThrow('crm_webhook_destination_invalid')
    const delivered: string[] = []
    const service = { fetch: async (request: Request) => { delivered.push(request.url); return new Response(null, { status: 204 }) } }
    expect((await signedWebhookRequest({ CRM_SERVICE: service, CRM_HOST: 'crm.wcpr.pro', CRM_WEBHOOK_URL: 'https://crm.wcpr.pro/api/integrations/calendar/webhook', CALENDAR_SYNC_SECRET: SYNC_SECRET } as unknown as Env, outbox)).status).toBe(204)
    expect(delivered).toEqual(['https://crm.internal/api/integrations/calendar/webhook'])
  })

  it('reports the tenant service name on health', async () => {
    const env = await wcprEnv()
    expect(await (await call(env, new Request(`${ORIGIN_WCPR}/api/health`))).json()).toEqual({ ok: true, service: 'wcpr-calendar', crmSyncConfigured: true })
  })
})

describe('WCPR employee sign-in', () => {
  let env: TestEnv
  beforeEach(async () => { env = await wcprEnv() })

  it('accepts the mail password and issues a calendar session', async () => {
    const { response, cookie } = await login(env, ORIGIN_WCPR, 'Ana@WCPR.pro', 'ana-password-123')
    expect(response.status).toBe(200)
    expect(cookie).toMatch(/^__Host-calendar_session=\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
    const session = await (await call(env, api(ORIGIN_WCPR, '/api/auth/session', { cookie }))).json() as { authenticated: boolean; user: { email: string; admin: boolean } }
    expect(session.authenticated).toBe(true)
    expect(session.user).toMatchObject({ email: 'ana@wcpr.pro', admin: false })
  })

  it('rejects wrong passwords, disabled, locked, unchanged, and two-step accounts', async () => {
    expect((await login(env, ORIGIN_WCPR, 'ana@wcpr.pro', 'wrong-password')).response.status).toBe(401)
    expect((await login(env, ORIGIN_WCPR, 'nobody@wcpr.pro', 'whatever-password')).response.status).toBe(401)
    expect((await login(env, ORIGIN_WCPR, 'gone@wcpr.pro', 'gone-password-123')).response.status).toBe(401)
    expect((await login(env, ORIGIN_WCPR, 'locked@wcpr.pro', 'locked-password-123')).response.status).toBe(423)
    const mustChange = (await login(env, ORIGIN_WCPR, 'new@wcpr.pro', 'new-password-123')).response
    expect(mustChange.status).toBe(403)
    expect(((await mustChange.json()) as { error: string }).error).toContain('Change your password')
    expect((await login(env, ORIGIN_WCPR, 'mfa@wcpr.pro', 'mfa-password-123')).response.status).toBe(403)
  })

  it('revokes access on the next request when the employee is disabled in mail', async () => {
    const { cookie } = await login(env, ORIGIN_WCPR, 'ana@wcpr.pro', 'ana-password-123')
    env.AUTH_DB.raw.prepare("UPDATE employees SET active = 0 WHERE email = 'ana@wcpr.pro'").run()
    expect(await (await call(env, api(ORIGIN_WCPR, '/api/auth/session', { cookie }))).json()).toEqual({ authenticated: false })
  })

  it('throttles repeated failures per account', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await login(env, ORIGIN_WCPR, 'ben@wcpr.pro', `wrong-${attempt}`)).response.status).toBe(401)
    expect((await login(env, ORIGIN_WCPR, 'ben@wcpr.pro', 'ben-password-123')).response.status).toBe(429)
  }, 30_000)

  it('requires a same-origin login request', async () => {
    const response = await call(env, new Request(`${ORIGIN_WCPR}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ email: 'ana@wcpr.pro', password: 'ana-password-123' }) }))
    expect(response.status).toBe(403)
  })
})

describe('department grants', () => {
  let env: TestEnv
  beforeEach(async () => { env = await wcprEnv() })

  it('denies everything by default', async () => {
    const { cookie } = await login(env, ORIGIN_WCPR, 'ana@wcpr.pro', 'ana-password-123')
    expect(await (await call(env, api(ORIGIN_WCPR, '/api/events', { cookie }))).json()).toEqual({ workspaceId: WCPR_WORKSPACE, events: [] })
    expect(await (await call(env, api(ORIGIN_WCPR, '/api/departments', { cookie }))).json()).toEqual({ departments: [] })
    expect((await call(env, api(ORIGIN_WCPR, '/api/events?department=sales', { cookie }))).status).toBe(403)
    expect((await call(env, api(ORIGIN_WCPR, '/api/events', { cookie, method: 'POST', body: eventBody('sales') }))).status).toBe(403)
    expect((await call(env, api(ORIGIN_WCPR, '/api/events'))).status).toBe(401)
  })

  it('isolates departments: viewers read, operators write, other departments stay invisible', async () => {
    grant(env, 'sales', 'ana@wcpr.pro', 'operator'); grant(env, 'operations', 'ana@wcpr.pro', 'viewer')
    insertEvent(env, 'finance-event', 'finance'); insertEvent(env, 'ops-event', 'operations')
    const { cookie } = await login(env, ORIGIN_WCPR, 'ana@wcpr.pro', 'ana-password-123')
    const created = await call(env, api(ORIGIN_WCPR, '/api/events', { cookie, method: 'POST', body: eventBody('sales') }))
    expect(created.status).toBe(201)
    const { event } = await created.json() as { event: { id: string; departmentKey: string } }
    expect(event.departmentKey).toBe('sales')
    const listed = await (await call(env, api(ORIGIN_WCPR, '/api/events', { cookie }))).json() as { events: Array<{ id: string }> }
    expect(listed.events.map((row) => row.id).sort()).toEqual([event.id, 'ops-event'].sort())
    expect((await call(env, api(ORIGIN_WCPR, '/api/events', { cookie, method: 'POST', body: eventBody('operations') }))).status).toBe(403)
    expect((await call(env, api(ORIGIN_WCPR, '/api/events/ops-event', { cookie, method: 'PUT', body: eventBody('operations') }))).status).toBe(403)
    expect((await call(env, api(ORIGIN_WCPR, `/api/events/${event.id}`, { cookie, method: 'PUT', body: eventBody('finance') }))).status).toBe(403)
    expect((await call(env, api(ORIGIN_WCPR, '/api/events/finance-event', { cookie, method: 'PUT', body: eventBody('sales') }))).status).toBe(404)
    expect((await call(env, api(ORIGIN_WCPR, '/api/events/finance-event', { cookie, method: 'DELETE' }))).status).toBe(404)
    expect((await call(env, api(ORIGIN_WCPR, `/api/events/${event.id}`, { cookie, method: 'DELETE' }))).status).toBe(204)
  })

  it('applies department-wide grants to every employee and lets admins see all departments', async () => {
    grant(env, 'general', '*', 'viewer'); insertEvent(env, 'office-event', 'general'); insertEvent(env, 'finance-event', 'finance')
    const ben = (await login(env, ORIGIN_WCPR, 'ben@wcpr.pro', 'ben-password-123')).cookie
    expect(((await (await call(env, api(ORIGIN_WCPR, '/api/events', { cookie: ben }))).json()) as { events: Array<{ id: string }> }).events.map((row) => row.id)).toEqual(['office-event'])
    const owner = (await login(env, ORIGIN_WCPR, 'rprieto@wcpr.pro', 'owner-password-123')).cookie
    const departments = await (await call(env, api(ORIGIN_WCPR, '/api/departments', { cookie: owner }))).json() as { departments: Array<{ key: string; role: string }> }
    expect(departments.departments.map((row) => row.key).sort()).toEqual(['executive', 'finance', 'general', 'operations', 'sales'])
    expect(new Set(departments.departments.map((row) => row.role))).toEqual(new Set(['manager']))
  })

  it('rejects cross-origin writes from a valid browser session', async () => {
    grant(env, 'sales', 'ana@wcpr.pro', 'operator')
    const { cookie } = await login(env, ORIGIN_WCPR, 'ana@wcpr.pro', 'ana-password-123')
    const response = await call(env, new Request(`${ORIGIN_WCPR}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie }, body: eventBody('sales') }))
    expect(response.status).toBe(403)
  })
})

describe('department agents', () => {
  it('scopes an agent token to its department and stops honoring it after reassignment', async () => {
    const env = await wcprEnv(); const token = `calagt_${'a'.repeat(40)}`
    const hash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))))
    env.CALENDAR_DB.raw.prepare("INSERT INTO calendar_agent_tokens (id, department_key, agent_key, token_hash, created_at) VALUES ('t1', 'sales', 'wcpr-sales-agent', ?, '2026-10-26T00:00:00Z')").run(hash)
    const agentCall = (path: string, init: RequestInit = {}) => call(env, new Request(`${ORIGIN_WCPR}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }))
    expect((await agentCall('/api/events', { method: 'POST', body: eventBody('sales', 'Agent booking') })).status).toBe(201)
    expect((await agentCall('/api/events', { method: 'POST', body: eventBody('finance') })).status).toBe(403)
    expect((await agentCall('/api/events?department=finance')).status).toBe(403)
    const audit = env.CALENDAR_DB.raw.prepare("SELECT actor FROM calendar_audit_log WHERE action = 'event.created'").get()
    expect(audit?.actor).toBe('agent:wcpr-sales-agent')
    env.CALENDAR_DB.raw.prepare("UPDATE calendar_departments SET agent_key = 'someone-else' WHERE key = 'sales'").run()
    expect((await agentCall('/api/events')).status).toBe(401)
    expect((await call(env, new Request(`${ORIGIN_WCPR}/api/events`, { headers: { authorization: 'Bearer calagt_not-a-real-token-but-long-enough-0000' } }))).status).toBe(401)
  })
})

describe('admin page', () => {
  it('lets managers grant only within their department and blocks everyone else', async () => {
    const env = await wcprEnv(); grant(env, 'sales', 'ana@wcpr.pro', 'manager')
    const ana = (await login(env, ORIGIN_WCPR, 'ana@wcpr.pro', 'ana-password-123')).cookie
    const ben = (await login(env, ORIGIN_WCPR, 'ben@wcpr.pro', 'ben-password-123')).cookie
    expect((await call(env, new Request(`${ORIGIN_WCPR}/admin`, { headers: { cookie: ben } }))).status).toBe(403)
    const form = (fields: Record<string, string>, origin = ORIGIN_WCPR) => new Request(`${ORIGIN_WCPR}/admin`, { method: 'POST', headers: { cookie: ana, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
    expect(await (await call(env, form({ action: 'add_grant', department: 'sales', subject: 'ben@wcpr.pro', role: 'viewer' }))).text()).toContain('Granted viewer on sales to ben@wcpr.pro')
    expect(await (await call(env, form({ action: 'add_grant', department: 'finance', subject: 'ben@wcpr.pro', role: 'manager' }))).text()).toContain('You cannot manage that department.')
    expect(await (await call(env, form({ action: 'update_department', department: 'sales', name: 'Sales', agent_key: 'x', agent_name: 'X', owner_email: '', enabled: '1' }))).text()).toContain('Only administrators can assign agents.')
    expect((await call(env, form({ action: 'add_grant', department: 'sales', subject: '*', role: 'manager' }, 'https://evil.example'))).status).toBe(403)
    const grants = env.CALENDAR_DB.raw.prepare("SELECT department_key, subject, role FROM calendar_grants WHERE subject = 'ben@wcpr.pro'").all()
    expect(grants).toEqual([{ department_key: 'sales', subject: 'ben@wcpr.pro', role: 'viewer' }])
  })
})

describe('CRM sync and cross-project isolation', () => {
  it('keeps an event department through CRM upserts and files new CRM events under general', async () => {
    const env = await wcprEnv(); insertEvent(env, 'job-42', 'operations')
    const body = JSON.stringify({ title: 'Renamed in CRM', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T11:00:00.000Z', calendarId: 'team', revision: 5 })
    expect((await call(env, await signed('PUT', `/api/internal/v1/workspaces/${WCPR_WORKSPACE}/events/job-42`, body))).status).toBe(200)
    expect((await call(env, await signed('PUT', `/api/internal/v1/workspaces/${WCPR_WORKSPACE}/events/crm-new`, body))).status).toBe(200)
    const rows = env.CALENDAR_DB.raw.prepare('SELECT id, title, department_key FROM calendar_events ORDER BY id').all()
    expect(rows).toEqual([{ id: 'crm-new', title: 'Renamed in CRM', department_key: 'general' }, { id: 'job-42', title: 'Renamed in CRM', department_key: 'operations' }])
  })

  it('refuses signed sync calls for any workspace other than its own', async () => {
    const env = await wcprEnv()
    const body = JSON.stringify({ title: 'Wrong tenant', start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', calendarId: 'team' })
    expect((await call(env, await signed('PUT', `/api/internal/v1/workspaces/${MOZAICO_WORKSPACE}/events/x`, body))).status).toBe(404)
    expect((await call(env, await signed('GET', `/api/internal/v1/workspaces/${MOZAICO_WORKSPACE}/events`))).status).toBe(404)
    expect(env.CALENDAR_DB.raw.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()).toEqual({ count: 0 })
  })

  it('does not honor one project session or account in another project', async () => {
    const wcpr = await wcprEnv(); const mozaico = await mozaicoEnv()
    const { cookie } = await login(wcpr, ORIGIN_WCPR, 'rprieto@wcpr.pro', 'owner-password-123')
    expect(await (await call(mozaico, api(ORIGIN_MOZAICO, '/api/auth/session', { cookie }))).json()).toEqual({ authenticated: false })
    expect((await login(mozaico, ORIGIN_MOZAICO, 'rprieto@wcpr.pro', 'owner-password-123')).response.status).toBe(401)
  })
})

describe('Mozaico CRM accounts', () => {
  it('signs in active workspace members with the CRM password and rejects others', async () => {
    const env = await mozaicoEnv()
    const owner = await login(env, ORIGIN_MOZAICO, 'rprieto@mozaico.xyz', 'owner-password-123')
    expect(owner.response.status).toBe(200)
    expect(((await owner.response.json()) as { user: { admin: boolean } }).user.admin).toBe(true)
    expect((await login(env, ORIGIN_MOZAICO, 'rprieto@mozaico.xyz', 'nope-nope-nope')).response.status).toBe(401)
    expect((await login(env, ORIGIN_MOZAICO, 'old@mozaico.xyz', 'old-password-123')).response.status).toBe(401)
    expect((await login(env, ORIGIN_MOZAICO, 'other@mozaico.xyz', 'other-password-123')).response.status).toBe(401)
  })

  it('accepts a live Mozaico CRM session cookie (single sign-on) and nothing forged', async () => {
    const env = await mozaicoEnv()
    const session = await (await call(env, api(ORIGIN_MOZAICO, '/api/auth/session', { cookie: 'mozaico_session=sso-session-token-0001' }))).json() as { authenticated: boolean; user?: { email: string } }
    expect(session).toMatchObject({ authenticated: true, user: { email: 'sam@mozaico.xyz' } })
    expect(await (await call(env, api(ORIGIN_MOZAICO, '/api/auth/session', { cookie: 'mozaico_session=forged-session-token-99' }))).json()).toEqual({ authenticated: false })
  })
})
