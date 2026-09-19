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
}

const timezone = 'America/New_York'
const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T
const calendarElement = $('#calendar')
const shell = $('#calendar-shell')
const authDialog = $('#auth-dialog') as HTMLDialogElement
const eventDialog = $('#event-dialog') as HTMLDialogElement
const authButton = $('#auth-button') as HTMLButtonElement
const newButton = $('#new-event') as HTMLButtonElement
const status = $('#auth-status')
const toast = $('#toast')
let authenticated = false
let events = new Map<string, ApiEvent>()

function toCalendarEvent(event: ApiEvent): CalendarEventExternal {
  return {
    id: event.id,
    title: event.title,
    start: event.isAllDay ? Temporal.PlainDate.from(event.start) : Temporal.ZonedDateTime.from(event.start),
    end: event.isAllDay ? Temporal.PlainDate.from(event.end) : Temporal.ZonedDateTime.from(event.end),
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
  locale: 'es-ES',
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
      if (!authenticated) {
        showToast('Inicia sesión para modificar eventos.', true)
        const existing = events.get(String(event.id))
        if (existing) eventsService.update(toCalendarEvent(existing))
        return
      }
      const existing = events.get(String(event.id))
      if (!existing) return
      const updated = { ...existing, start: event.start.toString(), end: event.end.toString(), isAllDay: event.start instanceof Temporal.PlainDate }
      try {
        const saved = await request<{ event: ApiEvent }>(`/api/events/${event.id}`, { method: 'PUT', body: JSON.stringify(updated) })
        events.set(saved.event.id, saved.event)
        eventsService.update(toCalendarEvent(saved.event))
        showToast('Evento actualizado.')
      } catch (caught) {
        eventsService.update(toCalendarEvent(existing))
        showToast(message(caught), true)
      }
    },
    onDoubleClickDateTime(dateTime) {
      if (authenticated) openNew(dateTime)
    },
    onDoubleClickDate(date) {
      if (authenticated) openNew(date.toZonedDateTime({ timeZone: timezone, plainTime: Temporal.PlainTime.from('09:00') }))
    },
  },
}, [eventsService])

calendar.render(calendarElement)

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string }
    throw new Error(body.error || `HTTP ${response.status}`)
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>
}

function message(caught: unknown) {
  return caught instanceof Error ? caught.message : 'Ocurrió un error inesperado.'
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
  status.textContent = value ? 'Modo administrador' : 'Solo lectura'
  newButton.hidden = !value
  authButton.textContent = value ? 'Cerrar sesión' : 'Administrar'
}

function dateTimeInput(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T09:00`
  return Temporal.ZonedDateTime.from(value).toPlainDateTime().toString({ smallestUnit: 'minute' })
}

function inputToZoned(value: string) {
  return Temporal.PlainDateTime.from(value).toZonedDateTime(timezone).toString()
}

function openNew(start = Temporal.Now.zonedDateTimeISO(timezone).round({ smallestUnit: 'minute', roundingIncrement: 15 })) {
  const end = start.add({ hours: 1 })
  $('#event-dialog-title').textContent = 'Nuevo evento'
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
  $('#event-dialog-title').textContent = authenticated ? 'Editar evento' : event.title
  ;($('#event-id') as HTMLInputElement).value = event.id
  ;($('#event-title') as HTMLInputElement).value = event.title
  ;($('#event-start') as HTMLInputElement).value = dateTimeInput(event.start)
  ;($('#event-end') as HTMLInputElement).value = dateTimeInput(event.end)
  ;($('#event-all-day') as HTMLInputElement).checked = event.isAllDay
  ;($('#event-calendar') as HTMLInputElement).value = event.calendarId
  ;($('#event-location') as HTMLInputElement).value = event.location
  ;($('#event-description') as HTMLTextAreaElement).value = event.description
  $('#event-error').textContent = ''
  ;($('#delete-event') as HTMLButtonElement).hidden = !authenticated
  for (const element of eventDialog.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
    ;(element as HTMLInputElement).disabled = !authenticated
  }
  ;($('#save-event') as HTMLButtonElement).hidden = !authenticated
  eventDialog.showModal()
}

for (const close of document.querySelectorAll<HTMLElement>('[data-close]')) close.addEventListener('click', () => (close.closest('dialog') as HTMLDialogElement).close())
newButton.addEventListener('click', () => openNew())
authButton.addEventListener('click', async () => {
  if (!authenticated) {
    $('#auth-error').textContent = ''
    authDialog.showModal()
    ;($('#password') as HTMLInputElement).focus()
    return
  }
  try {
    await request('/api/auth/logout', { method: 'POST', body: '{}' })
    setAuth(false)
    showToast('Sesión cerrada.')
  } catch (caught) { showToast(message(caught), true) }
})

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const password = ($('#password') as HTMLInputElement).value
  try {
    await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
    ;($('#password') as HTMLInputElement).value = ''
    setAuth(true)
    authDialog.close()
    showToast('Sesión iniciada.')
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
  }
  try {
    const saved = await request<{ event: ApiEvent }>(id ? `/api/events/${id}` : '/api/events', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
    events.set(saved.event.id, saved.event)
    if (id) eventsService.update(toCalendarEvent(saved.event)); else eventsService.add(toCalendarEvent(saved.event))
    eventDialog.close()
    showToast(id ? 'Evento actualizado.' : 'Evento creado.')
  } catch (caught) { $('#event-error').textContent = message(caught) }
})

$('#delete-event').addEventListener('click', async () => {
  const id = ($('#event-id') as HTMLInputElement).value
  if (!id || !window.confirm('¿Eliminar este evento permanentemente?')) return
  try {
    await request(`/api/events/${id}`, { method: 'DELETE' })
    events.delete(id)
    eventsService.remove(id)
    eventDialog.close()
    showToast('Evento eliminado.')
  } catch (caught) { $('#event-error').textContent = message(caught) }
})

async function initialize() {
  try {
    const [session, data] = await Promise.all([
      request<{ authenticated: boolean }>('/api/auth/session'),
      request<{ events: ApiEvent[] }>('/api/events'),
    ])
    setAuth(session.authenticated)
    events = new Map(data.events.map((event) => [event.id, event]))
    eventsService.set(data.events.map(toCalendarEvent))
  } catch (caught) {
    showToast(message(caught), true)
  } finally {
    shell.setAttribute('aria-busy', 'false')
  }
}

void initialize()
