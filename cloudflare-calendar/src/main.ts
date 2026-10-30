import 'temporal-polyfill/global'
import {
  createCalendar,
  createViewDay,
  createViewList,
  createViewMonthGrid,
  createViewWeek,
  type CalendarEventExternal,
} from '@schedule-x/calendar'
import { createEventsServicePlugin } from '@schedule-x/events-service'
import { translations } from '@schedule-x/translations'
import { toZoned } from './event-time'
import { t, type Locale, type MessageKey } from './i18n'
import '@schedule-x/theme-default/dist/index.css'
import './styles.css'

type ApiEvent = {
  id: string
  title: string
  start: string
  end: string
  isAllDay: boolean
  calendarId: string
  description: string
  location: string
  departmentKey?: string
}

type Role = 'viewer' | 'operator' | 'manager'
type Department = { key: string; name: string; role: Role }
type Session = { authenticated: boolean; user?: { email: string; name: string; admin: boolean }; departments?: Department[] }

// Tenant settings are stamped onto <body> by the worker; absent attributes mean the original MiPolitico setup.
const tenant = document.body.dataset
const locale: Locale = tenant.locale === 'en' ? 'en' : 'es'
const employeeMode = tenant.authMode === 'employee'
const timezone = tenant.timezone || 'America/New_York'
// With project-hub SSO the hub is the sign-in page; the local form is only a fallback at /?local=1.
const hubUrl = tenant.hubUrl || ''
const hubRequired = tenant.hubRequired === 'true'
let hubTarget = ''
const useHub = Boolean(hubUrl) && (hubRequired || new URLSearchParams(location.search).get('local') !== '1')
const text = (key: MessageKey) => t(locale, key)
const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, manager: 3 }
const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T
const calendarElement = $('#calendar')
const shell = $('#calendar-shell')
const authDialog = $('#auth-dialog') as HTMLDialogElement
const eventDialog = $('#event-dialog') as HTMLDialogElement
const authButton = $('#auth-button') as HTMLButtonElement
const newButton = $('#new-event') as HTMLButtonElement
const workspacePicker = document.querySelector('#workspace-picker') as unknown as HTMLSelectElement
const workspacePickerLabel = $('#workspace-picker-label')
const departmentPicker = document.querySelector('#department-picker') as unknown as HTMLSelectElement
const departmentPickerLabel = $('#department-picker-label')
const eventDepartment = document.querySelector('#event-department') as unknown as HTMLSelectElement
const adminLink = $('#admin-link')
const status = $('#auth-status')
const toast = $('#toast')
let authenticated = false
let events = new Map<string, ApiEvent>()
let activeWorkspace = 'public'
let session: Session = { authenticated: false }

function eventApi(path = '') {
  if (employeeMode) return `/api/events${path}${!path && departmentPicker.value ? `?department=${encodeURIComponent(departmentPicker.value)}` : ''}`
  const query = authenticated ? `?workspace=${encodeURIComponent(activeWorkspace)}` : ''
  return `/api/events${path}${query}`
}

const departments = () => session.departments ?? []
const writableDepartments = () => departments().filter((department) => ROLE_RANK[department.role] >= ROLE_RANK.operator)
// Password mode keeps the original single-administrator model: signed in means full access.
function canEdit(event?: ApiEvent) {
  if (!authenticated) return false
  if (!employeeMode) return true
  if (!event) return writableDepartments().length > 0
  const department = departments().find((candidate) => candidate.key === event.departmentKey)
  return Boolean(department && ROLE_RANK[department.role] >= ROLE_RANK.operator)
}

function toCalendarEvent(event: ApiEvent): CalendarEventExternal {
  return {
    id: event.id,
    title: event.title,
    start: event.isAllDay ? Temporal.PlainDate.from(event.start) : toZoned(event.start, timezone),
    end: event.isAllDay ? Temporal.PlainDate.from(event.end) : toZoned(event.end, timezone),
    calendarId: event.calendarId,
    description: event.description,
    location: event.location,
  }
}

