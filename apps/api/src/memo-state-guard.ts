import { AppError } from "./app-error";
import { createId } from "./entity-utils";
import type { DatabaseAdapter, PreparedStatementAdapter } from "./storage-contract";

export const memoStateGuard = (db: DatabaseAdapter, workspaceId: string, memoId: string,
  revision: number, deletedState: 0 | 1, targetNotebookId?: string) => {
  const id = createId("memo_state");
  return {
    before: db.prepare(`INSERT INTO memo_write_guards (id, valid) VALUES (?, EXISTS (
      SELECT 1 FROM memos m JOIN memo_contents c ON c.memo_id = m.id
      WHERE m.id = ? AND m.workspace_id = ? AND m.is_deleted = ? AND c.revision = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM notebooks n WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0))))`)
      .bind(id, memoId, workspaceId, deletedState, revision, targetNotebookId ?? null, targetNotebookId ?? null, workspaceId),
    after: db.prepare("DELETE FROM memo_write_guards WHERE id = ?").bind(id),
  };
};

export const runMemoMutationBatch = async (db: DatabaseAdapter, statements: PreparedStatementAdapter[]) => {
  try { return await db.batch(statements); }
  catch (error) {
    if (error instanceof Error && error.message.includes("memo_write_conflict")) {
      throw new AppError("revision_conflict", "ほかの画面で更新されました。操作を停止しました。", 409);
    }
    throw error;
  }
};
