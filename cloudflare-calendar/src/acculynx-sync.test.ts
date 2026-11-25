import { afterEach, describe, expect, it, vi } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { ACCULYNX_SYNC_CRON, departmentMap, fetchAppointments, planChanges, splitWindows, syncEnabled, toEvent as toEventWith, type Appointment } from './acculynx-sync'
import type { Env } from './tenant'

const tz = 'America/Los_Angeles'
const departments = { 'Field Calendar': 'operations', 'Field Two': 'operations' }
const toEvent = (a: Appointment, zone: string) => toEventWith(a, zone, departments)
const appt = (over: Partial<Appointment> = {}): Appointment => ({ id: '782f6f35-8d50-4f54-803e-5079603bf2cf', title: 'Anna Sheklow', start: '2026-11-20T16:00:00Z', end: '2026-11-20T17:00:00Z', allDay: 'False', location: '2910 Alabama Street, \nLa Crescenta-Montrose, CA, 91214', notes: 'Customer contact information', eventType: 'Appointment', calendar: 'Field Calendar', ...over })
const window = { from: Temporal.PlainDate.from('2026-11-01'), to: Temporal.PlainDate.from('2026-12-31') }

describe('toEvent', () => {
  it('writes the same zoned minute format the one-time import used, with the department and marker', () => {
    const e = toEvent(appt(), tz)
    expect(e.start).toBe('2026-11-20T08:00-08:00[America/Los_Angeles]')
    expect(e.end).toBe('2026-11-20T09:00-08:00[America/Los_Angeles]')
    expect(e.isAllDay).toBe(false)
    expect(e.departmentKey).toBe('operations')
    expect(e.location).toBe('2910 Alabama Street, La Crescenta-Montrose, CA, 91214')
    expect(e.description).toBe('Customer contact information\nCalendar: Field Calendar · Appointment\nAccuLynx #782f6f35-8d50-4f54-803e-5079603bf2cf')
  })

  it('reads AccuLynx\'s string allDay, and gives all-day events at least one day', () => {
    const e = toEvent(appt({ allDay: 'True', start: '2026-11-20T08:00:00Z', end: '2026-11-20T08:00:00Z' }), tz)
    expect([e.isAllDay, e.start, e.end]).toEqual([true, '2026-11-20', '2026-11-21'])
  })

  it('stretches zero-length appointments to 30 minutes and fills blank titles', () => {
    const e = toEvent(appt({ end: '2026-11-20T16:00:00Z', title: '  ' }), tz)
    expect(e.end).toBe('2026-11-20T08:30-08:00[America/Los_Angeles]')
    expect(e.title).toBe('AccuLynx appointment')
  })

  it('maps listed calendars to their department and unknown calendars to general, drops N/A notes, keeps the marker on long notes', () => {
    expect(toEvent(appt({ calendar: 'Field Two' }), tz).departmentKey).toBe('operations')
    expect(toEvent(appt({ calendar: 'Someone New' }), tz).departmentKey).toBe('general')
    expect(toEvent(appt({ notes: 'N/A' }), tz).description.startsWith('Calendar: Field Calendar')).toBe(true)
    const long = toEvent(appt({ notes: 'x'.repeat(9000) }), tz).description
    expect(long.length).toBeLessThanOrEqual(4000)
    expect(long.endsWith('AccuLynx #782f6f35-8d50-4f54-803e-5079603bf2cf')).toBe(true)
  })
})

describe('splitWindows', () => {
  it('covers the range in windows of at most 90 days with no gaps', () => {
    const w = splitWindows(Temporal.PlainDate.from('2026-01-01'), Temporal.PlainDate.from('2026-12-31'))
    expect(w.map((x) => `${x.from}..${x.to}`)).toEqual(['2026-01-01..2026-03-31', '2026-04-01..2026-06-29', '2026-06-30..2026-09-27', '2026-09-28..2026-12-26', '2026-12-27..2026-12-31'])
  })
})