const eventsService = createEventsServicePlugin()
const calendar = createCalendar({
  views: [createViewMonthGrid(), createViewWeek(), createViewDay(), createViewList()],
  defaultView: window.innerWidth < 700 ? 'day' : 'month-grid',
  selectedDate: Temporal.Now.plainDateISO(timezone),
  timezone,
  locale: locale === 'en' ? 'en-US' : 'es-ES',
  translations,
  firstDayOfWeek: 1,
  calendars: {
    public: { colorName: 'public', lightColors: { main: '#185adb', container: '#dce8ff', onContainer: '#08275c' }, darkColors: { main: '#8bb2ff', container: '#163462', onContainer: '#eef4ff' } },
    team: { colorName: 'team', lightColors: { main: '#0f9f6e', container: '#d5f6e9', onContainer: '#064e3b' }, darkColors: { main: '#72e0b8', container: '#145743', onContainer: '#edfff8' } },
    private: { colorName: 'private', lightColors: { main: '#bd8b00', container: '#fff1bd', onContainer: '#563e00' }, darkColors: { main: '#ffd66b', container: '#604b16', onContainer: '#fff9e8' } },
  },
  events: [],
  callbacks: {
    onEventClick(event) {
      const apiEvent = events.get(String(event.id))
      if (apiEvent) openEvent(apiEvent)
    },
    async onEventUpdate(event) {
      if (!canEdit(events.get(String(event.id)))) {
        showToast(text('signInToEdit'), true)
        const existing = events.get(String(event.id))
        if (existing) eventsService.update(toCalendarEvent(existing))
        return
      }
      const existing = events.get(String(event.id))
      if (!existing) return
      const updated = { ...existing, start: event.start.toString(), end: event.end.toString(), isAllDay: event.start instanceof Temporal.PlainDate }
      try {
        const saved = await request<{ event: ApiEvent }>(eventApi(`/${event.id}`), { method: 'PUT', body: JSON.stringify(updated) })
        events.set(saved.event.id, saved.event)
        eventsService.update(toCalendarEvent(saved.event))
        showToast(text('eventUpdated'))
      } catch (caught) {
        eventsService.update(toCalendarEvent(existing))
        showToast(message(caught), true)
      }
    },
    onDoubleClickDateTime(dateTime) {
      if (canEdit()) openNew(dateTime)
    },
    onDoubleClickDate(date) {
      if (canEdit()) openNew(date.toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from('09:00') }))
    },
  },
}, [eventsService])

