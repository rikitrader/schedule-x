-- Department calendars (employee auth mode). Additive only: password-mode deployments never read these tables,
-- and existing events default to the 'general' department.
ALTER TABLE calendar_events ADD COLUMN department_key TEXT NOT NULL DEFAULT 'general';

CREATE INDEX idx_calendar_events_workspace_department_range
  ON calendar_events(workspace_id, department_key, start_at, end_at);

CREATE TABLE calendar_departments (
  key TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*' AND length(key) BETWEEN 1 AND 32),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  agent_key TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- subject is a lowercased employee email, or '*' for every signed-in employee (department-wide grant).
CREATE TABLE calendar_grants (
  id TEXT PRIMARY KEY,
  department_key TEXT NOT NULL REFERENCES calendar_departments(key) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject = '*' OR (instr(subject, '@') > 1 AND length(subject) <= 254)),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'manager')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (department_key, subject)
);

CREATE INDEX idx_calendar_grants_subject ON calendar_grants(subject);

-- Server-to-server tokens for department agents. Only the SHA-256 of the token is stored.
CREATE TABLE calendar_agent_tokens (
  id TEXT PRIMARY KEY,
  department_key TEXT NOT NULL REFERENCES calendar_departments(key) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('viewer', 'operator')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE calendar_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  department_key TEXT,
  target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_calendar_audit_log_created ON calendar_audit_log(created_at);

CREATE TABLE calendar_login_attempts (
  email TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE INDEX idx_calendar_login_attempts_email ON calendar_login_attempts(email, attempted_at);
