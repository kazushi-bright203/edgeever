import { expect, test } from "bun:test";
import type { MemoDetail } from "@edgeever/shared";
import { DraftConflict, DraftCoordinator, draftFromMemo, draftKey, hasUnsavedBody, plainBodyToDoc, readPlainBody, type PersonalDraft } from "../apps/web/src/features/personal-memo/model";

const memo = (body: string, revision = 1): MemoDetail => ({
  id: "memo-test", notebookId: "inbox", title: null, excerpt: body, tags: ["未整理"],
  isPinned: false, isArchived: false, isDeleted: false, revision, createdAt: "", updatedAt: "", deletedAt: null,
  contentJson: plainBodyToDoc(body), contentMarkdown: body, contentText: body, contentHash: `hash-${revision}`,
  sourceMemoIds: [], mergeSourceCount: 0, mergedIntoMemoId: null,
});

const repository = () => {
  const records = new Map<string, PersonalDraft>();
  return {
    get: async (key: string) => records.get(key),
    put: async (draft: PersonalDraft) => { records.set(draft.key, structuredClone(draft)); },
  };
};

test("plain input preserves one character, literal markup, emoji and blank lines", () => {
  for (const body of ["あ", "# 見出しではない\n\n**そのまま**\n😊\n", ""]) expect(readPlainBody(plainBodyToDoc(body))).toBe(body);
  expect(readPlainBody({ type: "doc", content: [{ type: "image", attrs: { src: "/image" } }] })).toBeNull();
  expect(readPlainBody({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }] }] })).toBeNull();
});

test("an existing unsent draft survives a reload and account scopes differ", async () => {
  const storage = repository();
  const controller = new DraftCoordinator(storage, async () => memo(""));
  const initial = draftFromMemo("owner", memo("saved"))!;
  await controller.initialize(initial);
  await controller.change(initial.key, "未送信");
  expect((await controller.initialize(draftFromMemo("owner", memo("remote", 2))!)).body).toBe("未送信");
  expect(draftKey("a,b", "c")).not.toBe(draftKey("a", "b,c"));
  expect(draftKey("another-owner", "memo-test")).not.toBe(initial.key);
});

test("typing during an upload survives acknowledgement and uploads serially with the new revision", async () => {
  const storage = repository();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sent: PersonalDraft[] = [];
  const controller = new DraftCoordinator(storage, async (draft) => {
    sent.push(structuredClone(draft));
    if (sent.length === 1) await gate;
    return memo(draft.body, draft.baseRevision + 1);
  });
  const initial = draftFromMemo("owner", memo("before"))!;
  await controller.initialize(initial);
  await controller.change(initial.key, "first");
  const saving = controller.flush(initial.key);
  while (sent.length === 0) await Promise.resolve();
  await controller.change(initial.key, "second");
  expect(controller.flush(initial.key)).toBe(saving);
  release(); await saving;
  expect(sent.map((draft) => [draft.body, draft.baseRevision])).toEqual([["first", 1], ["second", 2]]);
  const latest = (await storage.get(initial.key))!;
  expect(latest.body).toBe("second"); expect(latest.baseRevision).toBe(3); expect(hasUnsavedBody(latest)).toBe(false);
});

test("a revision conflict retains the unsent body and does not acknowledge or retry", async () => {
  const storage = repository();
  let attempts = 0;
  const controller = new DraftCoordinator(storage, async () => { attempts++; throw new DraftConflict("stale"); });
  const initial = draftFromMemo("owner", memo("saved"))!;
  await controller.initialize(initial); await controller.change(initial.key, "local");
  await expect(controller.flush(initial.key)).rejects.toThrow("stale");
  const latest = (await storage.get(initial.key))!;
  expect(latest.body).toBe("local"); expect(latest.syncedBody).toBe("saved"); expect(latest.baseRevision).toBe(1); expect(attempts).toBe(1);
});

test("a failed local write blocks upload rather than reporting an older body as saved", async () => {
  const storage = repository();
  let failing = false;
  let attempts = 0;
  const controller = new DraftCoordinator({
    get: storage.get,
    put: async (draft) => { if (failing) throw new Error("disk full"); return storage.put(draft); },
  }, async (draft) => { attempts++; return memo(draft.body, 2); });
  const initial = draftFromMemo("owner", memo("saved"))!;
  await controller.initialize(initial);
  await controller.change(initial.key, "previous draft");
  failing = true;
  await expect(controller.change(initial.key, "latest input")).rejects.toThrow("disk full");
  await expect(controller.flush(initial.key)).rejects.toThrow("disk full");
  expect(attempts).toBe(0);
});
