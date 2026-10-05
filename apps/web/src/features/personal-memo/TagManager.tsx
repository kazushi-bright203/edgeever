import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { TagSummary } from "@edgeever/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

function TagRow({ tag, run }: { tag: TagSummary; run: (work: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState(tag.name);
  const protectedTag = tag.isSystem || tag.name === "未整理";
  return <li className="flex flex-wrap items-center gap-2 border-b py-3">
    <Input className="min-w-0 flex-1" aria-label={`${tag.name}のタグ名`} value={name} disabled={protectedTag} onChange={(event) => setName(event.target.value)} />
    <span className="text-sm">{tag.memoCount}件{protectedTag ? " · システム" : ""}</span>
    {!protectedTag && <><Button variant="outline" disabled={!name.trim() || name.trim() === tag.name} onClick={() => void run(() => api.renameTag(tag.name, name))}>名前変更</Button>
      <Button variant="outline" onClick={() => void run(() => api.deleteTag(tag.name))}>タグ削除</Button></>}
  </li>;
}

export function TagManager() {
  const client = useQueryClient();
  const tags = useQuery({ queryKey: ["personal-tags"], queryFn: () => api.listTags() });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await work(); setMessage("タグを更新しました。メモの本文は保持されています。");
      await Promise.all([client.invalidateQueries({ queryKey: ["personal-tags"] }), client.invalidateQueries({ queryKey: ["personal-memos"] })]);
    } catch (error) { setMessage(error instanceof Error ? error.message : "タグを更新できませんでした。"); }
    finally { setBusy(false); }
  };
  return <main className="mx-auto min-h-[100dvh] max-w-3xl bg-card p-4">
    <header className="mb-4 flex items-center gap-4"><Button variant="ghost" asChild><Link to="/memo">一覧へ</Link></Button><h1 className="text-lg font-semibold">タグ整理</h1></header>
    <p className="mb-4 text-sm text-muted-foreground">タグ削除はメモを削除しません。未整理はメモの「整理完了」で外せます。</p>
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.createTag(name); setName(""); }); }}>
      <Input aria-label="新しいタグ名" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      <Button disabled={busy || !name.trim()}>タグ作成</Button>
    </form>
    {(message || tags.error) && <p role="status" className="py-3 text-sm">{message || String(tags.error)}</p>}
    <ul aria-busy={busy}>{tags.data?.tags.map((tag) => <TagRow key={tag.id ?? tag.name} tag={tag} run={run} />)}</ul>
  </main>;
}
