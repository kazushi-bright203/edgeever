import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export function MemoList({ accountId }: { accountId: string }) {
  const navigate = useNavigate(); const location = useLocation(); const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? ""; const selected = params.getAll("tags"); const trash = params.get("trash") === "1";
  const [search, setSearch] = useState(q); const [filters, setFilters] = useState(false);
  const [creating, setCreating] = useState(false); const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const pendingKey = `supermemo.create:${accountId}`;
  const tags = useQuery({ queryKey: ["personal-tags"], queryFn: () => api.listTags() });
  const query = useInfiniteQuery({ queryKey: ["personal-memos", q, selected, trash], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.listMemos({ q, tags: selected, searchScope: "body", trash, sort: "updated-desc", limit: 50, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined, refetchInterval: 5000, refetchIntervalInBackground: false });
  const memos = query.data?.pages.flatMap((page) => page.memos) ?? [];
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => {
    if (!query.data || !listRef.current) return;
    listRef.current.scrollTop = Number(sessionStorage.getItem(`supermemo.scroll:${location.key}`) ?? 0);
  }, [location.key, Boolean(query.data)]);
  const updateSearch = (value: string) => { const next = new URLSearchParams(params); value.trim() ? next.set("q", value.trim()) : next.delete("q"); setParams(next, { replace: true }); };
  useEffect(() => { if (search === q) return; const timer = setTimeout(() => updateSearch(search), 300); return () => clearTimeout(timer); }, [search, q]);
  const toggleTag = (name: string) => {
    const next = new URLSearchParams(params); next.delete("tags");
    for (const tag of selected.includes(name) ? selected.filter((tag) => tag !== name) : [...selected, name]) next.append("tags", tag);
    setParams(next, { replace: true });
  };
  const create = async () => {
    if (creating) return; setCreating(true); setError("");
    try {
      const requestKey = localStorage.getItem(pendingKey) ?? crypto.randomUUID();
      localStorage.setItem(pendingKey, requestKey);
      const { notebooks } = await api.listNotebooks();
      const notebook = notebooks.find((item) => item.slug === "inbox") ?? notebooks[0];
      if (!notebook) throw new Error("保存先を準備できませんでした。");
      const { memo } = await api.createMemo({ requestKey, notebookId: notebook.id, tags: ["未整理"] });
      localStorage.removeItem(pendingKey);
      navigate(`/memo/${memo.id}`, { state: { fromMemoList: true } });
    } catch (failure) { setError(`${failure instanceof Error ? failure.message : "作成できませんでした。"} もう一度押すと同じ作成を再確認します。`); }
    finally { setCreating(false); }
  };
  return <main className="mx-auto flex h-[100dvh] max-w-3xl flex-col bg-card">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b p-3"><h1 className="text-lg font-semibold">{trash ? "ごみ箱" : "スーパーメモ"}</h1>
      {!trash && <Button disabled={creating} onClick={() => void create()}>{creating ? "作成中…" : "新しいメモ"}</Button>}</header>
    <nav className="flex flex-wrap gap-2 border-b px-3 py-2" aria-label="メモ帳の操作">
      <Button variant="outline" size="sm" asChild><Link to="/memo">すべて</Link></Button>
      <Button variant="outline" size="sm" asChild><Link to="/memo?tags=未整理">未整理</Link></Button>
      <Button variant="outline" size="sm" asChild><Link to="/memo/tags">タグ整理</Link></Button>
      <Button variant="outline" size="sm" asChild><Link to="/memo?trash=1">ごみ箱</Link></Button>
    </nav>
    <form className="flex gap-2 border-b p-3" onSubmit={(event) => { event.preventDefault(); updateSearch(search); setFilters(true); }}>
      <Input aria-label="メモ検索" placeholder="本文・タイトルを検索" value={search} onChange={(event) => setSearch(event.target.value)} />
      <Button variant="outline" type="submit">検索</Button>
    </form>
    {(filters || selected.length > 0) && <section className="border-b p-3" aria-label="タグ絞り込み">
      <p className="mb-2 text-xs text-muted-foreground">選択したタグをすべて含むメモ</p>
      <div className="flex flex-wrap gap-2">{tags.data?.tags.map((tag) => <Button key={tag.id ?? tag.name} size="sm" variant={selected.includes(tag.name) ? "solid" : "outline"} aria-pressed={selected.includes(tag.name)} onClick={() => toggleTag(tag.name)}>{tag.name}</Button>)}
        <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setParams(trash ? { trash: "1" } : {}, { replace: true }); }}>条件解除</Button></div>
    </section>}
    {(error || query.error) && <p role="alert" className="p-3 text-sm text-rose-700">{error || String(query.error)}</p>}
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" onScroll={(event) => sessionStorage.setItem(`supermemo.scroll:${location.key}`, String(event.currentTarget.scrollTop))}>
      {query.isLoading && <p role="status" className="p-4">読み込み中…</p>}
      {memos.map((memo) => <article key={memo.id} className="border-b">
        {trash ? <div className="p-4"><p className="whitespace-pre-wrap">{memo.excerpt || "画像・空のメモ"}</p><p className="py-2 text-xs">{memo.tags.join(" · ")}</p>
          <Button variant="outline" onClick={() => { void api.restoreMemo(memo.id).then(() => client.invalidateQueries({ queryKey: ["personal-memos"] })).catch((failure) => setError(String(failure))); }}>復元</Button></div>
          : <Link to={`/memo/${memo.id}`} state={{ fromMemoList: true }} className="block p-4 hover:bg-muted focus-visible:ring-2 focus-visible:ring-emerald-500">
            <p className="truncate font-medium">{memo.excerpt.split("\n")[0] || "画像・空のメモ"}</p><p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">{memo.excerpt}</p>
            <p className="mt-2 text-xs text-muted-foreground">{memo.tags.join(" · ")}　{new Date(memo.updatedAt).toLocaleString("ja-JP")}</p></Link>}
      </article>)}
      {!query.isLoading && !query.error && memos.length === 0 && <p className="p-6 text-muted-foreground">{trash ? "ごみ箱は空です。" : "条件に一致するメモがありません。"}</p>}
      {query.hasNextPage && <Button className="m-3" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>続きを表示</Button>}
    </div>
    <footer className="border-t p-3 text-xs text-muted-foreground">{query.data?.pages[0]?.totalCount ?? 0}件 · 本文と画像は同じメモに保存されます</footer>
  </main>;
}
