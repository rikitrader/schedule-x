-- AccuLynx → calendar live sync (WCPR tenant only; the other tenants never write these tables).
-- One row per AccuLynx appointment that has a calendar event. fingerprint = hash of the event as last written from AccuLynx,
-- so an unchanged appointment never rewrites an event a person edited in the calendar.
CREATE TABLE IF NOT EXISTS acculynx_appointments (
  appointment_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS acculynx_appointments_start ON acculynx_appointments (start_date);

CREATE TABLE IF NOT EXISTS acculynx_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Adopt the events the 2026-10-29 one-time import created (they carry an "AccuLynx #<id>" marker), so the sync updates them instead of duplicating.
INSERT OR IGNORE INTO acculynx_appointments (appointment_id, event_id, start_date, fingerprint, synced_at)
SELECT substr(description, instr(description, 'AccuLynx #') + 10, 36), id, substr(start_at, 1, 10), '', updated_at
FROM calendar_events
WHERE instr(description, 'AccuLynx #') > 0;
