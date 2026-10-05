import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { MemoList } from './MemoList';
import { TagManager } from './TagManager';
import { MemoTools } from './MemoTools';
import { coordinator, personalDrafts } from "./drafts";
import { draftFromMemo, draftKey, hasUnsavedBody } from "./model";

const explain = (error: unknown) => error instanceof Error ? error.message : "処理を完了できませんでした。";

function MemoEditor({ accountId }: { accountId: string }) {
  const { memoId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(true);
  const [status, setStatus] = useState("読み込み中…");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [remoteText, setRemoteText] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useRef(true);
  const key = draftKey(accountId, memoId);
  const query = useQuery({ queryKey: ["personal-memo", memoId], queryFn: () => api.getMemo(memoId), retry: false, refetchOnWindowFocus: false });

  const flush = async () => {
    clearTimeout(timer.current); clearTimeout(maxTimer.current); maxTimer.current = undefined;
    if (conflict || !ready || !supported) return;
    if (active.current) setStatus("サーバーへ保存中…");
    try {
      await coordinator.flush(key);
      const latest = await personalDrafts.drafts.get(key);
      if (active.current) { setStatus(latest && hasUnsavedBody(latest) ? "端末に下書き保存済み" : "サーバーに保存済み"); setError(""); }
      void queryClient.invalidateQueries({ queryKey: ["personal-memos"] });
    } catch (failure) {
      if (!active.current) return;
      setError(explain(failure)); setStatus("未同期の下書きがあります");
      // Do not auto-retry a stale draft or ambiguous save response.
      setConflict(true);
    }
  };

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; clearTimeout(timer.current); clearTimeout(maxTimer.current); };
  }, [key]);
  useEffect(() => {
    if (!query.data) return;
    let current = true;
    const server = draftFromMemo(accountId, query.data.memo);
    if (!server) {
      void personalDrafts.drafts.get(key).then((draft) => {
        if (!current) return;
        setReady(true);
        if (draft && hasUnsavedBody(draft)) {
          setBody(draft.body); setSupported(true); setConflict(true);
          setStatus("ほかの画面の更新と競合しています");
          setError("サーバー側に書式や画像があります。下書きを保護して保存を停止しました。");
        } else {
          setSupported(false); setBody(query.data.memo.contentText); setStatus("書式・画像のあるメモ（閲覧のみ）");
        }
      }).catch((failure) => { if (current) setError(explain(failure)); });
      return () => { current = false; };
    }
    void coordinator.initialize(server).then((draft) => {
      if (!current) return;
      setBody(draft.body); setReady(true);
      const stale = hasUnsavedBody(draft) && (draft.baseRevision !== server.baseRevision || draft.baseContentHash !== server.baseContentHash);
      setConflict(stale);
      setStatus(stale ? "ほかの画面の更新と競合しています" : hasUnsavedBody(draft) ? "端末に下書き保存済み・未同期" : "サーバーに保存済み");
      if (stale) setError("下書きを保護しています。現在のサーバー本文を確認してください。");
    }).catch((failure) => { if (current) { setError(explain(failure)); setStatus("端末に下書きを保存できません"); } });
    return () => { current = false; };
  }, [query.data, accountId, key]);
  useEffect(() => {
    if (ready && supported && !conflict) timer.current = setTimeout(() => void flush(), 1000);
    return () => { clearTimeout(timer.current); };
  }, [ready, supported, conflict]);

  const change = (value: string) => {
    setBody(value); setStatus("端末に下書き保存中…");
    clearTimeout(timer.current);
    void coordinator.change(key, value).then(() => {
      if (active.current) setStatus("端末に下書き保存済み・未同期");
    }).catch((failure) => {
      clearTimeout(timer.current); clearTimeout(maxTimer.current); maxTimer.current = undefined;
      if (active.current) { setConflict(true); setError(explain(failure)); setStatus("下書きを保存できません。本文をコピーしてください。"); }
    });
    if (!conflict && !composing) {
      timer.current = setTimeout(() => void flush(), 1000);
      maxTimer.current ??= setTimeout(() => void flush(), 10000);
    }
  };

  return <main className="mx-auto flex h-[100dvh] max-w-3xl flex-col bg-card">
    <header className="flex items-center justify-between gap-3 border-b p-3">
      <Button variant="ghost" onClick={() => { void flush(); if (location.state?.fromMemoList) navigate(-1); else navigate("/memo", { replace: true }); }}>一覧へ</Button>
      <p role="status" aria-live="polite" className="text-right text-xs text-slate-500">{status}</p>
    </header>
    {(error || query.error) && <p role="alert" className="px-4 py-3 text-sm text-rose-700">{error || explain(query.error)}</p>}
    <Textarea autoFocus aria-label="メモ本文" placeholder="ここにメモを書く" value={body} disabled={!ready || toolBusy} readOnly={!supported}
      className="min-h-0 flex-1 resize-none rounded-none border-0 p-5 text-base leading-7 shadow-none focus-visible:ring-0 md:text-base"
      onChange={(event) => change(event.target.value)} onCompositionStart={() => { setComposing(true); clearTimeout(timer.current); clearTimeout(maxTimer.current); maxTimer.current = undefined; }}
      onCompositionEnd={() => { setComposing(false); if (!conflict) timer.current = setTimeout(() => void flush(), 1000); }} />
    {conflict && <section className="border-t bg-amber-50 p-3 text-sm">
      <p>下書きを残しています。本文はコピーして保管できます。</p>
      <Button className="mt-2" variant="outline" onClick={() => { void api.getMemo(memoId).then(({ memo }) => setRemoteText(memo.contentText)).catch((failure) => setError(explain(failure))); }}>サーバーの本文を確認</Button>
      {remoteText !== null && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap">{remoteText}</pre>}
    </section>}
    {query.data && <MemoTools memo={query.data.memo} disabled={!ready || conflict || composing || !supported}
      onBusy={setToolBusy} onError={setError} onSaved={(memo) => { queryClient.setQueryData(["personal-memo", memoId], { memo }); void queryClient.invalidateQueries({ queryKey: ["personal-memos"] }); void queryClient.invalidateQueries({ queryKey: ["personal-tags"] }); }}
      prepare={async () => { await flush(); const draft = await personalDrafts.drafts.get(key); if (!draft || hasUnsavedBody(draft)) throw new Error("下書きを先に保存してください。"); const { memo } = await api.getMemo(memoId); if (memo.revision !== draft.baseRevision || memo.contentHash !== draft.baseContentHash) throw new Error("ほかの画面で更新されました。再読み込みしてください。"); return memo; }} />}
    <footer className="flex items-center justify-between gap-2 border-t p-3 text-xs text-slate-500">
      <span>{body.length}文字 · {query.data?.memo.tags.join(" · ")} · ID: {memoId}</span>
      <Button variant="outline" size="sm" disabled={!ready || !supported || conflict || composing} onClick={() => void flush()}>保存</Button>
    </footer>
  </main>;
}

export function PersonalMemoApp({ accountId }: { accountId: string }) {
  const location = useLocation();
  return <Routes>
    <Route index element={<MemoList accountId={accountId} />} />
    <Route path="tags" element={<TagManager />} />
    <Route path=":memoId" element={<MemoEditor key={location.pathname} accountId={accountId} />} />
  </Routes>;
}
