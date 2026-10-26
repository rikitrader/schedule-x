/// <reference types="vite/client" />
import { beforeEach, describe, expect, it } from 'vitest'
import worker, { signedWebhookRequest, type Env } from './worker'
import { calendarSchema, createD1 } from './test/d1'
import { crmHost, isDefaultTenant } from './tenant'
import { __resetHubCache } from './hub'

beforeEach(() => __resetHubCache())

const seeds = import.meta.glob('../seeds/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const encoder = new TextEncoder()
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const ORIGIN_WCPR = 'https://calendar.wcpr.pro'
const ORIGIN_MOZAICO = 'https://calendar.mozaico.xyz'
const WCPR_WORKSPACE = 'b633df69-d087-4422-a2ec-86651a400602'
const MOZAICO_WORKSPACE = 'c84365d1-e564-4690-a7d4-2268085bc5a2'
const SYNC_SECRET = 'calendar-sync-secret-that-is-at-least-32-bytes'

// Fake project hub: hub_session tokens map to hub users; an unknown token is "no session".
type HubUserSpec = { level: number; departments?: string[]; project?: string }
const tokenFor = (email: string) => (email.replace(/[^A-Za-z0-9]/gu, '_') + 'x'.repeat(43)).slice(0, 43)
function fakeHub(project: string, users: Record<string, HubUserSpec>) {
  return {
    verify: async (cookie: string, appKey: string) => {
      const email = Object.keys(users).find((candidate) => cookie.includes(`hub_session=${tokenFor(candidate)}`))
      if (!email || appKey !== 'calendar') return { ok: false, project, reason: 'no_session' }
      const user = users[email]
      return { ok: true, project: user.project ?? project, sessionId: `s-${email}`, userId: email, email, name: email.split('@')[0], level: user.level, levelName: String(user.level), departments: user.departments ?? [], allowed: true }
    },
    sessionActive: async () => true,
  }
}
const WCPR_USERS: Record<string, HubUserSpec> = { 'rprieto@wcpr.pro': { level: 1 }, 'ana@wcpr.pro': { level: 3 }, 'ben@wcpr.pro': { level: 3 } }

type TestEnv = Env & { CALENDAR_DB: ReturnType<typeof createD1> }
const ctx = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext
const call = (env: Env, request: Request) => worker.fetch(request, env, ctx)

async function wcprEnv(): Promise<TestEnv> {
  return { CALENDAR_DB: createD1(...calendarSchema, seeds['../seeds/wcpr.sql']), ASSETS: {} as Fetcher, CALENDAR_ADMIN_PASSWORD: '', SESSION_SECRET: 'wcpr-session-secret-at-least-32-bytes-long', CALENDAR_SYNC_SECRET: SYNC_SECRET, CRM_WEBHOOK_URL: 'https://crm.wcpr.pro/api/integrations/calendar/webhook', AUTH_MODE: 'employee', WORKSPACE_ID: WCPR_WORKSPACE, ADMIN_EMAILS: 'rprieto@wcpr.pro', BRAND_NAME: 'WCPR', SERVICE_NAME: 'wcpr-calendar', CRM_HOST: 'crm.wcpr.pro', LOCALE: 'en', TIMEZONE: 'America/Los_Angeles', HUB: fakeHub('wcpr', WCPR_USERS), HUB_PROJECT: 'wcpr', HUB_LOGIN_URL: 'https://hub.wcpr.pro/login?next=/go/calendar' } as unknown as TestEnv
}

async function mozaicoEnv(users: Record<string, HubUserSpec> = { 'rprieto@mozaico.xyz': { level: 1 } }): Promise<TestEnv> {
  return { CALENDAR_DB: createD1(...calendarSchema, seeds['../seeds/mozaico.sql']), ASSETS: {} as Fetcher, CALENDAR_ADMIN_PASSWORD: '', SESSION_SECRET: 'mozaico-session-secret-at-least-32-bytes', CALENDAR_SYNC_SECRET: SYNC_SECRET, CRM_WEBHOOK_URL: 'https://mozaico.xyz/api/integrations/calendar/webhook', AUTH_MODE: 'employee', WORKSPACE_ID: MOZAICO_WORKSPACE, ADMIN_EMAILS: 'rprieto@mozaico.xyz', BRAND_NAME: 'Mozaico', SERVICE_NAME: 'mozaico-calendar', CRM_HOST: 'mozaico.xyz', LOCALE: 'en', HUB: fakeHub('mozaico', users), HUB_PROJECT: 'mozaico', HUB_LOGIN_URL: 'https://hub.mozaico.xyz/login?next=/go/calendar' } as unknown as TestEnv
}

const api = (origin: string, path: string, init: RequestInit & { cookie?: string } = {}) => new Request(`${origin}${path}`, { ...init, headers: { 'content-type': 'application/json', origin, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) } })
// The calendar has no login of its own: being signed in means presenting a hub_session cookie.
const login = async (_env: Env, _origin: string, email: string, _password?: string) => ({ cookie: `hub_session=${tokenFor(email)}` })
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

