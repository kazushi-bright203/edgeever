import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "../apps/api/src/self-hosted-storage-adapter";
import { createMemoRecord, getMemoDetail, updateMemoRecord, deleteMemoRecord, restoreMemoRecord, searchMemoSummaries, moveMemosToNotebook } from "../apps/api/src/memo-service";
import { listMemos } from "../apps/api/src/memo-list-service";
import { createTag, listTagSummaries, updateTagAcrossMemos } from "../apps/api/src/tag-service";
import { formattingContentKey, registerPersonalAiRoutes } from "../apps/api/src/personal-ai-routes";
import type { AppEnv } from "../apps/api/src/api-context";

function fixture() {
  const sqlite = new Database(":memory:");
  for (const path of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(path, "utf8"));
  const storage = createSelfHostedStorageAdapter(sqlite, ".unused-resources");
  const { workspace_id, notebook_id } = sqlite.query("SELECT workspace_id, notebook_id FROM memos WHERE id = 'memo_welcome'").get() as any;
  const actor = { actorType: "user" as const, actorId: null };
  const create = (body: string, tags: string[] = [], requestKey?: string) => createMemoRecord(storage.db, workspace_id,
    { notebookId: notebook_id, contentMarkdown: body, tags, requestKey }, actor, "test");
  return { sqlite, storage, db: storage.db, workspace: workspace_id as string, notebook: notebook_id as string, actor, create };
}

test("moving a memo verifies both its revision and destination in the mutation batch", async () => {
  const f = fixture();
  try {
    const memo = await f.create("移動中も本文を保持");
    f.sqlite.query("INSERT INTO notebooks (id, workspace_id, name, slug) VALUES (?, ?, ?, ?)").run("move-target", f.workspace, "検査保存先", "move-target");
    const racingDb = { prepare: f.db.prepare.bind(f.db), batch: async (statements: any[]) => {
      f.sqlite.query("UPDATE memos SET title = ? WHERE id = ?").run("他の画面の変更", memo.id);
      return f.db.batch(statements);
    } } as typeof f.db;
    await expect(moveMemosToNotebook(racingDb, f.workspace, [memo.id], "move-target", f.actor, "test")).rejects.toThrow("更新");
    expect((await getMemoDetail(f.db, f.workspace, memo.id))!.notebookId).toBe(f.notebook);
    await expect(moveMemosToNotebook(f.db, f.workspace, [memo.id], "missing-target", f.actor, "test")).rejects.toThrow("更新");
    expect(await moveMemosToNotebook(f.db, f.workspace, [memo.id], "move-target", f.actor, "test")).toBe(1);
    const moved = (await getMemoDetail(f.db, f.workspace, memo.id))!;
    expect(moved.contentText).toBe(memo.contentText); expect(moved.notebookId).toBe("move-target");
    expect((f.sqlite.query("SELECT count(*) AS count FROM memo_write_guards").get() as any).count).toBe(0);
  } finally { f.sqlite.close(); }
});

test("simultaneous creation retries produce one memo; changed payload cannot reuse the key", async () => {
  const f = fixture();
  try {
    const memos = await Promise.all([1, 2, 3].map(() => f.create("再送😊", [], "same-request")));
    expect(new Set(memos.map((memo) => memo.id)).size).toBe(1);
    expect((f.sqlite.query("SELECT count(*) AS count FROM audit_events WHERE entity_id = ? AND action = 'memo.create'").get(memos[0].id) as any).count).toBe(1);
    await expect(f.create("違う本文", [], "same-request")).rejects.toThrow("different content");
    expect((await f.create("再送😊", [], "same-request")).id).toBe(memos[0].id);
  } finally { f.sqlite.close(); }
});

test("tag IDs survive rename, empty tags exist, collisions and system edits are rejected", async () => {
  const f = fixture();
  try {
    await createTag(f.db, f.workspace, "質問例"); await createTag(f.db, f.workspace, "空タグ");
    const before = (await listTagSummaries(f.db, f.workspace)).find((tag) => tag.name === "質問例")!;
    expect(before.memoCount).toBe(0);
    const memo = await f.create("本文保持", ["質問例"]);
    await updateTagAcrossMemos(f.db, f.workspace, "質問例", "授業", f.actor, "test");
    expect((await listTagSummaries(f.db, f.workspace)).find((tag) => tag.name === "授業")!.id).toBe(before.id);
    const renamed = (await getMemoDetail(f.db, f.workspace, memo.id))!;
    expect(renamed.contentText).toBe("本文保持"); expect(renamed.revision).toBe(memo.revision + 1);
    await expect(updateTagAcrossMemos(f.db, f.workspace, "授業", "空タグ", f.actor, "test")).rejects.toThrow("同じ名前");
    await expect(updateTagAcrossMemos(f.db, f.workspace, "未整理", null, f.actor, "test")).rejects.toThrow("未整理");
    await expect(updateTagAcrossMemos(f.db, f.workspace, "未整理", "済", f.actor, "test")).rejects.toThrow("未整理");
    await updateTagAcrossMemos(f.db, f.workspace, "授業", null, f.actor, "test");
    expect((await getMemoDetail(f.db, f.workspace, memo.id))!.contentText).toBe("本文保持");
    expect((await listTagSummaries(f.db, f.workspace)).find((tag) => tag.name === "空タグ")!.memoCount).toBe(0);
  } finally { f.sqlite.close(); }
});

