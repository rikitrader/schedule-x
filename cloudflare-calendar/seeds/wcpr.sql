-- WCPR department calendars + agents (canonical roster 2026-10-26). Idempotent; never overwrites admin edits.
-- Apply: npx wrangler d1 execute wcpr-calendar --remote -c wrangler.wcpr.jsonc --file seeds/wcpr.sql
INSERT OR IGNORE INTO calendar_departments (key, name, agent_key, agent_name, owner_email) VALUES
  ('executive', 'Executive', 'wcpr-executive-agent', 'WCPR Executive Agent', 'rprieto@wcpr.pro'),
  ('general', 'Office', 'wcpr-office-agent', 'WCPR Office Agent', 'rprieto@wcpr.pro'),
  ('sales', 'Sales & Estimates', 'wcpr-sales-agent', 'WCPR Sales Agent', 'rprieto@wcpr.pro'),
  ('operations', 'Operations / Jobs', 'wcpr-operations-agent', 'WCPR Operations Agent', 'rprieto@wcpr.pro'),
  ('finance', 'Billing / Finance', 'wcpr-finance-agent', 'WCPR Finance Agent', 'rprieto@wcpr.pro');
