/// <reference types="@cloudflare/workers-types" />
import { employeeSessionCookie, resolvePrincipal, roleAtLeast, SESSION_COOKIE, validEmail, verifyEmployeeLogin, type Principal, type Role } from './auth'
import { t, type MessageKey } from './i18n'
import { brandName, employeeWorkspace, locale, type Env } from './tenant'
import { ClientError, error, escapeHtml, json, requireSameOrigin } from './util'

// Department calendars "like email inboxes": every event belongs to one department, and users only see
// departments they hold a grant on (deny by default). Admins (ADMIN_EMAILS) see and manage everything.
export type EventInput = { title: string; start: string; end: string; isAllDay?: boolean; calendarId?: string; description?: string; location?: string }
export interface EventDeps {
  readJson(request: Request): Promise<unknown>
  validateEvent(value: unknown): EventInput
  eventFromRow(row: Record<string, unknown>): Record<string, unknown>
  outboxStatement(env: Env, workspaceId: string, eventId: string, eventType: string, payload: unknown, now: string): D1PreparedStatement
  drainWebhookOutbox(env: Env): Promise<void>
  ensureWorkspace(env: Env, workspaceId: string, name?: string, source?: 'local' | 'crm'): Promise<void>
}

const ROLES: Role[] = ['viewer', 'operator', 'manager']
export const validDepartmentKey = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/u.test(value)
const message = (env: Env, key: MessageKey) => t(locale(env), key)
const deny = (env: Env, key: MessageKey, status: number) => error(message(env, key), status)

async function audit(env: Env, actor: Principal, action: string, departmentKey: string | null, target: string | null, detail: Record<string, unknown> = {}) {
  await env.CALENDAR_DB.prepare('INSERT INTO calendar_audit_log (id, actor, action, department_key, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), `${actor.kind}:${actor.email}`, action, departmentKey, target, JSON.stringify(detail), new Date().toISOString()).run()
}

async function visibleDepartments(env: Env, principal: Principal) {
  const rows = await env.CALENDAR_DB.prepare('SELECT key, name, agent_key AS agentKey, agent_name AS agentName FROM calendar_departments WHERE enabled = 1 ORDER BY name, key').all<{ key: string; name: string; agentKey: string; agentName: string }>()
  return rows.results.filter((row) => principal.roles.has(row.key)).map((row) => ({ ...row, role: principal.roles.get(row.key) }))
}

async function sessionBody(env: Env, principal: Principal) {
  return { authenticated: true, user: { email: principal.email, name: principal.name, admin: principal.admin, kind: principal.kind }, departments: await visibleDepartments(env, principal) }
}

async function listDepartmentEvents(request: Request, env: Env, principal: Principal, deps: EventDeps) {
  const url = new URL(request.url); const requested = url.searchParams.get('department'); const from = url.searchParams.get('from'); const to = url.searchParams.get('to')
  if (requested && !principal.roles.has(requested)) return deny(env, 'forbidden', 403)
  const departments = requested ? [requested] : [...principal.roles.keys()]; const workspaceId = employeeWorkspace(env)
  if (departments.length === 0) return json({ workspaceId, events: [] })
  let statement = `SELECT * FROM calendar_events WHERE workspace_id = ? AND department_key IN (${departments.map(() => '?').join(',')})`; const values = [workspaceId, ...departments]
  if (from && to) { statement += ' AND end_at >= ? AND start_at <= ?'; values.push(from, to) }
  const rows = await env.CALENDAR_DB.prepare(`${statement} ORDER BY start_at ASC LIMIT 5000`).bind(...values).all()
  return json({ workspaceId, events: rows.results.map((row) => deps.eventFromRow(row as Record<string, unknown>)) })
}

function requestedDepartment(env: Env, body: unknown) { const key = body && typeof body === 'object' ? (body as Record<string, unknown>).departmentKey : undefined; if (!validDepartmentKey(key)) throw new ClientError(message(env, 'invalidDepartment')); return key }

async function createDepartmentEvent(request: Request, env: Env, ctx: ExecutionContext, principal: Principal, deps: EventDeps) {
  const body = await deps.readJson(request); const input = deps.validateEvent(body); const departmentKey = requestedDepartment(env, body)
  if (!roleAtLeast(principal.roles.get(departmentKey), 'operator')) return deny(env, 'forbidden', 403)
  const workspaceId = employeeWorkspace(env); const id = crypto.randomUUID(); const now = new Date().toISOString(); const event = { id, workspaceId, departmentKey, ...input, source: 'calendar', revision: 1, createdAt: now, updatedAt: now }
  await deps.ensureWorkspace(env, workspaceId, brandName(env), 'crm')
  await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare(`INSERT INTO calendar_events (workspace_id,id,title,start_at,end_at,is_all_day,calendar_id,description,location,source,revision,created_at,updated_at,department_key) VALUES (?,?,?,?,?,?,?,?,?,'calendar',1,?,?,?)`).bind(workspaceId, id, input.title, input.start, input.end, input.isAllDay ? 1 : 0, input.calendarId, input.description, input.location, now, now, departmentKey), deps.outboxStatement(env, workspaceId, id, 'calendar.event.created', { event }, now)])
  await audit(env, principal, 'event.created', departmentKey, id, { title: input.title }); ctx.waitUntil(deps.drainWebhookOutbox(env)); return json({ event }, 201)
}

