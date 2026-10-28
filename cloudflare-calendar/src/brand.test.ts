import { describe, expect, it, vi } from 'vitest'
import { brandAsset } from './brand'

const assets = (body = 'css', type = 'text/css') => ({ fetch: vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': type } })) })
const get = (path: string, method = 'GET') => new Request(`https://calendar.example${path}`, { method })

describe('WCPR brand kit serving', () => {
  it('serves the kit and manifest only on the WCPR tenant', async () => {
    const env = { BRAND_KIT: 'wcpr', ASSETS: assets() } as never
    expect((await brandAsset(get('/brand/tokens.css'), env))?.status).toBe(200)
    const manifest = await brandAsset(get('/manifest.webmanifest'), env)
    expect(manifest?.headers.get('content-type')).toBe('application/manifest+json')
    expect(JSON.stringify(await manifest?.json())).toContain('/brand/app-icons/icon-maskable-512.png')
  })

  it('404s the kit on MiPolitico and Mozaico so no WCPR asset leaks to another tenant', async () => {
    for (const env of [{ ASSETS: assets() }, { BRAND_KIT: '', BRAND_NAME: 'Mozaico', ASSETS: assets() }] as never[]) {
      expect((await brandAsset(get('/brand/logo/wcpr-logo-white.svg'), env))?.status).toBe(404)
      expect((await brandAsset(get('/manifest.webmanifest'), env))?.status).toBe(404)
    }
  })

  it('answers a missing kit file with 404 instead of the SPA page, and ignores other paths', async () => {
    const env = { BRAND_KIT: 'wcpr', ASSETS: assets('<!doctype html>', 'text/html') } as never
    expect((await brandAsset(get('/brand/missing.svg'), env))?.status).toBe(404)
    expect((await brandAsset(get('/brand/tokens.css', 'POST'), env))?.status).toBe(404)
    expect(await brandAsset(get('/'), env)).toBeNull()
  })
})
