/// <reference types="@cloudflare/workers-types" />
// AccuLynx → calendar sync (WCPR only). Runs on its own cron, three times a day. AccuLynx is the source of truth for the
// appointments it owns: new ones are created, changed ones updated, removed ones deleted. Every write also queues a
// CRM outbox row, which the every-minute drain delivers 25 at a time, so a big backfill never bursts the CRM.
import { Temporal } from 'temporal-polyfill'
import type { Env } from './tenant'
import { employeeWorkspace, timezone } from './tenant'
import { sha256 } from './util'

const ALX = 'https://api.acculynx.com/api/v2'
/** 06:00, 12:00 and 17:00 Pacific in winter (UTC-8); an hour later in summer. */
export const ACCULYNX_SYNC_CRON = '0 1,14,20 * * *'
const COMPANY_CALENDAR = 'West Coast Precision Roofing'
/** AccuLynx calendar name → calendar department comes from the ACCULYNX_CALENDAR_DEPARTMENTS secret (JSON object), because
 *  calendar names are staff names and this repo is public. Unlisted calendars go to "general". */
export function departmentMap(env: Pick<Env, 'ACCULYNX_CALENDAR_DEPARTMENTS'>): Record<string, string> {
  try { const parsed = JSON.parse(env.ACCULYNX_CALENDAR_DEPARTMENTS || ''); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}
const WINDOW_DAYS = 89 // AccuLynx caps an appointment query at 90 days
const LIVE_PAST_DAYS = 30
const LIVE_FUTURE_DAYS = 365
const BACKFILL_FROM = '2019-01-01'
const BACKFILL_WINDOWS_PER_RUN = 12
const MAX_DESCRIPTION = 4000

export type Appointment = { id: string; title?: string | null; start: string; end: string; allDay?: unknown; location?: string | null; notes?: string | null; eventType?: string | null; calendar: string }
export type SyncedEvent = { title: string; start: string; end: string; isAllDay: boolean; calendarId: 'team'; description: string; location: string; departmentKey: string }
export type OutboxFn = (env: Env, workspaceId: string, eventId: string, eventType: string, payload: unknown, now: string) => D1PreparedStatement
type Window = { from: Temporal.PlainDate; to: Temporal.PlainDate }
type MappingRow = { appointment_id: string; event_id: string; start_date: string; fingerprint: string; revision: number | null }

export const syncEnabled = (env: Env) => Boolean(env.ACCULYNX_API_KEY) && env.ACCULYNX_SYNC === 'true' && Object.keys(departmentMap(env)).length > 0

/** AccuLynx sends allDay as the string "False"/"True". */
const isTrue = (value: unknown) => value === true || String(value).toLowerCase() === 'true'

export function toEvent(a: Appointment, tz: string, departments: Record<string, string>): SyncedEvent {
  const s = Temporal.Instant.from(a.start).toZonedDateTimeISO(tz)
  let e = Temporal.Instant.from(a.end).toZonedDateTimeISO(tz)
  const allDay = isTrue(a.allDay)
  let start: string, end: string
  if (allDay) {
    const sd = s.toPlainDate(); let ed = e.toPlainDate()
    if (Temporal.PlainDate.compare(ed, sd) <= 0) ed = sd.add({ days: 1 })
    start = sd.toString(); end = ed.toString()
  } else {
    if (Temporal.ZonedDateTime.compare(e, s) <= 0) e = s.add({ minutes: 30 }) // AccuLynx allows zero-length appointments; the calendar does not
    start = s.toString({ smallestUnit: 'minute' }); end = e.toString({ smallestUnit: 'minute' })
  }
  const tail = `Calendar: ${a.calendar} · ${a.eventType || 'Appointment'}\nAccuLynx #${a.id}` // the marker must survive truncation
  const raw = (a.notes || '').trim(); const notes = raw && raw !== 'N/A' ? raw : ''
  const description = notes ? `${notes.slice(0, MAX_DESCRIPTION - tail.length - 1)}\n${tail}` : tail
  const location = (a.location || '').replace(/\s*\n\s*/gu, ' ').trim().slice(0, 300)
  return { title: ((a.title || '').trim() || 'AccuLynx appointment').slice(0, 200), start, end, isAllDay: allDay, calendarId: 'team', description, location, departmentKey: departments[a.calendar] ?? 'general' }
}

async function alx<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${ALX}${path}`, { headers: { authorization: `Bearer ${env.ACCULYNX_API_KEY}`, accept: 'application/json', 'user-agent': 'wcpr-calendar-sync' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`acculynx_http_${response.status}:${path.split('?')[0]}`)
  return response.json() as Promise<T>
}

async function paged<T>(env: Env, path: string): Promise<T[]> {
  const items: T[] = []; const sep = path.includes('?') ? '&' : '?'
  for (let index = 0; ; index += 50) {
    const page = await alx<{ count?: number; items?: T[] }>(env, `${path}${sep}pageSize=50&pageStartIndex=${index}`)
    items.push(...(page.items ?? []))
    if (index + 50 >= (page.count ?? 0) || !page.items?.length) return items
  }
}

/** Every appointment in the windows, across all calendars. The same appointment can sit on the company calendar and a person's; the person wins. */
export async function fetchAppointments(env: Env, windows: Window[]) {
  const calendars = await paged<{ id: string; name: string }>(env, '/calendars')
  const seen = new Map<string, Appointment>()
  for (const w of windows) for (const c of calendars) {
    for (const a of await paged<Omit<Appointment, 'calendar'>>(env, `/calendars/${c.id}/appointments?startDate=${w.from}&endDate=${w.to}`)) {
      const prior = seen.get(a.id)
      if (!prior || prior.calendar === COMPANY_CALENDAR) seen.set(a.id, { ...a, calendar: c.name })
    }
  }
  return seen
}

export function splitWindows(from: Temporal.PlainDate, to: Temporal.PlainDate): Window[] {
  const out: Window[] = []
  for (let s = from; Temporal.PlainDate.compare(s, to) <= 0; s = s.add({ days: WINDOW_DAYS + 1 })) {
    const e = s.add({ days: WINDOW_DAYS }); out.push({ from: s, to: Temporal.PlainDate.compare(e, to) > 0 ? to : e })
  }
  return out
}

async function readState(env: Env, key: string) { return (await env.CALENDAR_DB.prepare('SELECT value FROM acculynx_sync_state WHERE key=?').bind(key).first<{ value: string }>())?.value ?? null }
const writeState = (env: Env, key: string, value: string, now: string) => env.CALENDAR_DB.prepare('INSERT INTO acculynx_sync_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key, value, now)

const inWindows = (date: string, windows: Window[]) => windows.some((w) => date >= w.from.toString() && date <= w.to.toString())

/** Pure plan: what to create, update and delete. Deletes only for appointments whose last known date is inside a window that was fully fetched. */
export async function planChanges(appointments: Map<string, Appointment>, mapping: MappingRow[], windows: Window[], tz: string, departments: Record<string, string>) {
  const byAppointment = new Map(mapping.map((row) => [row.appointment_id, row]))
  const creates: Array<{ appointmentId: string; event: SyncedEvent; fingerprint: string; eventId?: string }> = []
  const updates: Array<{ appointmentId: string; event: SyncedEvent; fingerprint: string; eventId: string; revision: number }> = []
  for (const a of appointments.values()) {
    const event = toEvent(a, tz, departments); const fingerprint = await sha256(JSON.stringify(event)); const row = byAppointment.get(a.id)
    if (!row) creates.push({ appointmentId: a.id, event, fingerprint })
    else if (row.revision === null) creates.push({ appointmentId: a.id, event, fingerprint, eventId: row.event_id }) // event was deleted in the calendar; AccuLynx still has it
    else if (row.fingerprint !== fingerprint) updates.push({ appointmentId: a.id, event, fingerprint, eventId: row.event_id, revision: row.revision })
  }
  const deletes = mapping.filter((row) => !appointments.has(row.appointment_id) && inWindows(row.start_date, windows))
  return { creates, updates, deletes }
}

export async function runAccuLynxSync(env: Env, outbox: OutboxFn, nowDate = new Date()) {
  if (!syncEnabled(env)) return { skipped: true }
  const tz = timezone(env); const workspaceId = employeeWorkspace(env); const now = nowDate.toISOString()
  const today = Temporal.Instant.from(now).toZonedDateTimeISO(tz).toPlainDate()
  const liveFrom = today.subtract({ days: LIVE_PAST_DAYS })
  const windows = splitWindows(liveFrom, today.add({ days: LIVE_FUTURE_DAYS }))
  // Backfill: walk history forward from the cursor, a bounded number of windows per run, until it meets the live range.
  const cursor = Temporal.PlainDate.from((await readState(env, 'backfill_cursor')) ?? BACKFILL_FROM)
  let nextCursor = cursor
  if (Temporal.PlainDate.compare(cursor, liveFrom) < 0) {
    const backfill = splitWindows(cursor, liveFrom.subtract({ days: 1 })).slice(0, BACKFILL_WINDOWS_PER_RUN)
    windows.push(...backfill); nextCursor = backfill[backfill.length - 1].to.add({ days: 1 })
  }
  try {
    const appointments = await fetchAppointments(env, windows)
    const mapping = (await env.CALENDAR_DB.prepare('SELECT m.appointment_id, m.event_id, m.start_date, m.fingerprint, e.revision FROM acculynx_appointments m LEFT JOIN calendar_events e ON e.workspace_id=? AND e.id=m.event_id').bind(workspaceId).all<MappingRow>()).results
    const plan = await planChanges(appointments, mapping, windows, tz, departmentMap(env))
    // Safety: an AccuLynx outage that returns empty pages must not wipe the calendar.
    const candidates = mapping.filter((row) => inWindows(row.start_date, windows)).length
    const deletesBlocked = plan.deletes.length > 20 && plan.deletes.length > candidates / 2
    const statements: D1PreparedStatement[] = []
    const mapStatement = (appointmentId: string, eventId: string, start: string, fingerprint: string) => env.CALENDAR_DB.prepare('INSERT INTO acculynx_appointments (appointment_id,event_id,start_date,fingerprint,synced_at) VALUES (?,?,?,?,?) ON CONFLICT(appointment_id) DO UPDATE SET event_id=excluded.event_id,start_date=excluded.start_date,fingerprint=excluded.fingerprint,synced_at=excluded.synced_at').bind(appointmentId, eventId, start.slice(0, 10), fingerprint, now)
    for (const c of plan.creates) {
      const id = c.eventId ?? crypto.randomUUID(); const e = c.event
      statements.push(env.CALENDAR_DB.prepare(`INSERT INTO calendar_events (workspace_id,id,title,start_at,end_at,is_all_day,calendar_id,description,location,source,revision,created_at,updated_at,department_key) VALUES (?,?,?,?,?,?,?,?,?,'calendar',1,?,?,?)`).bind(workspaceId, id, e.title, e.start, e.end, e.isAllDay ? 1 : 0, e.calendarId, e.description, e.location, now, now, e.departmentKey))
      statements.push(outbox(env, workspaceId, id, 'calendar.event.created', { event: { id, workspaceId, ...e, source: 'calendar', revision: 1, createdAt: now, updatedAt: now } }, now))
      statements.push(mapStatement(c.appointmentId, id, e.start, c.fingerprint))
    }
    for (const u of plan.updates) {
      const e = u.event; const revision = u.revision + 1
      statements.push(env.CALENDAR_DB.prepare(`UPDATE calendar_events SET title=?,start_at=?,end_at=?,is_all_day=?,calendar_id=?,description=?,location=?,source='calendar',revision=?,updated_at=?,department_key=? WHERE workspace_id=? AND id=?`).bind(e.title, e.start, e.end, e.isAllDay ? 1 : 0, e.calendarId, e.description, e.location, revision, now, e.departmentKey, workspaceId, u.eventId))
      statements.push(outbox(env, workspaceId, u.eventId, 'calendar.event.updated', { event: { id: u.eventId, workspaceId, ...e, source: 'calendar', revision, updatedAt: now } }, now))
      statements.push(mapStatement(u.appointmentId, u.eventId, e.start, u.fingerprint))
    }
    if (!deletesBlocked) for (const d of plan.deletes) {
      if (d.revision !== null) {
        statements.push(env.CALENDAR_DB.prepare('DELETE FROM calendar_events WHERE workspace_id=? AND id=?').bind(workspaceId, d.event_id))
        statements.push(outbox(env, workspaceId, d.event_id, 'calendar.event.deleted', { event: { id: d.event_id, workspaceId, revision: d.revision + 1, updatedAt: now } }, now))
      }
      statements.push(env.CALENDAR_DB.prepare('DELETE FROM acculynx_appointments WHERE appointment_id=?').bind(d.appointment_id))
    }
    for (let i = 0; i < statements.length; i += 60) await env.CALENDAR_DB.batch(statements.slice(i, i + 60))
    const result = { ok: true, ranAt: now, windows: windows.length, fetched: appointments.size, created: plan.creates.length, updated: plan.updates.length, deleted: deletesBlocked ? 0 : plan.deletes.length, deletesBlocked, backfillCursor: nextCursor.toString() }
    await env.CALENDAR_DB.batch([writeState(env, 'backfill_cursor', nextCursor.toString(), now), writeState(env, 'last_result', JSON.stringify(result), now)])
    console.log(JSON.stringify({ msg: 'acculynx_sync', ...result }))
    return result
  } catch (caught) {
    const result = { ok: false, ranAt: now, error: String(caught).slice(0, 300) }
    await writeState(env, 'last_result', JSON.stringify(result), now).run()
    console.error(JSON.stringify({ msg: 'acculynx_sync_failed', ...result }))
    return result
  }
}

export async function syncStatus(env: Env) {
  if (!syncEnabled(env)) return null
  const value = await readState(env, 'last_result').catch(() => null)
  // /api/health is public: expose only whether the last run worked and when. Counts and errors stay in D1 and the logs.
  const last = value ? JSON.parse(value) as { ok?: boolean; ranAt?: string } : {}
  return { ok: last.ok ?? null, ranAt: last.ranAt ?? null }
}