calendar.render(calendarElement)

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
  if (!response.ok) {
    // The hub gate answers 401 once the hub session is gone; reloading lets it send the browser to the hub.
    if (response.status === 401 && hubRequired) location.reload()
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string; hub?: string }
    if (body.hub && /^https:\/\//u.test(body.hub)) hubTarget = body.hub
    throw new Error(body.error || `HTTP ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>
}

function message(caught: unknown) {
  return caught instanceof Error ? caught.message : text('unexpected')
}

let toastTimer = 0
function showToast(text: string, isError = false) {
  window.clearTimeout(toastTimer)
  toast.textContent = text
  toast.classList.toggle('error', isError)
  toast.classList.add('visible')
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3500)
}

function setAuth(value: boolean) {
  authenticated = value
  status.textContent = value ? (employeeMode && session.user ? session.user.email : text('adminMode')) : text('readOnly')
  newButton.hidden = !canEdit()
  authButton.textContent = value ? text('signOut') : text('manage')
  if (employeeMode) {
    departmentPickerLabel.hidden = !value
    adminLink.hidden = !(value && (session.user?.admin || departments().some((department) => department.role === 'manager')))
  } else workspacePickerLabel.hidden = !value
}

function fillDepartments(select: HTMLSelectElement, list: Department[], allOption: boolean) {
  const options = list.map((department) => {
    const option = document.createElement('option')
    option.value = department.key
    option.textContent = department.name
    return option
  })
  if (allOption) {
    const all = document.createElement('option')
    all.value = ''
    all.textContent = text('allDepartments')
    options.unshift(all)
  }
  select.replaceChildren(...options)
}

function loadDepartments() {
  const desired = new URLSearchParams(location.search).get('department') || departmentPicker.value
  fillDepartments(departmentPicker, departments(), true)
  departmentPicker.value = departments().some((department) => department.key === desired) ? desired : ''
}

async function loadWorkspaces() {
  if (employeeMode) return loadDepartments()
  if (!authenticated) {
    activeWorkspace = 'public'
    workspacePicker.replaceChildren()
    return
  }
  const data = await request<{ workspaces: Array<{ id: string; name: string }> }>('/api/workspaces')
  const desired = new URLSearchParams(location.search).get('workspace') || activeWorkspace
  workspacePicker.replaceChildren(...data.workspaces.map((workspace) => {
    const option = document.createElement('option')
    option.value = workspace.id
    option.textContent = workspace.name
    return option
  }))
  activeWorkspace = data.workspaces.some((workspace) => workspace.id === desired) ? desired : data.workspaces[0]?.id || 'public'
  workspacePicker.value = activeWorkspace
}

async function loadEvents() {
  if (employeeMode && !authenticated) {
    events = new Map()
    eventsService.set([])
    return
  }
  const data = await request<{ events: ApiEvent[] }>(eventApi())
  events = new Map(data.events.map((event) => [event.id, event]))
  // One unreadable row must not take the whole calendar down.
  eventsService.set(data.events.flatMap((event) => {
    try { return [toCalendarEvent(event)] } catch (caught) { console.error('event_skipped', event.id, message(caught)); return [] }
  }))
}

function dateTimeInput(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T09:00`
  return toZoned(value, timezone).toPlainDateTime().toString({ smallestUnit: 'minute' })
}

function inputToZoned(value: string) {
  return Temporal.PlainDateTime.from(value).toZonedDateTime(timezone).toString()
}

function openNew(start = Temporal.Now.zonedDateTimeISO(timezone).round({ smallestUnit: 'minute', roundingIncrement: 15 })) {
  const end = start.add({ hours: 1 })
  $('#event-dialog-title').textContent = text('newEventTitle')
  if (employeeMode) {
    fillDepartments(eventDepartment, writableDepartments(), false)
    eventDepartment.value = writableDepartments().some((department) => department.key === departmentPicker.value) ? departmentPicker.value : writableDepartments()[0]?.key || ''
  }
  ;($('#event-id') as HTMLInputElement).value = ''
  ;($('#event-title') as HTMLInputElement).value = ''
  ;($('#event-start') as HTMLInputElement).value = start.toPlainDateTime().toString({ smallestUnit: 'minute' })
  ;($('#event-end') as HTMLInputElement).value = end.toPlainDateTime().toString({ smallestUnit: 'minute' })
  ;($('#event-all-day') as HTMLInputElement).checked = false
  ;($('#event-calendar') as HTMLInputElement).value = 'public'
  ;($('#event-location') as HTMLInputElement).value = ''
  ;($('#event-description') as HTMLTextAreaElement).value = ''
  for (const element of eventDialog.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
    ;(element as HTMLInputElement).disabled = false
  }
  ;($('#save-event') as HTMLButtonElement).hidden = false
  $('#event-error').textContent = ''
  ;($('#delete-event') as HTMLButtonElement).hidden = true
  eventDialog.showModal()
  ;($('#event-title') as HTMLInputElement).focus()
}

function openEvent(event: ApiEvent) {
  const editable = canEdit(event)
  $('#event-dialog-title').textContent = editable ? text('editEvent') : event.title
  if (employeeMode) {
    const current = departments().find((department) => department.key === event.departmentKey)
    const choices = editable ? writableDepartments() : current ? [current] : []
    fillDepartments(eventDepartment, choices, false)
    eventDepartment.value = event.departmentKey || ''
  }
  ;($('#event-id') as HTMLInputElement).value = event.id
  ;($('#event-title') as HTMLInputElement).value = event.title
  ;($('#event-start') as HTMLInputElement).value = dateTimeInput(event.start)
  ;($('#event-end') as HTMLInputElement).value = dateTimeInput(event.end)
  ;($('#event-all-day') as HTMLInputElement).checked = event.isAllDay
  ;($('#event-calendar') as HTMLInputElement).value = event.calendarId
  ;($('#event-location') as HTMLInputElement).value = event.location
  ;($('#event-description') as HTMLTextAreaElement).value = event.description
  $('#event-error').textContent = ''
  ;($('#delete-event') as HTMLButtonElement).hidden = !editable
  for (const element of eventDialog.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
    ;(element as HTMLInputElement).disabled = !editable
  }
  ;($('#save-event') as HTMLButtonElement).hidden = !editable
  eventDialog.showModal()
}

for (const close of document.querySelectorAll<HTMLElement>('[data-close]')) close.addEventListener('click', () => (close.closest('dialog') as HTMLDialogElement).close())
newButton.addEventListener('click', () => openNew())
authButton.addEventListener('click', async () => {
  if (!authenticated) {
    if (useHub) { location.assign('/api/auth/hub'); return }
    openSignIn()
    return
  }
  // Employee calendars have no session of their own: signing out happens in the hub.
  if (employeeMode) { location.assign(hubUrl); return }
  try {
    await request('/api/auth/logout', { method: 'POST', body: '{}' })
    session = { authenticated: false }
    if (hubUrl && (await request<Session>('/api/auth/session')).authenticated) { location.assign(hubUrl); return }
    setAuth(false)
    await loadWorkspaces()
    await loadEvents()
    showToast(text('sessionClosed'))
  } catch (caught) { showToast(message(caught), true) }
})

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const password = ($('#password') as HTMLInputElement).value
  try {
    await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
    ;($('#password') as HTMLInputElement).value = ''
    setAuth(true)
    await loadWorkspaces()
    await loadEvents()
    authDialog.close()
    showToast(text('sessionStarted'))
  } catch (caught) { $('#auth-error').textContent = message(caught) }
})

