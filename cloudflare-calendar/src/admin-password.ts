/// <reference types="@cloudflare/workers-types" />
import type { Env } from './tenant'
import { base64Url, digest, equalBytes, error, json, readCookie, SESSION_COOKIE, sha256 } from './util'

// MiPolitico's shared administrator password, kept only until HUB_REQUIRED=true. Failed attempts are
// throttled in fixed 15-minute windows (per IP and globally) and sessions are server-side rows, so a
// logout or `DELETE FROM calendar_admin_sessions` ends them immediately.
const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_IP = 5
const MAX_GLOBAL = 50
export const ADMIN_SESSION_TTL_SECONDS = 60 * 60
const TOKEN = /^ps\.([A-Za-z0-9_-]{43})$/u

const windowStart = (now = Date.now()) => new Date(Math.floor(now / WINDOW_MS) * WINDOW_MS).toISOString()
const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') || 'unknown'
const cookie = (value: string, maxAge: number) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`

export async function adminPasswordSession(request: Request, env: Env) {
  const id = readCookie(request, SESSION_COOKIE)?.match(TOKEN)?.[1]; if (!id) return false
  const row = await env.CALENDAR_DB.prepare('SELECT 1 AS ok FROM calendar_admin_sessions WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ?').bind(await sha256(id), new Date().toISOString()).first<{ ok: number }>()
  return row?.ok === 1
}

export async function adminPasswordLogin(request: Request, env: Env, body: { password?: unknown }) {
  const since = windowStart(); const ip = `ip:${clientIp(request)}`
  const counts = await env.CALENDAR_DB.prepare("SELECT SUM(scope = ?) AS ip, COUNT(*) AS total FROM calendar_password_failures WHERE failed_at >= ?").bind(ip, since).first<{ ip: number | null; total: number }>()
  if (Number(counts?.ip ?? 0) >= MAX_PER_IP || Number(counts?.total ?? 0) >= MAX_GLOBAL) return error('Demasiados intentos. Espera 15 minutos.', 429)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!env.CALENDAR_ADMIN_PASSWORD || password.length > 512 || !equalBytes(await digest(password), await digest(env.CALENDAR_ADMIN_PASSWORD))) {
    await env.CALENDAR_DB.batch([env.CALENDAR_DB.prepare('INSERT INTO calendar_password_failures (scope, failed_at) VALUES (?, ?)').bind(ip, new Date().toISOString()), env.CALENDAR_DB.prepare('DELETE FROM calendar_password_failures WHERE failed_at < ?').bind(since)])
    return error('Credenciales inválidas.', 401)
  }
  const id = base64Url(crypto.getRandomValues(new Uint8Array(32))); const now = new Date()
  await env.CALENDAR_DB.batch([
    env.CALENDAR_DB.prepare('INSERT INTO calendar_admin_sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)').bind(await sha256(id), now.toISOString(), new Date(now.getTime() + ADMIN_SESSION_TTL_SECONDS * 1000).toISOString()),
    env.CALENDAR_DB.prepare('DELETE FROM calendar_admin_sessions WHERE expires_at < ?').bind(now.toISOString()),
    env.CALENDAR_DB.prepare('DELETE FROM calendar_password_failures WHERE scope = ?').bind(ip),
  ])
  return json({ authenticated: true }, 200, { 'set-cookie': cookie(`ps.${id}`, ADMIN_SESSION_TTL_SECONDS) })
}

export async function adminPasswordLogout(request: Request, env: Env) {
  const id = readCookie(request, SESSION_COOKIE)?.match(TOKEN)?.[1]
  if (id) await env.CALENDAR_DB.prepare('UPDATE calendar_admin_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').bind(new Date().toISOString(), await sha256(id)).run()
  return json({ authenticated: false }, 200, { 'set-cookie': cookie('', 0) })
}
