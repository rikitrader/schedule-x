/// <reference types="vite/client" />
import { beforeEach, describe, expect, it } from 'vitest'
import worker, { type Env } from './worker'
import { calendarSchema, createD1 } from './test/d1'
import { __resetHubLivenessCache, rolesForHubLevel, type HubIdentity } from './hub'

const seeds = import.meta.glob('../seeds/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const ORIGIN = 'https://calendar.wcpr.pro'
const HUB_COOKIE = 'hub_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ctx = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext

function identity(overrides: Partial<Extract<HubIdentity, { ok: true }>> = {}): HubIdentity {
  return { ok: true, project: 'wcpr', sessionId: 'hub-session-1', userId: 'u1', email: 'Staff@WCPR.pro', name: 'Staff Member', level: 3, levelName: 'Staff', departments: ['sales'], allowed: true, ...overrides }
}

function hubEnv(who: HubIdentity, extra: Partial<Env> = {}) {
  const state = { who, live: true, verifyCalls: [] as string[] }
  const env = {
    CALENDAR_DB: createD1(...calendarSchema, seeds['../seeds/wcpr.sql']), AUTH_DB: createD1("CREATE TABLE employees (email TEXT PRIMARY KEY, name TEXT, pass_hash TEXT, salt TEXT, iterations INTEGER, active INTEGER, must_change INTEGER, locked_until TEXT); CREATE TABLE two_factor_methods (email TEXT, status TEXT);"),
    ASSETS: { fetch: async () => new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/plain' } }) } as unknown as Fetcher,
    CALENDAR_ADMIN_PASSWORD: '', SESSION_SECRET: 'wcpr-session-secret-at-least-32-bytes-long', AUTH_MODE: 'employee', AUTH_PROVIDER: 'wcpr-employees', WORKSPACE_ID: 'b633df69-d087-4422-a2ec-86651a400602', ADMIN_EMAILS: 'rprieto@wcpr.pro', LOCALE: 'en', BRAND_NAME: 'WCPR', CRM_HOST: 'crm.wcpr.pro',
    HUB: { verify: async (cookie: string, appKey: string) => { state.verifyCalls.push(`${appKey}:${cookie}`); return state.who }, sessionActive: async () => state.live },
    HUB_PROJECT: 'wcpr', HUB_LOGIN_URL: 'https://hub.wcpr.pro/login', ...extra,
  } as unknown as Env
  return { env, state }
}

const call = (env: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx)
async function signIn(env: Env) { const response = await call(env, '/api/auth/hub', { headers: { cookie: HUB_COOKIE } }); return { response, cookie: (response.headers.get('set-cookie') || '').split(';')[0] } }
const session = async (env: Env, cookie: string) => (await call(env, '/api/auth/session', { headers: { cookie } })).json() as Promise<{ authenticated: boolean; user?: { email: string; admin: boolean }; departments?: Array<{ key: string; role: string }> }>
const eventBody = (departmentKey: string) => JSON.stringify({ title: 'Hub event', start: '2026-11-02T09:00:00-08:00[America/Los_Angeles]', end: '2026-11-02T10:00:00-08:00[America/Los_Angeles]', calendarId: 'team', departmentKey })

beforeEach(() => __resetHubLivenessCache())

describe('hub level mapping', () => {
  it('maps Owner/Manager/Staff/Limited to admin/manager/operator/viewer', () => {
    const all = ['executive', 'general', 'sales']
    expect(rolesForHubLevel(1, [], all)).toMatchObject({ admin: true })
    expect([...rolesForHubLevel(2, [], all).roles.values()]).toEqual(['manager', 'manager', 'manager'])
    expect([...rolesForHubLevel(3, ['sales', 'unknown'], all).roles]).toEqual([['sales', 'operator']])
    expect([...rolesForHubLevel(4, ['general'], all).roles]).toEqual([['general', 'viewer']])
  })
})

describe('hub sign-in', () => {
  it('signs a staff member in from the hub cookie with operator access to their departments only', async () => {
    const { env, state } = hubEnv(identity())
    const { response, cookie } = await signIn(env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect(state.verifyCalls).toEqual([`calendar:${HUB_COOKIE}`])
    expect(cookie).toMatch(/^__Host-calendar_session=hub\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
    const body = await session(env, cookie)
    expect(body).toMatchObject({ authenticated: true, user: { email: 'staff@wcpr.pro', admin: false }, departments: [{ key: 'sales', role: 'operator' }] })
    const write = (department: string) => call(env, '/api/events', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: eventBody(department) })
    expect((await write('sales')).status).toBe(201)
    expect((await write('finance')).status).toBe(403)
  })

  it('gives Limited users read-only access and Owners admin access', async () => {
    const limited = hubEnv(identity({ level: 4, departments: ['general'] }))
    const viewer = await session(limited.env, (await signIn(limited.env)).cookie)
    expect(viewer.departments).toEqual([expect.objectContaining({ key: 'general', role: 'viewer' })])
    expect((await call(limited.env, '/api/events', { method: 'POST', headers: { cookie: (await signIn(limited.env)).cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: eventBody('general') })).status).toBe(403)
    const owner = hubEnv(identity({ level: 1, email: 'boss@wcpr.pro', departments: [] }))
    const admin = await session(owner.env, (await signIn(owner.env)).cookie)
    expect(admin.user?.admin).toBe(true)
    expect(admin.departments).toHaveLength(5)
  })

  it('sends visitors without a hub session to the hub login', async () => {
    const { env } = hubEnv({ ok: false, project: 'wcpr', reason: 'no_session' })
    const response = await call(env, '/api/auth/hub')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://hub.wcpr.pro/login')
  })

  it('refuses another project hub, denied apps, and pending password changes', async () => {
    for (const who of [identity({ project: 'mozaico' }), identity({ allowed: false, reason: 'app_denied' }), identity({ allowed: false, reason: 'password_change_required' })]) {
      const { env } = hubEnv(who); const { response } = await signIn(env)
      expect(response.status).toBe(403)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
  })

  it('ends the calendar session when the hub session is revoked', async () => {
    const { env, state } = hubEnv(identity())
    const { cookie } = await signIn(env)
    state.live = false; __resetHubLivenessCache()
    expect(await session(env, cookie)).toEqual({ authenticated: false })
  })

  it('does not accept a hub session cookie signed by another deployment', async () => {
    const wcpr = hubEnv(identity()); const other = hubEnv(identity(), { SESSION_SECRET: 'mozaico-session-secret-at-least-32-bytes' })
    const { cookie } = await signIn(wcpr.env)
    expect(await session(other.env, cookie)).toEqual({ authenticated: false })
  })
})

describe('hub-first entry', () => {
  it('redirects the calendar root to hub sign-in when there is no session', async () => {
    const { env } = hubEnv(identity())
    const root = await call(env, '/')
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/api/auth/hub')
    const { cookie } = await signIn(env)
    expect((await call(env, '/', { headers: { cookie } })).status).toBe(200)
  })

  it('keeps the local password form only behind LOCAL_LOGIN=true', async () => {
    const closed = hubEnv(identity())
    expect((await call(closed.env, '/?local=1')).status).toBe(302)
    const login = (env: Env) => call(env, '/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@wcpr.pro', password: 'x' }) })
    expect((await login(closed.env)).status).toBe(403)
    const open = hubEnv(identity(), { LOCAL_LOGIN: 'true' })
    expect((await call(open.env, '/?local=1')).status).toBe(200)
    expect((await login(open.env)).status).toBe(401)
  })
})
