/// <reference types="@cloudflare/workers-types" />

interface Env {
  CALENDAR_DB: D1Database
  ASSETS: Fetcher
  CALENDAR_ADMIN_PASSWORD: string
  SESSION_SECRET: string
}

type EventInput = {
  title: string
  start: string
  end: string
  isAllDay?: boolean
  calendarId?: string
  description?: string
  location?: string
}

const SESSION_COOKIE = '__Host-calendar_session'
const SESSION_TTL_SECONDS = 60 * 60 * 12
const encoder = new TextEncoder()

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })

const error = (message: string, status: number) => json({ error: message }, status)

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let result = 0
  for (let i = 0; i < left.length; i += 1) result |= left[i] ^ right[i]
  return result === 0
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get('cookie') || ''
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return null
}

async function isAdmin(request: Request, env: Env) {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token || env.SESSION_SECRET.length < 32) return false
  const [expires, signature] = token.split('.')
  if (!expires || !signature || !/^\d+$/u.test(expires) || Number(expires) <= Date.now()) return false
  const expected = await hmac(expires, env.SESSION_SECRET)
  return equalBytes(encoder.encode(signature), encoder.encode(expected))
}

function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  return origin === new URL(request.url).origin
}

async function readJson(request: Request) {
  const type = request.headers.get('content-type') || ''
  if (!type.toLowerCase().startsWith('application/json')) throw new Error('El contenido debe ser JSON.')
  return request.json()
}

function validateEvent(value: unknown): EventInput {
  if (!value || typeof value !== 'object') throw new Error('Evento inválido.')
  const body = value as Record<string, unknown>
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const start = typeof body.start === 'string' ? body.start : ''
  const end = typeof body.end === 'string' ? body.end : ''
  const calendarId = typeof body.calendarId === 'string' ? body.calendarId : 'public'
  const isAllDay = body.isAllDay === true
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const location = typeof body.location === 'string' ? body.location.trim() : ''
  if (!title || title.length > 200) throw new Error('El título debe tener entre 1 y 200 caracteres.')
  if (!start || !end || start >= end) throw new Error('El rango de fechas no es válido.')
  if (!['public', 'team', 'private'].includes(calendarId)) throw new Error('La categoría no es válida.')
  if (description.length > 4000 || location.length > 300) throw new Error('El contenido supera el límite permitido.')
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?\[[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+\]$/u
  if (isAllDay ? !(dateOnly.test(start) && dateOnly.test(end)) : !(zoned.test(start) && zoned.test(end))) {
    throw new Error('El formato de fecha no es válido.')
  }
  return { title, start, end, isAllDay, calendarId, description, location }
}

function eventFromRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    start: row.start_at,
    end: row.end_at,
    isAllDay: row.is_all_day === 1,
    calendarId: row.calendar_id,
    description: row.description,
    location: row.location,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function listEvents(request: Request, env: Env) {
  const url = new URL(request.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  let statement = 'SELECT * FROM calendar_events'
  const values: string[] = []
  const clauses: string[] = []
  if (!(await isAdmin(request, env))) clauses.push("calendar_id = 'public'")
  if (from && to) {
    clauses.push('end_at >= ? AND start_at <= ?')
    values.push(from, to)
  }
  if (clauses.length) statement += ` WHERE ${clauses.join(' AND ')}`
  statement += ' ORDER BY start_at ASC LIMIT 5000'
  const result = await env.CALENDAR_DB.prepare(statement).bind(...values).all()
  return json({ events: result.results.map((row) => eventFromRow(row as Record<string, unknown>)) })
}

async function createEvent(request: Request, env: Env) {
  const input = validateEvent(await readJson(request))
  const id = crypto.randomUUID()
  await env.CALENDAR_DB.prepare(
    `INSERT INTO calendar_events (id, title, start_at, end_at, is_all_day, calendar_id, description, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.title, input.start, input.end, input.isAllDay ? 1 : 0, input.calendarId, input.description, input.location).run()
  const row = await env.CALENDAR_DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(id).first()
  return json({ event: eventFromRow(row as Record<string, unknown>) }, 201)
}

async function updateEvent(request: Request, env: Env, id: string) {
  const input = validateEvent(await readJson(request))
  const result = await env.CALENDAR_DB.prepare(
    `UPDATE calendar_events SET title = ?, start_at = ?, end_at = ?, is_all_day = ?, calendar_id = ?,
     description = ?, location = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).bind(input.title, input.start, input.end, input.isAllDay ? 1 : 0, input.calendarId, input.description, input.location, id).run()
  if (!result.meta.changes) return error('Evento no encontrado.', 404)
  const row = await env.CALENDAR_DB.prepare('SELECT * FROM calendar_events WHERE id = ?').bind(id).first()
  return json({ event: eventFromRow(row as Record<string, unknown>) })
}

async function deleteEvent(env: Env, id: string) {
  const result = await env.CALENDAR_DB.prepare('DELETE FROM calendar_events WHERE id = ?').bind(id).run()
  if (!result.meta.changes) return error('Evento no encontrado.', 404)
  return new Response(null, { status: 204 })
}

async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url)
  if (url.pathname === '/api/health' && request.method === 'GET') {
    const db = await env.CALENDAR_DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    return json({ ok: db?.ok === 1, service: 'mipolitico-calendar' })
  }
  if (url.pathname === '/api/auth/session' && request.method === 'GET') return json({ authenticated: await isAdmin(request, env) })
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    if (!requireSameOrigin(request)) return error('Origen no autorizado.', 403)
    const body = await readJson(request) as { password?: unknown }
    const password = typeof body.password === 'string' ? body.password : ''
    if (!env.CALENDAR_ADMIN_PASSWORD || password.length > 512 || !equalBytes(await digest(password), await digest(env.CALENDAR_ADMIN_PASSWORD))) {
      return error('Credenciales inválidas.', 401)
    }
    const expires = String(Date.now() + SESSION_TTL_SECONDS * 1000)
    const token = `${expires}.${await hmac(expires, env.SESSION_SECRET)}`
    return json({ authenticated: true }, 200, {
      'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`,
    })
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    if (!requireSameOrigin(request)) return error('Origen no autorizado.', 403)
    return json({ authenticated: false }, 200, {
      'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    })
  }
  if (url.pathname === '/api/events' && request.method === 'GET') return listEvents(request, env)
  if (!requireSameOrigin(request)) return error('Origen no autorizado.', 403)
  if (!(await isAdmin(request, env))) return error('Autenticación requerida.', 401)
  if (url.pathname === '/api/events' && request.method === 'POST') return createEvent(request, env)
  const match = url.pathname.match(/^\/api\/events\/([0-9a-f-]{36})$/u)
  if (match && request.method === 'PUT') return updateEvent(request, env, match[1])
  if (match && request.method === 'DELETE') return deleteEvent(env, match[1])
  return error('Ruta no encontrada.', 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env)
      const response = await env.ASSETS.fetch(request)
      const headers = new Headers(response.headers)
      headers.set('x-content-type-options', 'nosniff')
      headers.set('referrer-policy', 'strict-origin-when-cross-origin')
      headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()')
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } catch (caught) {
      console.error('request_failed', caught instanceof Error ? caught.message : 'unknown')
      if (new URL(request.url).pathname.startsWith('/api/')) {
        const message = caught instanceof Error ? caught.message : 'Error inesperado.'
        return error(message, message.includes('JSON') || message.includes('válid') || message.includes('límite') ? 400 : 500)
      }
      return new Response('Internal Server Error', { status: 500 })
    }
  },
} satisfies ExportedHandler<Env>
