import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createSelfHostedStorageAdapter } from "../research/edgeever/apps/api/src/self-hosted-storage-adapter";
import { verifyLogin, getInstanceAuthMode } from "../research/edgeever/apps/api/src/auth-service";
import { ensureUserWorkspace } from "../research/edgeever/apps/api/src/workspace-provisioning";
import { getMemoDetail } from "../research/edgeever/apps/api/src/memo-service";
import type { Bindings } from "../research/edgeever/apps/api/src/api-context";

// This is a private, offline rehearsal, never an import or deployment command.
// The copied DB may contain other private settings; do not upload it.
const source = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Provide a verified backup directory");
const exported = JSON.parse(readFileSync(join(source, "memos.json"), "utf8"));
const destination = resolve("backups", `account-rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(destination, { recursive: true });
copyFileSync(join(source, "database.sqlite"), join(destination, "database.sqlite"));
writeFileSync(join(destination, "PRIVATE-REHEARSAL.txt"), "Offline account-reset rehearsal only. Contains private memo data and potentially private configuration. Not a cloud migration package. Never upload or replace the canonical database with this copy.\n");
const db = new Database(join(destination, "database.sqlite"));
try {
  db.exec("PRAGMA foreign_keys = ON");
  const workspaces = db.query("SELECT DISTINCT workspace_id FROM memos").all() as { workspace_id: string }[];
  if (workspaces.length !== 1 || workspaces[0].workspace_id !== "ws_default") throw new Error("Rehearsal supports only the verified single personal workspace");
  db.transaction(() => {
    db.exec("DELETE FROM sessions; DELETE FROM api_tokens; DELETE FROM workspace_members; DELETE FROM users; DELETE FROM auth_login_attempts;");
  })();
  const storage = createSelfHostedStorageAdapter(db, join(source, "resources"));
  const password = randomBytes(32).toString("base64url");
  const env = { storage, EDGE_EVER_AUTH_USERNAME: "admin", EDGE_EVER_AUTH_PASSWORD: password } as Bindings;
  if (await getInstanceAuthMode(env, true) !== "required") throw new Error("Authentication did not fail closed");
  if (await verifyLogin(env, "admin", "incorrect-rehearsal-password")) throw new Error("Wrong password was accepted");
  const user = await verifyLogin(env, "admin", password);
  if (!user) throw new Error("Administrator bootstrap failed");
  const workspace = await ensureUserWorkspace(storage.db, user.id, user.username);
  if (workspace.workspaceId !== "ws_default" || workspace.role !== "owner") throw new Error("Administrator claimed a different workspace");
  for (const expected of exported.memos) {
    const actual = await getMemoDetail(storage.db, workspace.workspaceId, expected.id, true);
    if (!actual || actual.id !== expected.id || actual.contentText !== expected.contentText || actual.contentMarkdown !== expected.contentMarkdown || actual.revision !== expected.revision || actual.isDeleted !== expected.isDeleted || JSON.stringify(actual.tags) !== JSON.stringify(expected.tags)) throw new Error("Memo identity/content/revision/state changed during account rehearsal");
  }
  const imageManifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  for (const image of imageManifest.resources) {
    const object = await storage.resources.get(image.key);
    if (!object) throw new Error("Image reference missing after account rehearsal");
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (bytes.byteLength !== image.bytes || createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw new Error("Image integrity failed after account rehearsal");
  }
  for (const table of ["sessions", "api_tokens"]) {
    if ((db.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count !== 0) throw new Error("Local authentication state remained");
  }
  if (db.query("PRAGMA foreign_key_check").all().length !== 0) throw new Error("Foreign-key consistency failed");
  if (Object.values(db.query("PRAGMA integrity_check").get() as Record<string, string>)[0] !== "ok") throw new Error("Database integrity failed");
  const result = { success: true, destination, scope: "private-offline-rehearsal", workspace: workspace.workspaceId, memos: exported.memos.length, images: imageManifest.resources.length, checks: ["fail-closed authentication", "wrong-password rejection", "new administrator bootstrap", "same canonical workspace", "all IDs/body/revisions/tags/trash preserved", "image references and SHA256", "no local sessions or API tokens", "foreign keys", "database integrity"] };
  writeFileSync(join(destination, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { db.close(); }
