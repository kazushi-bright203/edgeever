import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { docToMarkdown, type MemoDetail, type TiptapDoc } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { compressImageForUpload } from "@/lib/image-compression";

type Preview = { id: string; memoId: string; baseRevision: number; kind: "classify" | "format"; before: string; tags?: string[]; body?: string };
async function aiRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/personal-ai/${path}`, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? "AI処理を完了できませんでした。");
  return payload;
}

export function MemoTools({ memo, prepare, onSaved, onBusy, onError, disabled }: {
  memo: MemoDetail; prepare: () => Promise<MemoDetail>; onSaved: (memo: MemoDetail) => void;
  onBusy: (busy: boolean) => void; onError: (message: string) => void; disabled: boolean;
}) {
  const navigate = useNavigate(); const lock = useRef(false); const file = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();
  const view = params.get("view");
  const panel = view === "tags" || view === "history" || view === "delete" ? view : null;
  const openedHere = useRef(false);
  const setPanel = (next: "tags" | "history" | "delete" | "preview" | null) => {
    if (!next && openedHere.current) { openedHere.current = false; navigate(-1); return; }
    const updated = new URLSearchParams(params);
    if (next) updated.set("view", next); else updated.delete("view");
    openedHere.current = next !== null; setParams(updated, { replace: !next });
  };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (view !== "preview" && preview) {
      void aiRequest(`previews/${preview.id}`, "DELETE").catch(() => undefined);
      setPreview(null);
    }
  }, [view, preview]);
  const tags = useQuery({ queryKey: ["personal-tags"], queryFn: () => api.listTags() });
  const history = useQuery({ queryKey: ["personal-history", memo.id, memo.revision], queryFn: () => api.listMemoRevisions(memo.id), enabled: panel === "history" });
  const run = async (work: () => Promise<void>) => {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); onBusy(true); onError("");
    try { await work(); } catch (error) { onError(error instanceof Error ? error.message : "処理に失敗しました。"); }
    finally { lock.current = false; setBusy(false); onBusy(false); }
  };
  const update = async (payload: { tags?: string[]; organized?: boolean; contentJson?: TiptapDoc; contentMarkdown?: string }) => {
    const current = await prepare(); const { editSession } = await api.createMemoEditSession(current.id);
    if (editSession.baseRevision !== current.revision) throw new Error("メモが更新されました。再読み込みしてください。");
    const { memo: saved } = await api.updateMemo(current.id, { ...payload, expectedRevision: current.revision, expectedContentHash: current.contentHash, editSessionId: editSession.id });
    onSaved(saved);
  };
  const upload = async (chosen: File) => {
    const current = await prepare();
    if (!/^(image\/(png|jpeg|webp|gif|avif))$/.test(chosen.type)) throw new Error("PNG・JPEG・WebP・GIF・AVIF画像を選んでください。HEICは写真をJPEGで共有してください。");
    if (chosen.size > 20 * 1024 * 1024) throw new Error("画像は20MB以内にしてください。");
    const compressed = await compressImageForUpload(chosen);
    const { resource } = await api.uploadMemoResource(current.id, compressed.file);
    try {
      const contentJson: TiptapDoc = { ...current.contentJson, content: [...current.contentJson.content, { type: "image", attrs: { src: resource.url, alt: chosen.name } }] };
      const { editSession } = await api.createMemoEditSession(current.id);
      const { memo: saved } = await api.updateMemo(current.id, { expectedRevision: current.revision, expectedContentHash: current.contentHash, editSessionId: editSession.id,
        contentJson, contentMarkdown: docToMarkdown(contentJson) });
      onSaved(saved);
    } catch (error) { await api.deleteResource(resource.id).catch(() => undefined); throw error; }
  };
  const propose = async (kind: "classify" | "format") => {
    const current = await prepare(); const response = await aiRequest<{ preview: Preview }>("previews", "POST", { memoId: current.id, expectedRevision: current.revision, kind });
    setPreview(response.preview); setPanel("preview");
  };
  const images = memo.contentJson.content.filter((node) => node.type === "image");
  return <>
    <section className="flex max-h-28 shrink-0 flex-wrap gap-2 overflow-y-auto border-t p-2" aria-label="メモ操作">
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => file.current?.click()}>画像追加</Button>
      <input ref={file} className="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" aria-label="添付画像" onChange={(event) => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) void run(() => upload(chosen)); }} />
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setPanel("tags")}>タグ変更</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(() => update({ organized: !memo.tags.includes("未整理") ? false : true }))}>{memo.tags.includes("未整理") ? "整理完了" : "未整理に戻す"}</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(() => propose("classify"))}>AI分類</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run(() => propose("format"))}>AI整形</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setPanel("history")}>履歴</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setPanel("delete")}>ごみ箱へ</Button>
    </section>
    {images.length > 0 && <section aria-label="添付画像一覧" className="flex max-h-32 shrink-0 gap-2 overflow-x-auto border-t p-2">{images.map((image, index) => {
      const src = String(image.attrs?.src ?? "");
      if (!/^\/api\/v1\/resources\/[^/]+\/blob(?:\?|$)/.test(src)) return <p key={index}>外部画像は元の画面で確認してください。</p>;
      return <a key={index} href={src} target="_blank" rel="noreferrer" className="shrink-0 rounded border bg-muted p-1" aria-label={`画像${index + 1}を開く`}><img src={src} alt={String(image.attrs?.alt ?? "添付画像")} className="h-20 rounded object-contain" /><p className="max-w-40 truncate text-xs">{String(image.attrs?.alt ?? `画像${index + 1}`)}</p></a>;
    })}</section>}
    <Dialog open={panel !== null} onOpenChange={(open) => { if (!open && !busy) setPanel(null); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{panel === "tags" ? "タグ変更" : panel === "history" ? "保存履歴" : "ごみ箱へ移動"}</DialogTitle></DialogHeader>
      {panel === "tags" && <div className="flex flex-wrap gap-2">{tags.data?.tags.filter((tag) => tag.name !== "未整理").map((tag) => <Button key={tag.id ?? tag.name} aria-pressed={memo.tags.includes(tag.name)} variant={memo.tags.includes(tag.name) ? "solid" : "outline"} disabled={busy} onClick={() => void run(() => update({ tags: memo.tags.includes(tag.name) ? memo.tags.filter((name) => name !== tag.name) : [...memo.tags, tag.name] }))}>{tag.name}</Button>)}</div>}
      {panel === "history" && <div>{history.isLoading && <p>読み込み中…</p>}{history.error && <p role="alert">{String(history.error)}</p>}{history.data?.revisions.map((revision) => <article key={revision.id} className="border-b py-3"><p className="text-xs">{new Date(revision.createdAt).toLocaleString("ja-JP")} · 版{revision.revision}</p><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-sm">{revision.contentMarkdown}</pre><Button variant="outline" disabled={busy} onClick={() => void run(async () => { const current = await prepare(); const { memo: restored } = await api.restoreMemoRevision(memo.id, revision.id, current.revision); onSaved(restored); setPanel(null); })}>この履歴に戻す</Button></article>)}{history.data?.revisions.length === 0 && <p>保存履歴はありません。</p>}</div>}
      {panel === "delete" && <><p>本文・画像・タグを保持して、ごみ箱へ移します。</p><Button disabled={busy} onClick={() => void run(async () => { await prepare(); await api.deleteMemo(memo.id); navigate("/memo", { replace: true }); })}>ごみ箱へ移動する</Button></>}
    </DialogContent></Dialog>
    <Dialog open={preview !== null && view === "preview"} onOpenChange={(open) => { if (!open && !busy) setPanel(null); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{preview?.kind === "classify" ? "AI分類の提案" : "AI整形の確認"}</DialogTitle></DialogHeader>
      {preview?.kind === "classify" ? <p>追加候補：{preview.tags?.join(" · ")}</p> : <><p>変更前</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap text-sm">{preview?.before}</pre><p>変更後</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap text-sm">{preview?.body}</pre></>}
      <div className="flex gap-2"><Button disabled={busy} onClick={() => void run(async () => { if (!preview) return; await prepare(); const { memo: saved } = await aiRequest<{ memo: MemoDetail }>(`previews/${preview.id}/apply`, "POST", {}); onSaved(saved); setPreview(null); setPanel(null); })}>適用</Button>
        <Button variant="outline" disabled={busy} onClick={() => { if (preview) void run(async () => { await aiRequest(`previews/${preview.id}`, "DELETE"); setPreview(null); setPanel(null); }); }}>取り消し</Button></div>
    </DialogContent></Dialog>
  </>;
}
