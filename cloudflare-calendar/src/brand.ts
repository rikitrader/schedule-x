// West Coast Precision Roofing brand kit (vendored from ~/projects/wcpr-brand into public/brand/, never hand-edited).
// Only the tenant with BRAND_KIT=wcpr references or serves it; MiPolitico and Mozaico keep their own look.
import { wcprKit, type Env } from './tenant'

export const WCPR_RED = '#c8102e'
export const wcprHead = `<link rel="stylesheet" href="/brand/tokens.css"><link rel="icon" href="/brand/app-icons/favicon.svg" type="image/svg+xml"><link rel="icon" href="/brand/app-icons/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/brand/app-icons/apple-touch-icon.png"><link rel="manifest" href="/manifest.webmanifest">`
/** Inner markup for an `a.wcpr-logo`; white on the dark calendar header, black on light pages. */
export const wcprLogo = (variant: 'white' | 'black') => `<img class="wcpr-logo-full" src="/brand/logo/wcpr-logo-${variant}.svg" alt="West Coast Precision Roofing"><img class="wcpr-logo-mark" src="/brand/logo/wcpr-mark-${variant}.svg" alt="">`
export const wcprIcon = (name: string, extra = '') => `<svg class="wcpr-icon${extra ? ` ${extra}` : ''}" aria-hidden="true"><use href="/brand/icons.svg#i-${name}"/></svg>`

const manifest = JSON.stringify({
  name: 'WCPR Calendar', short_name: 'Calendar', start_url: '/', scope: '/', display: 'standalone', background_color: '#f7f3ef', theme_color: WCPR_RED,
  icons: [
    { src: '/brand/app-icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/brand/app-icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/brand/app-icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
})

/** The kit and manifest are public static files, so they answer before the hub gate (favicons load signed out too). Other tenants get a 404. */
export async function brandAsset(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  const isKit = pathname.startsWith('/brand/'); const isManifest = pathname === '/manifest.webmanifest'
  if (!isKit && !isManifest) return null
  if (!wcprKit(env) || (request.method !== 'GET' && request.method !== 'HEAD')) return new Response('Not found', { status: 404, headers: { 'x-content-type-options': 'nosniff' } })
  if (isManifest) return new Response(manifest, { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' } })
  const asset = await env.ASSETS.fetch(request)
  // The SPA fallback would answer a missing kit file with index.html; a 404 is the honest reply.
  if ((asset.headers.get('content-type') || '').includes('text/html')) return new Response('Not found', { status: 404, headers: { 'x-content-type-options': 'nosniff' } })
  const headers = new Headers(asset.headers); headers.set('x-content-type-options', 'nosniff'); headers.set('cache-control', 'public, max-age=3600')
  return new Response(asset.body, { status: asset.status, headers })
}