async function updateDepartmentEvent(request: Request, env: Env, ctx: ExecutionContext, principal: Principal, id: string, deps: EventDeps) {
  const body = await deps.readJson(request); const input = deps.validateEvent(body); const departmentKey = requestedDepartment(env, body); const workspaceId = employeeWorkspace(env)
  const existing = await env.CALENDAR_DB.prepare('SELECT revision, department_key FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id).first<{ revision: number; department_key: string }>()
  // Events in departments the caller cannot see are reported as missing, never as forbidden.
  if (!existing || !principal.roles.has(existing.department_key)) return deny(env, 'notFound', 404)
  if (!roleAtLeast(principal.roles.get(existing.department_key), 'operator') || !roleAtLeast(principal.roles.get(departmentKey), 'operator')) return deny(env, 'forbidden', 403)
  const revision = Number(existing.revision) + 1; const now = new Date().toISOString(); const event = { id, workspaceId, departmentKey, ...input, source: 'calendar', revision, updatedAt: now }
  await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare(`UPDATE calendar_events SET title=?,start_at=?,end_at=?,is_all_day=?,calendar_id=?,description=?,location=?,source='calendar',revision=?,updated_at=?,department_key=? WHERE workspace_id=? AND id=?`).bind(input.title, input.start, input.end, input.isAllDay ? 1 : 0, input.calendarId, input.description, input.location, revision, now, departmentKey, workspaceId, id), deps.outboxStatement(env, workspaceId, id, 'calendar.event.updated', { event }, now)])
  await audit(env, principal, 'event.updated', departmentKey, id, existing.department_key === departmentKey ? {} : { movedFrom: existing.department_key }); ctx.waitUntil(deps.drainWebhookOutbox(env))
  const row = await env.CALENDAR_DB.prepare('SELECT * FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id).first(); return json({ event: deps.eventFromRow(row as Record<string, unknown>) })
}