describe('planChanges', () => {
  const row = (over: Record<string, unknown> = {}) => ({ appointment_id: 'a1', event_id: 'e1', start_date: '2026-11-20', fingerprint: 'old', revision: 3, ...over })

  it('creates new, updates changed, leaves unchanged, recreates calendar-deleted, deletes gone-from-AccuLynx', async () => {
    const a1 = appt({ id: 'a1' }); const a2 = appt({ id: 'a2' }); const a3 = appt({ id: 'a3' })
    const first = await planChanges(new Map([['a3', a3]]), [], [window], tz, departments)
    const unchangedFp = first.creates[0].fingerprint
    const plan = await planChanges(new Map([['a1', a1], ['a2', a2], ['a3', a3], ['a4', appt({ id: 'a4' })]]), [
      row(), // a1 changed → update
      row({ appointment_id: 'a3', event_id: 'e3', fingerprint: unchangedFp }), // unchanged → nothing
      row({ appointment_id: 'a4', event_id: 'e4', revision: null }), // event gone from calendar → recreate with same id
      row({ appointment_id: 'gone', event_id: 'e9' }), // gone from AccuLynx, inside the window → delete
      row({ appointment_id: 'old', event_id: 'e8', start_date: '2024-01-01' }), // outside fetched windows → untouched
    ], [window], tz, departments)
    expect(plan.creates.map((c) => [c.appointmentId, c.eventId])).toEqual([['a2', undefined], ['a4', 'e4']])
    expect(plan.updates.map((u) => [u.appointmentId, u.eventId, u.revision])).toEqual([['a1', 'e1', 3]])
    expect(plan.deletes.map((d) => d.appointment_id)).toEqual(['gone'])
  })

  it('treats a rescheduled appointment as an update, not a delete + create', async () => {
    const moved = appt({ id: 'a1', start: '2026-12-15T16:00:00Z', end: '2026-12-15T17:00:00Z' })
    const plan = await planChanges(new Map([['a1', moved]]), [row()], [window], tz, departments)
    expect(plan.updates).toHaveLength(1); expect(plan.deletes).toHaveLength(0); expect(plan.creates).toHaveLength(0)
  })
})

describe('fetchAppointments', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('pages every calendar (including past the first 10) and lets a person\'s calendar win over the company one', async () => {
    const calendars = Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, name: i === 0 ? 'West Coast Precision Roofing' : i === 10 ? 'Field Two' : `Person ${i}` }))
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url)
      if (u.pathname.endsWith('/calendars')) { const start = Number(u.searchParams.get('pageStartIndex')); return Response.json({ count: 11, items: calendars.slice(start, start + 50) }) }
      const cal = u.pathname.split('/')[4]
      const items = cal === 'c0' || cal === 'c10' ? [{ ...appt({ id: 'shared' }), calendar: undefined }] : []
      return Response.json({ count: items.length, items })
    })
    vi.stubGlobal('fetch', fetchMock)
    const seen = await fetchAppointments({ ACCULYNX_API_KEY: 'k' } as Env, [window])
    expect(seen.get('shared')?.calendar).toBe('Field Two')
    expect(fetchMock).toHaveBeenCalledTimes(12)
    expect(String(fetchMock.mock.calls[0][0])).toContain('pageSize=50')
  })

  it('throws on an AccuLynx error so a partial fetch never deletes anything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(fetchAppointments({ ACCULYNX_API_KEY: 'k' } as Env, [window])).rejects.toThrow('acculynx_http_503')
  })
})

describe('config', () => {
  it('only runs with the flag, the key and the department map, and matches the wrangler cron string', () => {
    const map = JSON.stringify(departments)
    expect(syncEnabled({ ACCULYNX_SYNC: 'true', ACCULYNX_CALENDAR_DEPARTMENTS: map } as Env)).toBe(false)
    expect(syncEnabled({ ACCULYNX_API_KEY: 'k', ACCULYNX_CALENDAR_DEPARTMENTS: map } as Env)).toBe(false)
    expect(syncEnabled({ ACCULYNX_SYNC: 'true', ACCULYNX_API_KEY: 'k' } as Env)).toBe(false)
    expect(syncEnabled({ ACCULYNX_SYNC: 'true', ACCULYNX_API_KEY: 'k', ACCULYNX_CALENDAR_DEPARTMENTS: map } as Env)).toBe(true)
    expect(departmentMap({ ACCULYNX_CALENDAR_DEPARTMENTS: 'not json' })).toEqual({})
    expect(ACCULYNX_SYNC_CRON).toBe('0 1,14,20 * * *')
  })
})