describe('department grants', () => {
  let env: TestEnv
  beforeEach(async () => { env = await wcprEnv() })

  it('denies everything by default', async () => {
    const { cookie } = await login(env, ORIGIN_WCPR, 'ana@wcpr.pro')
    expect(await (await call(env, api(ORIGIN_WCPR, '/api/events', { cookie }))).json()).toEqual({ workspaceId: WCPR_WORKSPACE, events: [] })
    expect(await (await call(env, api(ORIGIN_WCPR, '/api/departments', { cookie }))).json()).toEqual({ departments: [] })
    expect((await call(env, api(ORIGIN_WCPR, '/api/events?department=sales', { cookie }))).status).toBe(403)
    expect((await call(env, api(ORIGIN_WCPR, '/api/events', { cookie, method: 'POST', body: eventBody('sales') }))).status).toBe(403)
    expect((await call(env, api(ORIGIN_WCPR, '/api/events'))).status).toBe(302)
  })

  it('isolates departments: viewers read, operators write, other departments stay invisible', async () => {
    grant(env, 'sales', 'ana@wcpr.pro', 'operator'); grant(env, 'operations', 'ana@wcpr.pro', 'viewer')
    insertEvent(env, 'finance-event', 'finance'); insertEvent(env, 'ops-event', 'operations')
    const { cookie } = await login(env, ORIGIN_WCPR, 'ana@wcpr.pro')
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
    const ben = (await login(env, ORIGIN_WCPR, 'ben@wcpr.pro')).cookie
    expect(((await (await call(env, api(ORIGIN_WCPR, '/api/events', { cookie: ben }))).json()) as { events: Array<{ id: string }> }).events.map((row) => row.id)).toEqual(['office-event'])
    const owner = (await login(env, ORIGIN_WCPR, 'rprieto@wcpr.pro')).cookie
    const departments = await (await call(env, api(ORIGIN_WCPR, '/api/departments', { cookie: owner }))).json() as { departments: Array<{ key: string; role: string }> }
    expect(departments.departments.map((row) => row.key).sort()).toEqual(['executive', 'finance', 'general', 'operations', 'sales'])
    expect(new Set(departments.departments.map((row) => row.role))).toEqual(new Set(['manager']))
  })

  it('rejects cross-origin writes from a valid browser session', async () => {
    grant(env, 'sales', 'ana@wcpr.pro', 'operator')
    const { cookie } = await login(env, ORIGIN_WCPR, 'ana@wcpr.pro')
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
    const ana = (await login(env, ORIGIN_WCPR, 'ana@wcpr.pro')).cookie
    const ben = (await login(env, ORIGIN_WCPR, 'ben@wcpr.pro')).cookie
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

  it('does not honor one project hub session in another project', async () => {
    const mozaico = await mozaicoEnv()
    const { cookie } = await login(mozaico, ORIGIN_WCPR, 'rprieto@wcpr.pro')
    const response = await call(mozaico, api(ORIGIN_MOZAICO, '/api/auth/session', { cookie }))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://hub.mozaico.xyz/login?next=/go/calendar')
    // Even if a hub answered for another project, the project field is checked.
    const crossed = await mozaicoEnv({ 'intruder@wcpr.pro': { level: 1, project: 'wcpr' } })
    expect((await call(crossed, api(ORIGIN_MOZAICO, '/api/events', { cookie: (await login(crossed, ORIGIN_MOZAICO, 'intruder@wcpr.pro')).cookie }))).status).toBe(403)
  })
})
