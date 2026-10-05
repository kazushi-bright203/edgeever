CREATE TABLE personal_ai_previews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('classify', 'format')),
  period TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'ready', 'applied', 'canceled', 'failed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_personal_ai_running ON personal_ai_previews(workspace_id) WHERE state = 'running';
CREATE INDEX idx_personal_ai_budget ON personal_ai_previews(workspace_id, period);
