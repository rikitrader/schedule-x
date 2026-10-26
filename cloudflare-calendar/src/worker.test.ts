import { afterEach, describe, expect, it, vi } from 'vitest'
import { signedWebhookRequest, verifyServiceRequest } from './worker'

const secret = 'calendar-sync-secret-that-is-at-least-32-bytes'
const encoder = new TextEncoder()

async function signedRequest(body: string, timestamp = String(Date.now())) {
  const path = '/api/internal/v1/workspaces/workspace-a/events/event-a'
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(body)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.PUT.${path}.${digest}`)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return new Request(`https://calendar.internal${path}`, { method: 'PUT', headers: { 'x-calendar-timestamp': timestamp, 'x-calendar-signature': signature }, body })
}

describe('calendar signed service API', () => {
	afterEach(() => vi.unstubAllGlobals())
  it('accepts the exact signed method, tenant path, timestamp, and body', async () => {
    const body = JSON.stringify({ title: 'Tenant event' })
    expect(await verifyServiceRequest(await signedRequest(body), { CALENDAR_SYNC_SECRET: secret }, body)).toBe(true)
  })

  it('rejects body tampering, stale requests, and missing secrets', async () => {
    const body = JSON.stringify({ title: 'Tenant event' })
    expect(await verifyServiceRequest(await signedRequest(body), { CALENDAR_SYNC_SECRET: secret }, `${body} `)).toBe(false)
    expect(await verifyServiceRequest(await signedRequest(body, String(Date.now() - 600_000)), { CALENDAR_SYNC_SECRET: secret }, body)).toBe(false)
    expect(await verifyServiceRequest(await signedRequest(body), {}, body)).toBe(false)
  })

  it('uses manual redirect handling for webhook delivery at the edge', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await signedWebhookRequest({ CRM_WEBHOOK_URL: 'https://crm.mipolitico.com/api/integrations/calendar/webhook', CALENDAR_SYNC_SECRET: secret } as never, { id: 'delivery-123', event_type: 'calendar.event.created', workspace_id: 'workspace-a', created_at: new Date().toISOString(), payload_json: JSON.stringify({ event: { id: 'event-a' } }) })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' })
  })

  it('prefers the private CRM service binding while preserving the signed webhook path', async () => {
    const serviceFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const publicFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', publicFetch)
    await signedWebhookRequest({ CRM_SERVICE: { fetch: serviceFetch }, CRM_WEBHOOK_URL: 'https://crm.mipolitico.com/api/integrations/calendar/webhook', CALENDAR_SYNC_SECRET: secret } as never, { id: 'delivery-456', event_type: 'calendar.event.created', workspace_id: 'workspace-a', created_at: new Date().toISOString(), payload_json: JSON.stringify({ event: { id: 'event-a' } }) })
    expect(serviceFetch).toHaveBeenCalledOnce()
    expect(publicFetch).not.toHaveBeenCalled()
    const request = serviceFetch.mock.calls[0][0] as Request
    expect(request.url).toBe('https://crm.internal/api/integrations/calendar/webhook')
    expect(request.method).toBe('POST')
    expect(request.redirect).toBe('manual')
    expect(request.headers.get('x-calendar-signature')).toMatch(/^[a-f0-9]{64}$/u)
  })
})
