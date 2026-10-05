import { normalizeTags, type TagSummary } from "@edgeever/shared";
import type { AuditActor } from "./api-context";
import { AppError } from "./app-error";
import { auditStatement } from "./audit";
import { memoStateGuard, runMemoMutationBatch } from "./memo-state-guard";
import { createId, isoNow, parseJsonArray } from "./entity-utils";
import { upsertMemoSearchDocumentStatement } from "./memo-search-index";
import type { DatabaseAdapter, PreparedStatementAdapter } from "./storage-contract";

type TagSummaryRow = {
  name: string;
  memo_count: number;
  updated_at: string | null;
};

type MemoTagUpdateRow = {
  revision: number;
  notebook_id: string;
  id: string;
  title: string | null;
  tags_json: string;
  content_text: string;
};

const mapTagSummary = (row: TagSummaryRow): TagSummary => ({
  name: row.name,
  memoCount: row.memo_count,
  updatedAt: row.updated_at,
});

const getMemoRowsByTag = async (db: DatabaseAdapter, workspaceId: string, tag: string) => {
  const rows = await db
    .prepare(
      `SELECT m.id, m.title, m.tags_json, m.notebook_id, c.content_text, c.revision
       FROM memos m
       INNER JOIN memo_contents c ON c.memo_id = m.id
       WHERE m.workspace_id = ? AND m.is_deleted = 0
         AND EXISTS (
           SELECT 1
           FROM memo_tags mt
           WHERE mt.memo_id = m.id AND mt.workspace_id = ? AND mt.name = ?
         )`
    )
    .bind(workspaceId, workspaceId, tag)
    .all<MemoTagUpdateRow>();

  return rows.results;
};

const replaceTag = (currentTags: string[], oldTag: string, nextTag: string | null) =>
  normalizeTags(
    currentTags.flatMap((tag) => {
      if (tag !== oldTag) return [tag];
      return nextTag ? [nextTag] : [];
    })
  );

export const listTagSummaries = async (db: DatabaseAdapter, workspaceId: string): Promise<TagSummary[]> => {
  await db.prepare(`INSERT OR IGNORE INTO tag_registry (id, workspace_id, name, is_system) VALUES (?, ?, '未整理', 1)`)
    .bind(createId("tag"), workspaceId).run();
  const registry = await db.prepare(`SELECT t.id, t.name, t.is_system, COUNT(DISTINCT m.id) AS memo_count,
    MAX(m.updated_at) AS updated_at FROM tag_registry t
    LEFT JOIN memo_tags mt ON mt.workspace_id = t.workspace_id AND mt.name = t.name
    LEFT JOIN memos m ON m.id = mt.memo_id AND m.is_deleted = 0
    WHERE t.workspace_id = ? GROUP BY t.id ORDER BY t.is_system DESC, t.name ASC`).bind(workspaceId)
    .all<{ id: string; name: string; is_system: number; memo_count: number; updated_at: string | null }>();
  return registry.results.map((row) => ({ ...mapTagSummary(row), id: row.id, isSystem: Boolean(row.is_system) }));
};

export const createTag = async (db: DatabaseAdapter, workspaceId: string, name: string) => {
  const normalized = name.trim();
  if (!normalized || normalized.length > 80) throw new AppError("invalid_tag", "タグ名は1〜80文字で入力してください。", 400);
  try {
    await db.prepare("INSERT INTO tag_registry (id, workspace_id, name) VALUES (?, ?, ?)").bind(createId("tag"), workspaceId, normalized).run();
  } catch (error) {
    if (await db.prepare("SELECT id FROM tag_registry WHERE workspace_id = ? AND name = ?").bind(workspaceId, normalized).first()) {
      throw new AppError("duplicate_tag", "同じ名前のタグが存在します。", 409);
    }
    throw error;
  }
  return { ok: true };
};

