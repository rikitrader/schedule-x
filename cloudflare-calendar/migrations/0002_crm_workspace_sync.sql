CREATE TABLE calendar_events_v2 (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  is_all_day INTEGER NOT NULL DEFAULT 0 CHECK (is_all_day IN (0, 1)),
  calendar_id TEXT NOT NULL DEFAULT 'public' CHECK (calendar_id IN ('public', 'team', 'private')),
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'calendar' CHECK (source IN ('calendar', 'crm', 'provider')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, id)
);

INSERT INTO calendar_events_v2 (
  workspace_id, id, title, start_at, end_at, is_all_day, calendar_id,
  description, location, source, revision, created_at, updated_at
)
SELECT 'public', id, title, start_at, end_at, is_all_day, calendar_id,
       description, location, 'calendar', 1, created_at, updated_at
FROM calendar_events;

DROP TABLE calendar_events;
ALTER TABLE calendar_events_v2 RENAME TO calendar_events;

CREATE INDEX idx_calendar_events_workspace_range
  ON calendar_events(workspace_id, start_at, end_at);

CREATE TABLE calendar_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('local', 'crm')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO calendar_workspaces (id, name, source, created_at, updated_at)
VALUES ('public', 'Calendario público', 'local', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE calendar_webhook_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('calendar.event.created', 'calendar.event.updated', 'calendar.event.deleted')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_calendar_webhook_outbox_pending
  ON calendar_webhook_outbox(status, next_attempt_at, created_at);

CREATE TABLE calendar_service_requests (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_json TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX idx_calendar_service_requests_received
  ON calendar_service_requests(received_at);
