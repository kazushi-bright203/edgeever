-- Metadata-only changes must invalidate previously fetched versions too.
-- Full content writes subsequently assign their already-computed next revision.
CREATE TRIGGER trg_memo_metadata_revision AFTER UPDATE OF title, tags_json, notebook_id, is_pinned, is_deleted ON memos WHEN OLD.title IS NOT NEW.title OR OLD.tags_json <> NEW.tags_json OR OLD.notebook_id <> NEW.notebook_id OR OLD.is_pinned <> NEW.is_pinned OR OLD.is_deleted <> NEW.is_deleted BEGIN UPDATE memo_contents SET revision = revision + 1, updated_at = NEW.updated_at WHERE memo_id = NEW.id; END;
