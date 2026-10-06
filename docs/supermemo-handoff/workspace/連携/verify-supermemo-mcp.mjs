import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "start-supermemo-mcp.mjs")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buffer = ""; let diagnostic = ""; let sequence = 0; const waiting = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { buffer += chunk; let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { const response = JSON.parse(line); const target = waiting.get(response.id);
      if (target) { waiting.delete(response.id); clearTimeout(target.timer); response.error ? target.reject(new Error(response.error.message)) : target.resolve(response.result); }
    } catch { /* Native process output that is not JSON cannot satisfy an RPC. */ }
  }
});
child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-3000); });
child.on("exit", (code) => { for (const target of waiting.values()) { clearTimeout(target.timer); target.reject(new Error(`MCP process exited: ${code}; ${diagnostic.replace(/Bearer\s+\S+|[A-Za-z0-9+/=_-]{24,}/g, "[redacted]")}`)); } waiting.clear(); });
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence; const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 30000);
  waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args = {}) => { const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(`MCP tool failed: ${name}`); return result.structuredContent; };
try {
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "supermemo-installed-connection-check", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await rpc("tools/list", {});
  if (!tools.tools.some((tool) => tool.name === "update_memo")) throw new Error("Memo tools unavailable");
  await call("get_current_user");
  const list = await call("list_notebooks");
  const notebooks = list.notebooks ?? list;
  const notebook = notebooks.find((item) => item.slug === "inbox") ?? notebooks[0];
  const args = { notebookId: notebook.id, requestKey: crypto.randomUUID(), contentMarkdown: "Codex登録済み接続の検査用メモ" };
  const { memo } = await call("create_memo", args);
  const { memo: repeated } = await call("create_memo", args);
  if (repeated.id !== memo.id) throw new Error("Creation retry duplicated memo");
  const { memo: changed } = await call("update_memo", { memoId: memo.id, expectedRevision: memo.revision, contentMarkdown: "登録済み接続からの更新を確認" });
  const { memo: reread } = await call("get_memo", { memoId: memo.id });
  if (reread.id !== memo.id || reread.revision !== changed.revision || reread.contentText !== "登録済み接続からの更新を確認") throw new Error("Shared memo verification failed");
  console.log(JSON.stringify({ success: true, transport: "installed-stdio", memoId: memo.id, revision: reread.revision, checks: ["initialize", "tools/list", "account", "create", "idempotent-retry", "revision-update", "read-back"] }));
} finally {
  for (const target of waiting.values()) clearTimeout(target.timer);
  child.stdin.end(); setTimeout(() => child.kill(), 3000).unref();
}