test("Japanese substring and all selected tags combine; tag names are excluded from body search", async () => {
  const f = fixture();
  try {
    const both = await f.create("授業の気づき 100%", ["MBTI", "質問例"]);
    await f.create("授業の気づき", ["MBTI"]);
    await f.create("別の本文", ["タグだけの検索語"]);
    const result = await listMemos(f.db, { workspaceId: f.workspace, query: "気づ", tags: ["MBTI", "質問例"], searchScope: "body" });
    expect(result.memos.map((memo) => memo.id)).toEqual([both.id]); expect(result.totalCount).toBe(1);
    expect((await listMemos(f.db, { workspaceId: f.workspace, query: "100%", searchScope: "body" })).memos.map((memo) => memo.id)).toEqual([both.id]);
    expect((await listMemos(f.db, { workspaceId: f.workspace, query: "タグだけの検索語", searchScope: "body" })).totalCount).toBe(0);
    expect(await searchMemoSummaries(f.db, { workspaceId: f.workspace, query: "タグだけの検索語", searchScope: "body", limit: 20 })).toEqual([]);
    expect((await searchMemoSummaries(f.db, { workspaceId: f.workspace, query: "気づ", searchScope: "body", tags: ["MBTI", "質問例"], limit: 20 })).map((memo) => memo.id)).toEqual([both.id]);
  } finally { f.sqlite.close(); }
});

test("organization is explicit; trash rename and restore retain canonical tags and body", async () => {
  const f = fixture();
  try {
    const memo = await f.create("保存した本文", ["元タグ"]);
    const updated = await updateMemoRecord(f.db, f.workspace, memo.id, { expectedRevision: memo.revision, tags: ["元タグ", "追加タグ"] }, f.actor, "test");
    expect(updated.memo!.tags).toContain("未整理");
    const organized = await updateMemoRecord(f.db, f.workspace, memo.id, { expectedRevision: updated.memo!.revision, organized: true }, f.actor, "test");
    expect(organized.memo!.tags).not.toContain("未整理");
    await deleteMemoRecord({ storage: f.storage } as any, f.workspace, memo.id, false, f.actor);
    await updateTagAcrossMemos(f.db, f.workspace, "元タグ", "改名タグ", f.actor, "test");
    const restored = await restoreMemoRecord(f.db, f.workspace, memo.id, f.actor);
    expect(restored.contentText).toBe("保存した本文"); expect(restored.tags).toEqual(["改名タグ", "追加タグ"]);
    expect(restored.revision).toBeGreaterThan(organized.memo!.revision);
  } finally { f.sqlite.close(); }
});

test("AI previews apply once, retain history and reject stale or canceled proposals without provider calls", async () => {
  const f = fixture();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", { kind: "user", actorType: "user", actorId: null, username: "owner", displayName: "Owner", scopes: [], workspaceId: f.workspace, role: "owner" }); await next(); });
  registerPersonalAiRoutes(app);
  app.onError((error: any, c) => c.json({ error: { message: error.message } }, error.status ?? 500));
  const seed = (id: string, memo: any, state = "ready") => f.sqlite.query(`INSERT INTO personal_ai_previews
    (id, workspace_id, memo_id, base_revision, kind, period, state, result_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'classify', '2026-10', ?, ?, ?, ?)`).run(id, f.workspace, memo.id, memo.revision, state, '{"tags":["AI候補"]}', new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
  const apply = (id: string) => app.request(`/api/v1/personal-ai/previews/${id}/apply`, { method: "POST" }, { storage: f.storage } as any);
  try {
    const memo = await f.create("本文を変更しない"); seed("valid", memo);
    expect((await apply("valid")).status).toBe(200);
    const after = (await getMemoDetail(f.db, f.workspace, memo.id))!;
    expect(after.contentText).toBe(memo.contentText); expect(after.tags).toContain("AI候補");
    expect((await apply("valid")).status).toBe(200);
    expect((await getMemoDetail(f.db, f.workspace, memo.id))!.revision).toBe(after.revision);
    expect((f.sqlite.query("SELECT count(*) AS count FROM memo_revisions WHERE memo_id = ?").get(memo.id) as any).count).toBe(1);
    seed("stale", memo); expect((await apply("stale")).status).toBe(409);
    seed("canceled", after, "canceled"); expect((await apply("canceled")).status).toBe(409);
    expect((await getMemoDetail(f.db, f.workspace, memo.id))!.revision).toBe(after.revision);
    expect(formattingContentKey("# 仮説\n- 可能性がある 123")).toBe(formattingContentKey("仮説\n可能性がある 123"));
    expect(formattingContentKey("確実である 124")).not.toBe(formattingContentKey("可能性がある 123"));
  } finally { f.sqlite.close(); }
});
