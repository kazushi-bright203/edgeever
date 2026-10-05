CREATE TABLE tag_registry (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND name = trim(name)),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (workspace_id, name)
);
INSERT INTO tag_registry (id, workspace_id, name, is_system)
  SELECT 'tag_' || lower(hex(randomblob(16))), workspace_id, name, name = '未整理'
  FROM memo_tags GROUP BY workspace_id, name;
INSERT OR IGNORE INTO tag_registry (id, workspace_id, name, is_system)
  SELECT 'tag_' || lower(hex(randomblob(16))), id, '未整理', 1 FROM workspaces;
CREATE TRIGGER trg_tag_registry_insert AFTER INSERT ON memo_tags BEGIN INSERT OR IGNORE INTO tag_registry (id, workspace_id, name, is_system) VALUES ('tag_' || lower(hex(randomblob(16))), NEW.workspace_id, NEW.name, NEW.name = '未整理'); END;
CREATE TRIGGER trg_tag_registry_system_delete BEFORE DELETE ON tag_registry WHEN OLD.is_system = 1 BEGIN SELECT RAISE(ABORT, 'protected_system_tag'); END;
CREATE TRIGGER trg_tag_registry_system_rename BEFORE UPDATE OF name, is_system ON tag_registry WHEN OLD.is_system = 1 AND (NEW.name <> OLD.name OR NEW.is_system <> 1) BEGIN SELECT RAISE(ABORT, 'protected_system_tag'); END;
