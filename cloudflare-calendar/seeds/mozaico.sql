-- Mozaico department calendars + agents (canonical roster 2026-10-26). Idempotent; never overwrites admin edits.
-- Apply: npx wrangler d1 execute mozaico-calendar --remote -c wrangler.mozaico.jsonc --file seeds/mozaico.sql
INSERT OR IGNORE INTO calendar_departments (key, name, agent_key, agent_name, owner_email) VALUES
  ('executive', 'Executive', 'mozaico-executive-agent', 'Mozaico Executive Agent', 'rprieto@mozaico.xyz'),
  ('general', 'General', 'mozaico-general-agent', 'Mozaico General Agent', 'rprieto@mozaico.xyz'),
  ('sales', 'Sales', 'mozaico-sales-agent', 'Mozaico Sales Agent', 'rprieto@mozaico.xyz'),
  ('operations', 'Operations', 'mozaico-operations-agent', 'Mozaico Operations Agent', 'rprieto@mozaico.xyz'),
  ('support', 'Support', 'mozaico-support-agent', 'Mozaico Support Agent', 'rprieto@mozaico.xyz'),
  ('finance', 'Finance', 'mozaico-finance-agent', 'Mozaico Finance Agent', 'rprieto@mozaico.xyz');