export const updateTagAcrossMemos = async (
  db: DatabaseAdapter,
  workspaceId: string,
  oldTag: string,
  nextTag: string | null,
  actor: AuditActor,
  actorLabel: string
) => {
  const normalizedOld = normalizeTags([oldTag])[0];
  const normalizedNext = nextTag === null ? null : normalizeTags([nextTag])[0];

  if (!normalizedOld || normalizedOld === normalizedNext) return 0;

  if (normalizedOld === "未整理") throw new AppError("protected_tag", "未整理タグは名前変更・削除できません。", 409);
  if (nextTag !== null && !normalizedNext) throw new AppError("invalid_tag", "タグ名は空にできません。", 400);
  if (normalizedNext && await db.prepare("SELECT id FROM tag_registry WHERE workspace_id = ? AND name = ?")
    .bind(workspaceId, normalizedNext).first()) throw new AppError("duplicate_tag", "同じ名前のタグが存在します。", 409);

  const affected = await db.prepare(`SELECT m.id, m.tags_json, c.revision FROM memos m
    INNER JOIN memo_contents c ON c.memo_id = m.id WHERE m.workspace_id = ?
    AND EXISTS (SELECT 1 FROM memo_tags mt WHERE mt.memo_id = m.id AND mt.name = ?)`)
    .bind(workspaceId, normalizedOld).all<{ id: string; tags_json: string; revision: number }>();
  const guarded: PreparedStatementAdapter[] = [];
  const guardIds: string[] = [];
  for (const row of affected.results) {
    const guardId = createId("tag_guard"); guardIds.push(guardId);
    guarded.push(db.prepare(`INSERT INTO memo_write_guards (id, valid) VALUES (?, EXISTS (
      SELECT 1 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
      WHERE m.id = ? AND m.workspace_id = ? AND m.tags_json = ? AND c.revision = ?))`)
      .bind(guardId, row.id, workspaceId, row.tags_json, row.revision));
  }
  const membershipGuard = createId("tag_membership"); guardIds.push(membershipGuard);
  guarded.push(db.prepare(`INSERT INTO memo_write_guards (id, valid) VALUES (?,
    (SELECT COUNT(*) FROM memo_tags WHERE workspace_id = ? AND name = ?) = ?)`)
    .bind(membershipGuard, workspaceId, normalizedOld, affected.results.length));
  guarded.push(normalizedNext ? db.prepare("UPDATE tag_registry SET name = ? WHERE workspace_id = ? AND name = ?")
    .bind(normalizedNext, workspaceId, normalizedOld) : db.prepare("DELETE FROM tag_registry WHERE workspace_id = ? AND name = ?")
    .bind(workspaceId, normalizedOld));
  for (const row of affected.results) {
    const nextTags = replaceTag(parseJsonArray(row.tags_json), normalizedOld, normalizedNext);
    guarded.push(db.prepare(`INSERT INTO memo_revisions (id, memo_id, revision, title, tags_json, content_json,
      content_markdown, content_text, content_hash, created_by, created_at)
      SELECT ?, m.id, c.revision, m.title, m.tags_json, c.content_json, c.content_markdown, c.content_text,
      c.content_hash, ?, ? FROM memos m JOIN memo_contents c ON c.memo_id = m.id WHERE m.id = ?`)
      .bind(createId("rev"), actorLabel, isoNow(), row.id),
      db.prepare("UPDATE memos SET tags_json = ?, updated_by = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
        .bind(JSON.stringify(nextTags), actorLabel, isoNow(), row.id, workspaceId),
      db.prepare("UPDATE memo_search_documents SET tags = ? WHERE memo_id = ?").bind(nextTags.join(" "), row.id),
      auditStatement(db, actor.actorType, actor.actorId, normalizedNext ? "tag.rename" : "tag.delete", "memo", row.id, { from: normalizedOld, to: normalizedNext }));
  }
  guarded.push(...guardIds.map((id) => db.prepare("DELETE FROM memo_write_guards WHERE id = ?").bind(id)));
  try { await db.batch(guarded); }
  catch (error) {
    if (error instanceof Error && error.message.includes("memo_write_conflict")) throw new AppError("revision_conflict", "タグの変更中にメモが更新されました。再読み込みしてください。", 409);
    throw error;
  }
  return affected.results.length;

};

export const previewTagRename = async (
  db: DatabaseAdapter,
  workspaceId: string,
  oldTag: string,
  nextTag: string | null
) => {
  const normalizedOld = normalizeTags([oldTag])[0];
  const normalizedNext = nextTag === null ? null : normalizeTags([nextTag])[0];

  if (!normalizedOld || normalizedOld === normalizedNext) {
    return { dryRun: true, updated: 0, changes: [] };
  }

  const rows = await getMemoRowsByTag(db, workspaceId, normalizedOld);
  const changes = rows.map((row) => {
    const currentTags = parseJsonArray(row.tags_json);
    return {
      memoId: row.id,
      title: row.title,
      currentTags,
      nextTags: replaceTag(currentTags, normalizedOld, normalizedNext),
    };
  });

  return { dryRun: true, updated: changes.length, changes };
};

export const updateTagsForMemos = async (
  db: DatabaseAdapter,
  input: {
    workspaceId: string;
    memoIds: string[];
    tags: string[];
    mode: "add" | "remove";
    dryRun: boolean;
    actor: AuditActor;
    actorLabel: string;
  }
) => {
  const memoIds = Array.from(new Set(input.memoIds));
  const tags = normalizeTags(input.tags);
  if (input.mode === "remove" && tags.includes("未整理")) throw new AppError("protected_tag", "未整理はメモの整理完了で外してください。", 409);

  if (memoIds.length === 0 || tags.length === 0) {
    throw new AppError("invalid_params", "memoIds and tags must include at least one item", 400);
  }

  const placeholders = memoIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT m.id, m.title, m.tags_json, m.notebook_id, c.content_text, c.revision
       FROM memos m
       INNER JOIN memo_contents c ON c.memo_id = m.id
       WHERE m.workspace_id = ? AND m.is_deleted = 0 AND m.id IN (${placeholders})`
    )
    .bind(input.workspaceId, ...memoIds)
    .all<MemoTagUpdateRow>();

  if (rows.results.length !== memoIds.length) {
    throw new AppError("missing_memos", "One or more memos cannot be updated.", 400);
  }

  const changes = rows.results
    .map((row) => {
      const currentTags = parseJsonArray(row.tags_json);
      const nextTags = input.mode === "add"
        ? normalizeTags([...currentTags, ...tags])
        : currentTags.filter((tag) => !tags.includes(tag));
      return { notebookId: row.notebook_id, memoId: row.id, title: row.title, currentTags, nextTags, contentText: row.content_text, revision: row.revision };
    })
    .filter((change) => JSON.stringify(change.currentTags) !== JSON.stringify(change.nextTags));

  if (input.dryRun) {
    return {
      dryRun: true,
      updated: changes.length,
      changes: changes.map(({ contentText: _contentText, ...change }) => change),
    };
  }

  if (changes.length === 0) return { ok: true, updated: 0 };

  const now = isoNow();
  const statements: PreparedStatementAdapter[] = [];
  for (const change of changes) {
    const guard = memoStateGuard(db, input.workspaceId, change.memoId, change.revision, 0);
    statements.push(
      guard.before,
      db
        .prepare(
          `UPDATE memos
           SET tags_json = ?, updated_by = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND is_deleted = 0`
        )
        .bind(JSON.stringify(change.nextTags), input.actorLabel, now, change.memoId, input.workspaceId),
      upsertMemoSearchDocumentStatement(
        db,
        change.memoId,
        change.title,
        change.contentText,
        change.nextTags.join(" "),
      ),
      auditStatement(
        db,
        input.actor.actorType,
        input.actor.actorId,
        input.mode === "add" ? "tag.add" : "tag.remove",
        "memo",
        change.memoId,
        { tags, learning: { version: 1, workspaceId: input.workspaceId,
          fromNotebookId: change.notebookId, toNotebookId: change.notebookId,
          beforeTags: change.currentTags, afterTags: change.nextTags } }
      ),
      guard.after,
    );
  }

  await runMemoMutationBatch(db, statements);
  return { ok: true, updated: changes.length };
};
