import { createId } from "./entity-utils";
import type { DatabaseAdapter, PreparedStatementAdapter } from "./storage-contract";

type MemoWriteBase = {
  id: string;
  revision: number;
  content_hash: string;
  notebook_id: string;
  title: string | null;
  tags_json: string;
  is_pinned: number;
  updated_at: string;
};

// Both D1 and the SQLite adapter execute batches transactionally. A zero-row
// conditional UPDATE would not roll back history/search/receipts; the named
// constraint instead aborts every statement when the previously read base moved.
export const batchMemoWrite = async (
  db: DatabaseAdapter,
  workspaceId: string,
  base: MemoWriteBase,
  targetNotebookId: string,
  statements: PreparedStatementAdapter[],
): Promise<boolean> => {
  const guardId = createId("memo_guard");
  try {
    await db.batch([
      db.prepare(`INSERT INTO memo_write_guards (id, valid)
        VALUES (?, EXISTS (
          SELECT 1 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
          WHERE m.id = ? AND m.workspace_id = ? AND m.is_deleted = 0
            AND c.revision = ? AND c.content_hash = ?
            AND m.notebook_id = ? AND m.title IS ? AND m.tags_json = ?
            AND m.is_pinned = ? AND m.updated_at = ?
            AND EXISTS (SELECT 1 FROM notebooks n
              WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0)
        ))`).bind(guardId, base.id, workspaceId, base.revision, base.content_hash,
          base.notebook_id, base.title, base.tags_json, base.is_pinned, base.updated_at,
          targetNotebookId, workspaceId),
      ...statements,
      db.prepare("DELETE FROM memo_write_guards WHERE id = ?").bind(guardId),
    ]);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("memo_write_conflict")) return false;
    throw error;
  }
};
