import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(workspace, "research", "edgeever");
const bun = join(workspace, ".tools", "bun", "bun-windows-x64", "bun.exe");
const accountId = "5c474db622324e9c0cce5c6fb8257e44";
function wrangler(args) {
  const result = spawnSync(bun, ["scripts/run-wrangler.mjs", ...args], {
    cwd: repository, encoding: "utf8", timeout: 45000, windowsHide: true,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}
const auth = wrangler(["whoami"]);
const authenticated = auth.ok && /You are logged in/.test(auth.output) && auth.output.includes(accountId);
let database = null;
let databaseRead = false;
let r2 = "not_checked";
if (authenticated) {
  const list = wrangler(["d1", "list", "--json"]);
  if (list.ok) {
    try {
      const entries = JSON.parse(list.output.trim());
      const found = entries.find((entry) => entry.name === "edgeever");
      databaseRead = true;
      if (found) database = { id: found.uuid, name: found.name, tables: found.num_tables, bytes: found.file_size };
    } catch { /* Report unreadable output instead of claiming readiness. */ }
  }
  const bucket = wrangler(["r2", "bucket", "list"]);
  r2 = /Please enable R2|10042/.test(bucket.output) ? "subscription_required"
    : bucket.ok ? /edgeever-resources/.test(bucket.output) ? "bucket_found" : "bucket_missing"
    : "unavailable";
}
const result = {
  checkedAt: new Date().toISOString(), accountId, authenticated, databaseRead, database, r2,
  deploymentReady: authenticated && database !== null && r2 === "bucket_found",
  note: "Read-only infrastructure check. GitHub Fork, runtime authentication Secret and application verification are still required before publication.",
};
mkdirSync(join(workspace, ".tools"), { recursive: true });
writeFileSync(join(workspace, ".tools", "cloud-readiness.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = authenticated && databaseRead ? 0 : 1;
