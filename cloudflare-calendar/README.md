# MiPolitico Cloudflare Calendar

A Schedule-X deployment for `calendar.mipolitico.com` with workspace-isolated synchronization to the MiPolitico CRM.

## Architecture

- Cloudflare Worker: API, secure administrator session, security headers.
- Workers Static Assets: Vite/Schedule-X frontend.
- D1: calendar event persistence.
- Custom domain: `calendar.mipolitico.com`.
- CRM service API: private Cloudflare service binding authenticated with an HMAC service signature.
- CRM webhook: signed private Worker-to-Worker delivery with a durable D1 outbox and scheduled retry. The public URL remains a validated fallback for non-production environments.

Public visitors can view the calendar. Event creation, editing, drag/resize updates, and deletion require the administrator password. Password and session keys are Cloudflare secrets and are never committed.

CRM-connected events use `(workspace_id, event_id)` as their identity. Browser administrators select a workspace explicitly; events, request receipts, and webhook deliveries never fall back across workspaces.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run build
npm run preview
```

## Cloudflare provisioning

```bash
npx wrangler d1 create mipolitico-calendar
# Put the returned database_id in wrangler.jsonc.
npx wrangler d1 migrations apply CALENDAR_DB --remote
npx wrangler secret put CALENDAR_ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CALENDAR_SYNC_SECRET
npm run deploy
```

Health check: `https://calendar.mipolitico.com/api/health`.

The included GitHub Actions workflow is manual until the repository has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. This prevents an unconfigured push from reporting a false deployment failure.

## Operations

- Rotate the administrator password with `npx wrangler secret put CALENDAR_ADMIN_PASSWORD`.
- Rotate `SESSION_SECRET` to invalidate all administrator sessions.
- Rotate `CALENDAR_SYNC_SECRET` in both the calendar and CRM Workers in one maintenance window. A mismatch safely retains pending deliveries for retry.
- Use `npx wrangler d1 export mipolitico-calendar --remote --output backup.sql` for an operator-initiated backup.
- Inspect `calendar_webhook_outbox` for failed deliveries and `calendar_service_requests` for signed request receipts.
- Deployment logs and traces are enabled in `wrangler.jsonc`.

## CRM synchronization contract

The private service API is available only through the CRM Worker service binding:

- `GET /api/internal/v1/workspaces/:workspaceId/events`
- `PUT /api/internal/v1/workspaces/:workspaceId/events/:eventId`
- `DELETE /api/internal/v1/workspaces/:workspaceId/events/:eventId`

Requests include `x-calendar-timestamp`, `x-calendar-request-id`, and `x-calendar-signature`. The signature is HMAC-SHA256 over `timestamp.method.pathname.sha256(body)`, expires after five minutes, and mutation request IDs are idempotent.

Calendar-originated changes are delivered through the `CRM_SERVICE` Cloudflare service binding to `/api/integrations/calendar/webhook` with the same signature scheme. This avoids exposing an Access bypass on the public CRM hostname. `CRM_WEBHOOK_URL` is still validated and supplies the canonical signing path; public delivery is used only when the private binding is absent. Failed deliveries remain durable and are retried with bounded exponential backoff by the minute cron. The CRM performs a complete workspace reconciliation every 15 minutes and exposes an authenticated manual reconciliation endpoint at `POST /api/integrations/calendar/reconcile`.

Schedule-X remains under its upstream MIT license. The deployment layer in this directory uses the same repository license.
