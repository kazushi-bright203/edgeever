import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { updateMemoRecord } from "../apps/api/src/memo-service";
import { batchMemoWrite } from "../apps/api/src/memo-write-guard";
import { createSelfHostedStorageAdapter } from "../apps/api/src/self-hosted-storage-adapter";
import type { DatabaseAdapter } from "../apps/api/src/storage-contract";

const fixture = () => {
  const sqlite = new Database(":memory:");
  const migrations = globSync("migrations/*.sql").sort();
  for (const path of migrations.filter((path) => path.split(/[\\/]/).at(-1)! < "0060_")) {
    sqlite.exec(readFileSync(path, "utf8"));
  }
  const before = sqlite.query("SELECT * FROM memos").all();
  const contentBefore = sqlite.query("SELECT * FROM memo_contents").all();
  for (const path of migrations.filter((path) => path.split(/[\\/]/).at(-1)! >= "0060_")) sqlite.exec(readFileSync(path, "utf8"));
  expect(sqlite.query("SELECT * FROM memos").all()).toEqual(before);
  expect(sqlite.query("SELECT * FROM memo_contents").all()).toEqual(contentBefore);
  const base = sqlite.query(`SELECT m.*, c.revision, c.content_hash
    FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
    WHERE m.id = 'memo_welcome'`).get() as any;
  const db = createSelfHostedStorageAdapter(sqlite, ".unused-resources").db;
  return { sqlite, base, db };
};

test("populated old schema upgrades and the common service saves without leftover guards", async () => {
  const { sqlite, base, db } = fixture();
  try {
    const result = await updateMemoRecord(db, base.workspace_id, base.id,
      { expectedRevision: base.revision, contentMarkdown: "旧データからの更新😊" },
      { actorType: "user", actorId: null }, "migration-test");
    expect(result.error).toBeUndefined();
    expect(result.memo?.contentText).toBe("旧データからの更新😊");
    expect(result.memo?.revision).toBe(base.revision + 1);
    expect(sqlite.query("SELECT * FROM memo_write_guards").all()).toEqual([]);
  } finally { sqlite.close(); }
});

test("two saves that both read the same revision produce one winner and one conflict", async () => {
  const { sqlite, base, db } = fixture();
  let arrivals = 0;
  let release!: () => void;
  const bothReady = new Promise<void>((resolve) => { release = resolve; });
  const concurrent: DatabaseAdapter = {
    prepare: (query) => db.prepare(query),
    batch: async (statements) => {
      if (++arrivals === 2) release();
      await bothReady;
      return db.batch(statements);
    },
  };
  try {
    const results = await Promise.all(["同時保存A", "同時保存B"].map((body) =>
      updateMemoRecord(concurrent, base.workspace_id, base.id,
        { expectedRevision: base.revision, contentMarkdown: body, tags: [body] },
        { actorType: "user", actorId: null }, body)));
    expect(results.filter((result) => !result.error)).toHaveLength(1);
    expect(results.filter((result) => result.error === "revision_conflict" && result.status === 409)).toHaveLength(1);
    const winner = results.find((result) => !result.error)!.memo!;
    expect(sqlite.query("SELECT content_text, revision FROM memo_contents WHERE memo_id = ?").get(base.id))
      .toEqual({ content_text: winner.contentText, revision: base.revision + 1 });
    expect(JSON.parse((sqlite.query("SELECT tags_json FROM memos WHERE id = ?").get(base.id) as any).tags_json))
      .toEqual([winner.contentText]);
    expect(sqlite.query("SELECT content_text, tags FROM memo_search_documents WHERE memo_id = ?").get(base.id))
      .toEqual({ content_text: winner.contentText, tags: winner.contentText });
    expect(sqlite.query("SELECT content_hash, revision FROM memo_revisions WHERE memo_id = ?").all(base.id))
      .toEqual([{ content_hash: base.content_hash, revision: base.revision }]);
    expect(sqlite.query("SELECT * FROM memo_write_guards").all()).toEqual([]);
    expect((sqlite.query("SELECT count(*) AS count FROM audit_events WHERE entity_id = ? AND action = 'memo.update'").get(base.id) as any).count).toBe(1);
  } finally { sqlite.close(); }
});

test("a metadata edit after the base read prevents the stale batch from changing anything", async () => {
  const { sqlite, base, db } = fixture();
  try {
    sqlite.query("UPDATE memos SET tags_json = ? WHERE id = ?").run('["別のタグ"]', base.id);
    expect(await batchMemoWrite(db, base.workspace_id, base, base.notebook_id, [
      db.prepare("UPDATE memo_contents SET content_text = 'lost' WHERE memo_id = ?").bind(base.id),
    ])).toBe(false);
    expect(sqlite.query("SELECT content_text FROM memo_contents WHERE memo_id = ?").get(base.id))
      .not.toEqual({ content_text: "lost" });
  } finally { sqlite.close(); }
});

test("a later SQL failure rolls back metadata and guard; unrelated errors remain errors", async () => {
  const { sqlite, base, db } = fixture();
  try {
    await expect(batchMemoWrite(db, base.workspace_id, base, base.notebook_id, [
      db.prepare("UPDATE memos SET title = 'partial' WHERE id = ?").bind(base.id),
      db.prepare("INSERT INTO missing_table VALUES (1)"),
    ])).rejects.toThrow();
    expect(sqlite.query("SELECT title FROM memos WHERE id = ?").get(base.id)).toEqual({ title: base.title });
    expect(sqlite.query("SELECT * FROM memo_write_guards").all()).toEqual([]);
  } finally { sqlite.close(); }
});