async function deleteDepartmentEvent(env: Env, ctx: ExecutionContext, principal: Principal, id: string, deps: EventDeps) {
  const workspaceId = employeeWorkspace(env); const existing = await env.CALENDAR_DB.prepare('SELECT revision, department_key FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id).first<{ revision: number; department_key: string }>()
  if (!existing || !principal.roles.has(existing.department_key)) return deny(env, 'notFound', 404)
  if (!roleAtLeast(principal.roles.get(existing.department_key), 'operator')) return deny(env, 'forbidden', 403)
  const now = new Date().toISOString(); const payload = { event: { id, workspaceId, departmentKey: existing.department_key, revision: Number(existing.revision) + 1, updatedAt: now } }
  await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare('DELETE FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, id), deps.outboxStatement(env, workspaceId, id, 'calendar.event.deleted', payload, now)])
  await audit(env, principal, 'event.deleted', existing.department_key, id); ctx.waitUntil(deps.drainWebhookOutbox(env)); return new Response(null, { status: 204 })
}

export async function handleEmployeeApi(request: Request, env: Env, ctx: ExecutionContext, deps: EventDeps): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    if (!requireSameOrigin(request)) return deny(env, 'badOrigin', 403)
    const body = await deps.readJson(request) as { email?: unknown; password?: unknown }; const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''; const password = typeof body.password === 'string' ? body.password : ''
    if (!validEmail(email) || !password || password.length > 512) return deny(env, 'invalidCredentials', 401)
    const result = await verifyEmployeeLogin(env, email, password); if (!result.ok) return deny(env, result.key, result.status)
    const cookie = await employeeSessionCookie(env, result.email); const principal = await resolvePrincipal(new Request(request.url, { headers: { cookie: cookie.split(';')[0] } }), env)
    if (!principal) return deny(env, 'invalidCredentials', 401)
    return json(await sessionBody(env, principal), 200, { 'set-cookie': cookie })
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') { if (!requireSameOrigin(request)) return deny(env, 'badOrigin', 403); return json({ authenticated: false }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }) }
  const principal = await resolvePrincipal(request, env)
  if (url.pathname === '/api/auth/session' && request.method === 'GET') return json(principal ? await sessionBody(env, principal) : { authenticated: false })
  if (!principal) return deny(env, 'authRequired', 401)
  // Browser sessions must come from this origin; agents authenticate with a bearer token and have no origin.
  if (request.method !== 'GET' && principal.kind === 'user' && !requireSameOrigin(request)) return deny(env, 'badOrigin', 403)
  if (url.pathname === '/api/departments' && request.method === 'GET') return json({ departments: await visibleDepartments(env, principal) })
  if (url.pathname === '/api/events' && request.method === 'GET') return listDepartmentEvents(request, env, principal, deps)
  if (url.pathname === '/api/events' && request.method === 'POST') return createDepartmentEvent(request, env, ctx, principal, deps)
  const match = url.pathname.match(/^\/api\/events\/([A-Za-z0-9][A-Za-z0-9_.:@-]{0,191})$/u)
  if (match && request.method === 'PUT') return updateDepartmentEvent(request, env, ctx, principal, match[1], deps)
  if (match && request.method === 'DELETE') return deleteDepartmentEvent(env, ctx, principal, match[1], deps)
  return deny(env, 'routeNotFound', 404)
}

// ---- /admin: grants and agent assignment (server-rendered, no script, same-origin form posts) ----

type DepartmentRow = { key: string; name: string; agent_key: string; agent_name: string; owner_email: string; enabled: number }
type GrantRow = { id: string; department_key: string; subject: string; role: Role; created_by: string; created_at: string }
const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': ADMIN_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' } })

