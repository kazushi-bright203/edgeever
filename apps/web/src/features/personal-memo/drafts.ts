import Dexie, { type Table } from "dexie";
import { docToMarkdown } from "@edgeever/shared";
import { api } from "@/lib/api";
import { DraftConflict, DraftCoordinator, plainBodyToDoc, type PersonalDraft } from "./model";

// This database contains only unsent local drafts, never canonical memo data.
class PersonalDraftDatabase extends Dexie {
  drafts!: Table<PersonalDraft, string>;
  constructor() {
    super("supermemo-local-drafts");
    this.version(1).stores({ drafts: "key,memoId,changedAt" });
  }
}
export const personalDrafts = new PersonalDraftDatabase();
export const coordinator = new DraftCoordinator(personalDrafts.drafts, async (draft) => {
  const { editSession } = await api.createMemoEditSession(draft.memoId);
  if (editSession.baseRevision !== draft.baseRevision || editSession.baseContentHash !== draft.baseContentHash) {
    throw new DraftConflict("ほかの画面で更新されています。下書きを残して保存を停止しました。");
  }
  const contentJson = plainBodyToDoc(draft.body);
  contentJson.content.push(...(draft.images ?? []));
  const { memo } = await api.updateMemo(draft.memoId, {
    expectedRevision: draft.baseRevision,
    expectedContentHash: draft.baseContentHash,
    editSessionId: editSession.id,
    contentJson,
    contentMarkdown: docToMarkdown(contentJson),
  });
  return memo;
});
