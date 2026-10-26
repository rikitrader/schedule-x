-- MiPolitico shared admin password (until HUB_REQUIRED=true): fixed-window login throttling and
-- server-side, revocable admin sessions. Additive; employee tenants never use these tables.
CREATE TABLE calendar_password_failures (
  scope TEXT NOT NULL,
  failed_at TEXT NOT NULL
);

CREATE INDEX idx_calendar_password_failures_scope ON calendar_password_failures(scope, failed_at);

-- Only the SHA-256 of the session id is stored. Delete rows (or set revoked_at) to end sessions.
CREATE TABLE calendar_admin_sessions (
  id_hash TEXT PRIMARY KEY CHECK (length(id_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
