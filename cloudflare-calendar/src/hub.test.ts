/// <reference types="vite/client" />
import { beforeEach, describe, expect, it } from 'vitest'
import worker, { type Env } from './worker'
import { calendarSchema, createD1 } from './test/d1'
import { __resetHubCache, rolesForHubLevel, type HubIdentity } from './hub'

const seeds = import.meta.glob('../seeds/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const ORIGIN = 'https://calendar.wcpr.pro'
const HUB_COOKIE = 'hub_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ctx = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext
const HTML = '<!doctype html><html><body></body></html>'
// Workers' HTMLRewriter does not exist in Node; a pass-through keeps routing under test.
;(globalThis as { HTMLRewriter?: unknown }).HTMLRewriter ??= class { on() { return this } transform(response: Response) { return response } }

function identity(overrides: Partial<Extract<HubIdentity, { ok: true }>> = {}): HubIdentity {
  return { ok: true, project: 'wcpr', sessionId: 'hub-session-1', userId: 'u1', email: 'Staff@WCPR.pro', name: 'Staff Member', level: 3, levelName: 'Staff', departments: ['sales'], allowed: true, ...overrides }
}

function hubEnv(who: HubIdentity, extra: Record<string, unknown> = {}) {
  const state = { who, calls: [] as string[] }
  const env = {
    CALENDAR_DB: createD1(...calendarSchema, seeds['../seeds/wcpr.sql']),
    ASSETS: { fetch: async (request: Request) => new Response(new URL(request.url).pathname.startsWith('/assets/') ? 'console.log(1)' : HTML, { headers: { 'content-type': new URL(request.url).pathname.startsWith('/assets/') ? 'text/javascript' : 'text/html' } }) } as unknown as Fetcher,
    CALENDAR_ADMIN_PASSWORD: 'mipolitico-admin-password', SESSION_SECRET: 'wcpr-session-secret-at-least-32-bytes-long', AUTH_MODE: 'employee', WORKSPACE_ID: 'b633df69-d087-4422-a2ec-86651a400602', ADMIN_EMAILS: 'rprieto@wcpr.pro', LOCALE: 'en', BRAND_NAME: 'WCPR', CRM_HOST: 'crm.wcpr.pro',
    HUB: { verify: async (cookie: string, appKey: string) => { state.calls.push(`${appKey}:${cookie}`); return state.who }, sessionActive: async () => true },
    HUB_PROJECT: 'wcpr', HUB_LOGIN_URL: 'https://hub.wcpr.pro/login?next=/go/calendar', ...extra,
  } as unknown as Env
  return { env, state }
}

const call = (env: Env, path: string, init: RequestInit = {}, origin = ORIGIN) => worker.fetch(new Request(`${origin}${path}`, init), env, ctx)
const withHub = (init: RequestInit = {}) => ({ ...init, headers: { cookie: HUB_COOKIE, origin: ORIGIN, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } })
const session = async (env: Env) => (await call(env, '/api/auth/session', withHub())).json() as Promise<{ authenticated: boolean; user?: { email: string; admin: boolean }; departments?: Array<{ key: string; role: string }> }>
const eventBody = (departmentKey: string) => JSON.stringify({ title: 'Hub event', start: '2026-11-02T09:00:00-08:00[America/Los_Angeles]', end: '2026-11-02T10:00:00-08:00[America/Los_Angeles]', calendarId: 'team', departmentKey })

beforeEach(() => __resetHubCache())

describe('hub level mapping', () => {
  it('maps Owner/Manager/Staff/Limited to admin/manager/operator/viewer', () => {
    const all = ['executive', 'general', 'sales']
    expect(rolesForHubLevel(1, [], all)).toMatchObject({ admin: true })
    expect([...rolesForHubLevel(2, [], all).roles.values()]).toEqual(['manager', 'manager', 'manager'])
    expect([...rolesForHubLevel(3, ['sales', 'unknown'], all).roles]).toEqual([['sales', 'operator']])
    expect([...rolesForHubLevel(4, ['general'], all).roles]).toEqual([['general', 'viewer']])
  })
})

describe('hub-only employee calendars', () => {
  it('signs a staff member in from the hub cookie alone, with operator access to their departments', async () => {
    const { env, state } = hubEnv(identity())
    expect(await session(env)).toMatchObject({ authenticated: true, user: { email: 'staff@wcpr.pro', admin: false }, departments: [{ key: 'sales', role: 'operator' }] })
    expect(state.calls[0]).toBe(`calendar:${HUB_COOKIE}`)
    expect((await call(env, '/api/events', withHub({ method: 'POST', body: eventBody('sales') }))).status).toBe(201)
    expect((await call(env, '/api/events', withHub({ method: 'POST', body: eventBody('finance') }))).status).toBe(403)
    expect((await call(env, '/', withHub())).status).toBe(200)
  })

  it('gives Limited users read-only access and Owners admin access', async () => {
    const limited = hubEnv(identity({ level: 4, departments: ['general'] }))
    expect((await session(limited.env)).departments).toEqual([expect.objectContaining({ key: 'general', role: 'viewer' })])
    expect((await call(limited.env, '/api/events', withHub({ method: 'POST', body: eventBody('general') }))).status).toBe(403)
    __resetHubCache()
    const owner = hubEnv(identity({ level: 1, email: 'boss@wcpr.pro', departments: [] }))
    const admin = await session(owner.env)
    expect(admin.user?.admin).toBe(true)
    expect(admin.departments).toHaveLength(5)
  })

  it('sends every page, asset, and API read without a hub session to the hub login', async () => {
    const { env } = hubEnv({ ok: false, project: 'wcpr', reason: 'no_session' })
    for (const path of ['/', '/admin', '/assets/index.js', '/api/events', '/api/departments', '/api/auth/session', '/api/auth/hub', '/api/workspaces']) {
      const response = await call(env, path)
      expect([path, response.status, response.headers.get('location')]).toEqual([path, 302, 'https://hub.wcpr.pro/login?next=/go/calendar'])
    }
    expect((await call(env, '/api/events', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: eventBody('sales') })).status).toBe(401)
    expect((await call(env, '/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{"email":"a@wcpr.pro","password":"x"}' })).status).toBe(401)
    expect((await call(env, '/api/health')).status).not.toBe(302)
  })

  it('has no local sign-in: the old login endpoint does not exist even with a hub session', async () => {
    const { env } = hubEnv(identity())
    expect((await call(env, '/api/auth/login', withHub({ method: 'POST', body: '{"email":"staff@wcpr.pro","password":"x"}' }))).status).toBe(404)
  })

  it('returns to the requested page after the hub sign-in round trip', async () => {
    const signedOut = hubEnv({ ok: false, project: 'wcpr', reason: 'no_session' })
    const first = await call(signedOut.env, '/?department=sales')
    const parked = (first.headers.get('set-cookie') || '').split(';')[0]
    expect(parked).toBe('__Host-calendar_return=%2F%3Fdepartment%3Dsales')
    const signedIn = hubEnv(identity())
    const back = await call(signedIn.env, '/', { headers: { cookie: `${HUB_COOKIE}; ${parked}` } })
    expect([back.status, back.headers.get('location')]).toEqual([302, '/?department=sales'])
    expect((await call(signedIn.env, '/', { headers: { cookie: `${HUB_COOKIE}; __Host-calendar_return=${encodeURIComponent('//evil.example')}` } })).status).toBe(200)
  })

  it('refuses another project hub, denied apps, and pending password changes', async () => {
    for (const who of [identity({ project: 'mozaico' }), identity({ allowed: false, reason: 'app_denied' }), identity({ allowed: false, reason: 'password_change_required' })]) {
      __resetHubCache(); const { env } = hubEnv(who)
      expect((await call(env, '/', withHub())).status).toBe(403)
      expect((await call(env, '/api/events', withHub())).status).toBe(403)
    }
  })

  it('passes the whole Cookie header to the hub, whatever the hub names its cookie', async () => {
    const { env, state } = hubEnv(identity())
    const cookie = 'theme=dark; __Secure-hub_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    expect((await call(env, '/', { headers: { cookie } })).status).toBe(200)
    expect(state.calls).toEqual([`calendar:${cookie}`])
  })

  it('stops honoring the hub cookie once the hub session ends', async () => {
    const { env, state } = hubEnv(identity())
    expect((await session(env)).authenticated).toBe(true)
    state.who = { ok: false, project: 'wcpr', reason: 'no_session' }; __resetHubCache()
    expect((await call(env, '/api/auth/session', withHub())).status).toBe(302)
  })

  it('redirects HTTP to HTTPS and sends HSTS on every response', async () => {
    const { env } = hubEnv(identity())
    const plain = await call(env, '/admin?x=1', {}, 'http://calendar.wcpr.pro')
    expect([plain.status, plain.headers.get('location')]).toEqual([301, 'https://calendar.wcpr.pro/admin?x=1'])
    for (const response of [plain, await call(env, '/api/health'), await call(env, '/', withHub()), await call(hubEnv({ ok: false, project: 'wcpr', reason: 'no_session' }).env, '/')]) expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains')
  })
})