$('#event-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const id = ($('#event-id') as HTMLInputElement).value
  const allDay = ($('#event-all-day') as HTMLInputElement).checked
  const startInput = ($('#event-start') as HTMLInputElement).value
  const endInput = ($('#event-end') as HTMLInputElement).value
  const startDate = Temporal.PlainDate.from(startInput.slice(0, 10))
  const candidateEndDate = Temporal.PlainDate.from(endInput.slice(0, 10))
  const endDate = Temporal.PlainDate.compare(candidateEndDate, startDate) > 0 ? candidateEndDate : startDate.add({ days: 1 })
  const payload = {
    title: ($('#event-title') as HTMLInputElement).value,
    start: allDay ? startDate.toString() : inputToZoned(startInput),
    end: allDay ? endDate.toString() : inputToZoned(endInput),
    isAllDay: allDay,
    calendarId: ($('#event-calendar') as HTMLInputElement).value,
    location: ($('#event-location') as HTMLInputElement).value,
    description: ($('#event-description') as HTMLTextAreaElement).value,
    ...(employeeMode ? { departmentKey: eventDepartment.value } : {}),
  }
  try {
    const saved = await request<{ event: ApiEvent }>(id ? eventApi(`/${id}`) : eventApi(), { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
    events.set(saved.event.id, saved.event)
    if (id) eventsService.update(toCalendarEvent(saved.event)); else eventsService.add(toCalendarEvent(saved.event))
    eventDialog.close()
    showToast(id ? text('eventUpdated') : text('eventCreated'))
  } catch (caught) { $('#event-error').textContent = message(caught) }
})

$('#delete-event').addEventListener('click', async () => {
  const id = ($('#event-id') as HTMLInputElement).value
  if (!id || !window.confirm(text('confirmDelete'))) return
  try {
    await request(eventApi(`/${id}`), { method: 'DELETE' })
    events.delete(id)
    eventsService.remove(id)
    eventDialog.close()
    showToast(text('eventDeleted'))
  } catch (caught) { $('#event-error').textContent = message(caught) }
})

async function initialize() {
  try {
    session = await request<Session>('/api/auth/session')
    setAuth(session.authenticated)
    await loadWorkspaces()
    await loadEvents()
    if (employeeMode && !session.authenticated) location.assign('/api/auth/hub')
  } catch (caught) {
    // In hub mode a signed-out or not-allowed state must never sit on a read-only calendar: hand over to the hub.
    // Any other failure stays here with an error, or the launcher's tile looks dead.
    if (hubRequired && (hubTarget || !session.authenticated)) { location.assign(hubTarget || hubUrl); return }
    showToast(message(caught), true)
  } finally {
    shell.setAttribute('aria-busy', 'false')
  }
}

function openSignIn() {
  $('#auth-error').textContent = ''
  authDialog.showModal()
  ;($('#password') as HTMLInputElement).focus()
}

if (employeeMode) {
  $('#event-department-label').hidden = false
  departmentPicker.addEventListener('change', async () => {
    const url = new URL(location.href)
    if (departmentPicker.value) url.searchParams.set('department', departmentPicker.value); else url.searchParams.delete('department')
    history.replaceState(null, '', url)
    shell.setAttribute('aria-busy', 'true')
    try { await loadEvents() } catch (caught) { showToast(message(caught), true) } finally { shell.setAttribute('aria-busy', 'false') }
  })
}

workspacePicker.addEventListener('change', async () => {
  activeWorkspace = workspacePicker.value
  const url = new URL(location.href)
  url.searchParams.set('workspace', activeWorkspace)
  history.replaceState(null, '', url)
  shell.setAttribute('aria-busy', 'true')
  try { await loadEvents() } catch (caught) { showToast(message(caught), true) } finally { shell.setAttribute('aria-busy', 'false') }
})

void initialize()
