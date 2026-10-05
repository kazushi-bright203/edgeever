import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { fetchEdgeEverApp } from "../apps/api/src/index";
import { createSelfHostedStorageAdapter } from "../apps/api/src/self-hosted-storage-adapter";
import { createMemoRecord } from "../apps/api/src/memo-service";
import { randomToken, hashPassword } from "../apps/api/src/auth-crypto";
import { sha256 } from "../apps/api/src/hash-utils";

test("private memo, image, search, tags and MCP reject anonymous requests and enforce token scopes", async () => {
  const sqlite = new Database(":memory:");
  for (const path of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(path, "utf8"));
  const storage = createSelfHostedStorageAdapter(sqlite, ".unused-resources");
  const env = { storage, EDGE_EVER_AUTH_USERNAME: "owner", EDGE_EVER_AUTH_PASSWORD: "only-a-test-password", EDGE_EVER_ALLOW_UNAUTHENTICATED: "false" };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as any;
  const request = (path: string, init?: RequestInit) => fetchEdgeEverApp(new Request(`http://private.test${path}`, init), env, ctx);
  const { workspace_id, notebook_id } = sqlite.query("SELECT workspace_id, notebook_id FROM memos WHERE id = 'memo_welcome'").get() as any;
  const memo = await createMemoRecord(storage.db, workspace_id, { notebookId: notebook_id, contentMarkdown: "秘密の本文" }, { actorType: "user", actorId: null }, "test");
  try {
    for (const path of ["/api/v1/memos?q=秘密&searchScope=body", `/api/v1/memos/${memo.id}`, "/api/v1/tags", "/api/v1/resources/fake/blob"]) {
      expect((await request(path)).status).toBe(401);
    }
    const token = `ev_${randomToken(32)}`;
    sqlite.query("INSERT INTO api_tokens (id, workspace_id, name, token_hash, token_value, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("privacy-test-token", workspace_id, "privacy-test", await sha256(token), token, '["read:memos"]', new Date().toISOString());
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    expect((await request(`/api/v1/memos/${memo.id}`, { headers })).status).toBe(200);
    expect((await request(`/api/v1/memos/${memo.id}`, { method: "PATCH", headers, body: JSON.stringify({ tags: ["unauthorized"] }) })).status).toBe(403);
    expect((await request("/api/v1/resources/fake/blob", { headers })).status).toBe(403);
    expect((await request("/api/v1/tags", { headers })).status).toBe(403);
    const mcp = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_memo", arguments: { memoId: memo.id } } };
    const mcpHeaders = { "MCP-Protocol-Version": "2025-11-25", Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
    expect((await request("/mcp", { method: "POST", headers: mcpHeaders, body: JSON.stringify(mcp) })).status).toBe(401);
    const read = await request("/mcp", { method: "POST", headers: { ...mcpHeaders, ...headers }, body: JSON.stringify(mcp) });
    expect(read.status).toBe(200);
    expect((await read.json() as any).result.structuredContent.memo.id).toBe(memo.id);
    const forbidden = await request("/mcp", { method: "POST", headers: { ...mcpHeaders, ...headers }, body: JSON.stringify({ ...mcp, params: { name: "update_memo", arguments: { memoId: memo.id, expectedRevision: memo.revision, contentMarkdown: "不正更新" } } }) });
    expect((await forbidden.json() as any).result.isError).toBe(true);
  } finally { sqlite.close(); }
});