describe('MiPolitico password mode with optional hub', () => {
  const mipolitico = (who: HubIdentity, extra: Record<string, unknown> = {}) => hubEnv(who, { AUTH_MODE: undefined, LOCALE: undefined, BRAND_NAME: undefined, CRM_HOST: undefined, HUB_PROJECT: 'mipolitico', HUB_LOGIN_URL: 'https://hub.mipolitico.com/login?next=/go/calendar', ...extra })
  const MIP = 'https://calendar.mipolitico.com'

  it('keeps public viewing and the admin password until HUB_REQUIRED, and treats hub staff as administrators', async () => {
    const anonymous = mipolitico({ ok: false, project: 'mipolitico', reason: 'no_session' })
    expect((await call(anonymous.env, '/', {}, MIP)).status).toBe(200)
    expect(await (await call(anonymous.env, '/api/auth/session', {}, MIP)).json()).toEqual({ authenticated: false })
    expect((await call(anonymous.env, '/api/auth/login', { method: 'POST', headers: { origin: MIP, 'content-type': 'application/json' }, body: '{"password":"mipolitico-admin-password"}' }, MIP)).status).toBe(200)
    expect((await call(anonymous.env, '/api/auth/hub', {}, MIP)).headers.get('location')).toBe('https://hub.mipolitico.com/login?next=/go/calendar')
    const staff = mipolitico(identity({ project: 'mipolitico', level: 3 }))
    expect(await (await call(staff.env, '/api/auth/session', { headers: { cookie: HUB_COOKIE } }, MIP)).json()).toEqual({ authenticated: true })
    __resetHubCache()
    const limited = mipolitico(identity({ project: 'mipolitico', level: 4 }))
    expect(await (await call(limited.env, '/api/auth/session', { headers: { cookie: HUB_COOKIE } }, MIP)).json()).toEqual({ authenticated: false })
  })

  it('requires the hub for everything once HUB_REQUIRED=true', async () => {
    const { env } = mipolitico({ ok: false, project: 'mipolitico', reason: 'no_session' }, { HUB_REQUIRED: 'true' })
    expect((await call(env, '/', {}, MIP)).status).toBe(302)
    expect((await call(env, '/api/events', {}, MIP)).status).toBe(302)
    expect((await call(env, '/api/auth/login', { method: 'POST', headers: { origin: MIP, 'content-type': 'application/json' }, body: '{"password":"mipolitico-admin-password"}' }, MIP)).status).toBe(401)
  })
})
