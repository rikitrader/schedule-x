/// <reference types="@cloudflare/workers-types" />

export const encoder = new TextEncoder()
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
export const error = (message: string, status: number) => json({ error: message }, status)

export function base64Url(bytes: Uint8Array) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') }
export function fromBase64Url(value: string) { const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4); return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)) }
export function hex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
export async function hmacBytes(value: string, secret: string) { const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))) }
export async function hmac(value: string, secret: string) { return base64Url(await hmacBytes(value, secret)) }
export async function sha256(value: string) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))) }
export async function digest(value: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))) }
export function equalBytes(left: Uint8Array, right: Uint8Array) { if (left.length !== right.length) return false; let result = 0; for (let i = 0; i < left.length; i += 1) result |= left[i] ^ right[i]; return result === 0 }
export function equalStrings(left: string, right: string) { return equalBytes(encoder.encode(left), encoder.encode(right)) }
export function readCookie(request: Request, name: string) { const cookie = request.headers.get('cookie') || ''; for (const part of cookie.split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return value.join('=') } return null }
export function requireSameOrigin(request: Request) { return request.headers.get('origin') === new URL(request.url).origin }
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
export class ClientError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status } }
export const SESSION_COOKIE = '__Host-calendar_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 12
