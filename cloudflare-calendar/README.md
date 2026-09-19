# MiPolitico Cloudflare Calendar

A standalone Schedule-X deployment for `calendar.mipolitico.com`. It is intentionally isolated from the CRM service.

## Architecture

- Cloudflare Worker: API, secure administrator session, security headers.
- Workers Static Assets: Vite/Schedule-X frontend.
- D1: calendar event persistence.
- Custom domain: `calendar.mipolitico.com`.

Public visitors can view the calendar. Event creation, editing, drag/resize updates, and deletion require the administrator password. Password and session keys are Cloudflare secrets and are never committed.

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
npm run deploy
```

Health check: `https://calendar.mipolitico.com/api/health`.

The included GitHub Actions workflow is manual until the repository has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. This prevents an unconfigured push from reporting a false deployment failure.

## Operations

- Rotate the administrator password with `npx wrangler secret put CALENDAR_ADMIN_PASSWORD`.
- Rotate `SESSION_SECRET` to invalidate all administrator sessions.
- Use `npx wrangler d1 export mipolitico-calendar --remote --output backup.sql` for an operator-initiated backup.
- Deployment logs and traces are enabled in `wrangler.jsonc`.

Schedule-X remains under its upstream MIT license. The deployment layer in this directory uses the same repository license.
