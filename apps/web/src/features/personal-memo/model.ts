import type { MemoDetail, TiptapDoc } from "@edgeever/shared";

export type PersonalDraft = {
  key: string;
  memoId: string;
  body: string;
  syncedBody: string;
  baseRevision: number;
  baseContentHash: string;
  changedAt: number;
  images?: TiptapDoc["content"];
};

// A plain-text prototype must never flatten an existing rich note or image.
export const readPlainBody = (doc: TiptapDoc): string | null => {
  const lines: string[] = [];
  for (const paragraph of doc.content) {
    if (paragraph.type === "image") {
      if (!/^\/api\/v1\/resources\/[^/]+\/blob(?:\?|$)/.test(String(paragraph.attrs?.src ?? ""))) return null;
      continue;
    }
    if (paragraph.type !== "paragraph" || Object.keys(paragraph.attrs ?? {}).length) return null;
    let line = "";
    for (const node of paragraph.content ?? []) {
      if (node.type !== "text" || !("text" in node) || (node.marks?.length ?? 0) > 0) return null;
      line += node.text;
    }
    lines.push(line);
  }
  return lines.join("\n");
};

export const plainBodyToDoc = (body: string): TiptapDoc => ({
  type: "doc",
  content: body.split("\n").map((text) => ({
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  })),
});

export const draftKey = (accountId: string, memoId: string) => JSON.stringify([accountId, memoId]);
export const hasUnsavedBody = (draft: PersonalDraft) => draft.body !== draft.syncedBody;
export const draftFromMemo = (accountId: string, memo: MemoDetail): PersonalDraft | null => {
  const body = readPlainBody(memo.contentJson);
  return body === null ? null : {
    key: draftKey(accountId, memo.id), memoId: memo.id, body, syncedBody: body,
    baseRevision: memo.revision, baseContentHash: memo.contentHash, changedAt: Date.now(),
    images: memo.contentJson.content.filter((node) => node.type === "image"),
  };
};

// When typing continues during an upload, only advance the saved baseline.
export const acknowledgeSave = (latest: PersonalDraft, sent: PersonalDraft, memo: MemoDetail): PersonalDraft => ({
  ...latest,
  syncedBody: sent.body,
  baseRevision: memo.revision,
  baseContentHash: memo.contentHash,
});

export type DraftRepository = {
  get(key: string): Promise<PersonalDraft | undefined>;
  put(draft: PersonalDraft): Promise<unknown>;
};

export class DraftConflict extends Error {}

// All local changes and acknowledgements use one ordered queue. Otherwise a
// delayed IndexedDB write can put an old revision back over a newer one.
export class DraftCoordinator {
  private queues = new Map<string, Promise<unknown>>();
  private uploads = new Map<string, Promise<void>>();
  private persistenceErrors = new Map<string, unknown>();
  constructor(private repository: DraftRepository, private upload: (draft: PersonalDraft) => Promise<MemoDetail>) {}

  private ordered<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => undefined);
    return next;
  }

  initialize(server: PersonalDraft): Promise<PersonalDraft> {
    return this.ordered(server.key, async () => {
      const local = await this.repository.get(server.key);
      if (local && hasUnsavedBody(local)) return local;
      await this.repository.put(server);
      return server;
    });
  }

  change(key: string, body: string): Promise<PersonalDraft> {
    return this.ordered(key, async () => {
      const draft = await this.repository.get(key);
      if (!draft) throw new Error("下書きを準備できませんでした。");
      const updated = { ...draft, body, changedAt: Date.now() };
      try {
        await this.repository.put(updated);
        this.persistenceErrors.delete(key);
      } catch (error) {
        this.persistenceErrors.set(key, error);
        throw error;
      }
      return updated;
    });
  }

  flush(key: string): Promise<void> {
    const running = this.uploads.get(key);
    if (running) return running;
    const task = this.saveLoop(key);
    this.uploads.set(key, task);
    void task.finally(() => { if (this.uploads.get(key) === task) this.uploads.delete(key); }).catch(() => undefined);
    return task;
  }

  private async saveLoop(key: string): Promise<void> {
    while (true) {
      const sent = await this.ordered(key, () => {
        if (this.persistenceErrors.has(key)) throw this.persistenceErrors.get(key);
        return this.repository.get(key);
      });
      if (!sent || !hasUnsavedBody(sent)) return;
      const saved = await this.upload(sent);
      await this.ordered(key, async () => {
        const latest = await this.repository.get(key);
        if (latest) await this.repository.put(acknowledgeSave(latest, sent, saved));
      });
    }
  }
}