function adminPage(env: Env, principal: Principal, departments: DepartmentRow[], grants: GrantRow[], log: Array<Record<string, unknown>>, notice: string) {
  const brand = escapeHtml(brandName(env)); const manageable = departments.filter((d) => principal.admin || roleAtLeast(principal.roles.get(d.key), 'manager'))
  const roleOptions = ROLES.map((role) => `<option value="${role}">${role}</option>`).join('')
  const departmentRows = manageable.map((d) => principal.admin
    ? `<tr><td><b>${escapeHtml(d.name)}</b><br><code>${escapeHtml(d.key)}</code></td><td colspan="4"><form method="post" class="inline"><input type="hidden" name="action" value="update_department"><input type="hidden" name="department" value="${escapeHtml(d.key)}"><input name="name" value="${escapeHtml(d.name)}" aria-label="Name" maxlength="80" required><input name="agent_key" value="${escapeHtml(d.agent_key)}" aria-label="Agent key" maxlength="64"><input name="agent_name" value="${escapeHtml(d.agent_name)}" aria-label="Agent name" maxlength="80"><input name="owner_email" value="${escapeHtml(d.owner_email)}" aria-label="Owner email" maxlength="254"><label><input type="checkbox" name="enabled" value="1"${d.enabled ? ' checked' : ''}> enabled</label><button>Save</button></form></td></tr>`
    : `<tr><td><b>${escapeHtml(d.name)}</b><br><code>${escapeHtml(d.key)}</code></td><td>${escapeHtml(d.agent_name || '—')}</td><td>${escapeHtml(d.owner_email || '—')}</td><td>${d.enabled ? 'enabled' : 'disabled'}</td><td></td></tr>`).join('')
  const visibleKeys = new Set(manageable.map((d) => d.key))
  const grantRows = grants.filter((g) => visibleKeys.has(g.department_key)).map((g) => `<tr><td><code>${escapeHtml(g.department_key)}</code></td><td>${g.subject === '*' ? '<i>everyone (department-wide)</i>' : escapeHtml(g.subject)}</td><td>${escapeHtml(g.role)}</td><td>${escapeHtml(g.created_by)}</td><td><form method="post"><input type="hidden" name="action" value="revoke_grant"><input type="hidden" name="grant" value="${escapeHtml(g.id)}"><button class="danger">Revoke</button></form></td></tr>`).join('') || '<tr><td colspan="5">No grants yet. Users without a grant see nothing.</td></tr>'
  const logRows = log.map((row) => `<tr><td>${escapeHtml(row.created_at)}</td><td>${escapeHtml(row.actor)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.department_key ?? '')}</td><td>${escapeHtml(row.target ?? '')}</td></tr>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Calendar admin · ${brand}</title><style>
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0b1f3a;background:#f5f8fc}header{background:#07182f;color:#fff;padding:1rem clamp(1rem,4vw,3rem);display:flex;justify-content:space-between;align-items:center}header a{color:#c6d3e3}main{max-width:1200px;margin:0 auto;padding:1.5rem clamp(1rem,4vw,3rem) 3rem}section{background:#fff;border:1px solid #dce4ee;border-radius:14px;padding:1.2rem;margin-bottom:1.4rem;overflow-x:auto}h2{margin:.2rem 0 1rem;font-size:1.2rem}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.55rem .4rem;border-bottom:1px solid #edf1f6;vertical-align:middle}th{color:#60728b;font-weight:600;font-size:.8rem}input,select,button{font:inherit;border:1px solid #c9d4e2;border-radius:8px;padding:.45rem .6rem;background:#fff}button{cursor:pointer;background:#145dda;color:#fff;border-color:#145dda}button.danger{background:#fff;color:#b42318;border-color:#f2b8b5}form.inline{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}.notice{background:#ecfdf3;border:1px solid #abefc6;padding:.7rem 1rem;border-radius:10px;margin-bottom:1rem}code{font-size:.8rem;color:#475467}
</style></head><body><header><b>${brand} · Calendar admin</b><span>${escapeHtml(principal.email)} · <a href="/">Back to calendar</a></span></header><main>${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}
<section><h2>Departments &amp; agents</h2><table><thead><tr><th>Department</th><th colspan="4">${principal.admin ? 'Name · Agent key · Agent name · Owner · Enabled' : 'Agent · Owner · Status'}</th></tr></thead><tbody>${departmentRows}</tbody></table></section>
<section><h2>Access grants</h2><p>viewer = read · operator = create/edit · manager = operator + manage grants. Use <code>*</code> for a department-wide grant.</p><form method="post" class="inline"><input type="hidden" name="action" value="add_grant"><select name="department" aria-label="Department">${manageable.map((d) => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.name)}</option>`).join('')}</select><input name="subject" placeholder="employee@domain or *" aria-label="Employee email" required maxlength="254"><select name="role" aria-label="Role">${roleOptions}</select><button>Grant</button></form>
<table><thead><tr><th>Department</th><th>Who</th><th>Role</th><th>Granted by</th><th></th></tr></thead><tbody>${grantRows}</tbody></table></section>
${principal.admin ? `<section><h2>Audit log</h2><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Department</th><th>Target</th></tr></thead><tbody>${logRows}</tbody></table></section>` : ''}</main></body></html>`
}

async function applyAdminAction(env: Env, principal: Principal, form: FormData): Promise<string> {
  const action = String(form.get('action') ?? '')
  if (action === 'add_grant') {
    const department = String(form.get('department') ?? ''); const subject = String(form.get('subject') ?? '').trim().toLowerCase(); const role = String(form.get('role') ?? '') as Role
    if (!validDepartmentKey(department) || !ROLES.includes(role) || (subject !== '*' && !validEmail(subject))) return 'Invalid grant.'
    if (!principal.admin && !roleAtLeast(principal.roles.get(department), 'manager')) return 'You cannot manage that department.'
    const exists = await env.CALENDAR_DB.prepare('SELECT 1 FROM calendar_departments WHERE key = ?').bind(department).first(); if (!exists) return 'Unknown department.'
    await env.CALENDAR_DB.prepare('INSERT INTO calendar_grants (id, department_key, subject, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(department_key, subject) DO UPDATE SET role = excluded.role, created_by = excluded.created_by, created_at = excluded.created_at').bind(crypto.randomUUID(), department, subject, role, principal.email, new Date().toISOString()).run()
    await audit(env, principal, 'grant.upserted', department, subject, { role }); return `Granted ${role} on ${department} to ${subject}.`
  }
  if (action === 'revoke_grant') {
    const grant = await env.CALENDAR_DB.prepare('SELECT * FROM calendar_grants WHERE id = ?').bind(String(form.get('grant') ?? '')).first<GrantRow>(); if (!grant) return 'Grant not found.'
    if (!principal.admin && !roleAtLeast(principal.roles.get(grant.department_key), 'manager')) return 'You cannot manage that department.'
    await env.CALENDAR_DB.prepare('DELETE FROM calendar_grants WHERE id = ?').bind(grant.id).run(); await audit(env, principal, 'grant.revoked', grant.department_key, grant.subject, { role: grant.role }); return `Revoked ${grant.role} on ${grant.department_key} from ${grant.subject}.`
  }
  if (action === 'update_department') {
    if (!principal.admin) return 'Only administrators can assign agents.'
    const department = String(form.get('department') ?? ''); const name = String(form.get('name') ?? '').trim(); const agentKey = String(form.get('agent_key') ?? '').trim(); const agentName = String(form.get('agent_name') ?? '').trim(); const owner = String(form.get('owner_email') ?? '').trim().toLowerCase(); const enabled = form.get('enabled') === '1' ? 1 : 0
    if (!validDepartmentKey(department) || !name || name.length > 80 || !/^[a-z0-9-]{0,64}$/u.test(agentKey) || agentName.length > 80 || (owner && !validEmail(owner))) return 'Invalid department settings.'
    const result = await env.CALENDAR_DB.prepare('UPDATE calendar_departments SET name = ?, agent_key = ?, agent_name = ?, owner_email = ?, enabled = ?, updated_at = ? WHERE key = ?').bind(name, agentKey, agentName, owner, enabled, new Date().toISOString(), department).run()
    if (Number(result.meta.changes) !== 1) return 'Unknown department.'
    await audit(env, principal, 'department.updated', department, agentKey, { name, agentName, owner, enabled }); return `Saved ${department}.`
  }
  return 'Unknown action.'
}

export async function handleAdmin(request: Request, env: Env) {
  const principal = await resolvePrincipal(request, env)
  if (!principal || principal.kind !== 'user') return Response.redirect(new URL('/', request.url).toString(), 303)
  if (!principal.admin && ![...principal.roles.values()].some((role) => role === 'manager')) return html('<!doctype html><title>Forbidden</title><p>Calendar administration is limited to administrators and department managers. <a href="/">Back</a></p>', 403)
  let notice = ''
  if (request.method === 'POST') { if (!requireSameOrigin(request)) return html('<!doctype html><title>Forbidden</title><p>Origin not allowed.</p>', 403); notice = await applyAdminAction(env, principal, await request.formData()) }
  else if (request.method !== 'GET') return html('<!doctype html><title>Method not allowed</title>', 405)
  const fresh = (await resolvePrincipal(request, env)) ?? principal
  const [departments, grants, log] = await Promise.all([
    env.CALENDAR_DB.prepare('SELECT key, name, agent_key, agent_name, owner_email, enabled FROM calendar_departments ORDER BY name, key').all<DepartmentRow>(),
    env.CALENDAR_DB.prepare('SELECT * FROM calendar_grants ORDER BY department_key, subject').all<GrantRow>(),
    env.CALENDAR_DB.prepare('SELECT created_at, actor, action, department_key, target FROM calendar_audit_log ORDER BY created_at DESC LIMIT 50').all(),
  ])
  return html(adminPage(env, fresh, departments.results, grants.results, log.results, notice))
}
