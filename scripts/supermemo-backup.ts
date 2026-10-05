import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createSelfHostedStorageAdapter } from "../apps/api/src/self-hosted-storage-adapter";
import { getMemoDetail } from "../apps/api/src/memo-service";

// Snapshot SQLite with its WAL through SQLite's own serialization API. Never
// copy a live database file alone, and never replace the live store on restore.
const state = resolve(".wrangler/state/v3");
const directory = resolve("../../backups", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(directory, { recursive: true });
function findDatabase(folder: string, table: string) {
  for (const name of readdirSync(folder).filter((name) => name.endsWith(".sqlite"))) {
    const db = new Database(join(folder, name), { readonly: true });
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return db;
    db.close();
  }
  throw new Error(`Database not found: ${table}`);
}
const live = findDatabase(join(state, "d1/miniflare-D1DatabaseObject"), "memos");
try { writeFileSync(join(directory, "database.sqlite"), live.serialize()); } finally { live.close(); }
const restored = new Database(join(directory, "database.sqlite"));
const resourceRoot = join(directory, "resources");
const storage = createSelfHostedStorageAdapter(restored, resourceRoot);
const images = restored.query("SELECT object_key, byte_size, sha256 FROM resources").all() as { object_key: string; byte_size: number; sha256: string | null }[];
const objects = findDatabase(join(state, "r2/miniflare-R2BucketObject"), "_mf_objects");
const manifest: { key: string; bytes: number; sha256: string }[] = [];
try {
  for (const image of images) {
    const object = objects.query("SELECT blob_id FROM _mf_objects WHERE key = ?").get(image.object_key) as { blob_id: string } | null;
    // Deleted objects need not exist; preserve every object still present.
    if (!object) {
      const active = restored.query("SELECT 1 FROM resources WHERE object_key = ? AND is_deleted = 0").get(image.object_key);
      if (active) throw new Error("An active resource is missing from object storage");
      continue;
    }
    const target = resolve(resourceRoot, image.object_key);
    if (!target.startsWith(resolve(resourceRoot) + sep)) throw new Error("Unsafe object key");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(state, "r2/edgeever-resources-preview/blobs", object.blob_id), target);
    const blob = await storage.resources.get(image.object_key);
    if (!blob) throw new Error("Restored image is missing");
    const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== image.byte_size || (image.sha256 && digest !== image.sha256)) throw new Error("Restored image failed integrity check");
    manifest.push({ key: image.object_key, bytes: bytes.byteLength, sha256: digest });
  }
  const integrity = restored.query("PRAGMA integrity_check").get() as Record<string, string>;
  if (Object.values(integrity)[0] !== "ok") throw new Error("Restored database failed integrity check");
  const rows = restored.query("SELECT id, workspace_id FROM memos").all() as { id: string; workspace_id: string }[];
  const exported = [];
  for (const row of rows) {
    const memo = await getMemoDetail(storage.db, row.workspace_id, row.id, true);
    if (!memo || memo.id !== row.id) throw new Error("Restored memo failed canonical ID check");
    exported.push(memo);
  }
  writeFileSync(join(directory, "memos.json"), JSON.stringify({ version: 1, memos: exported }, null, 2));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version: 1, verifiedAt: new Date().toISOString(), memoCount: rows.length, resourceCount: manifest.length, resources: manifest, sensitiveDatabase: true }, null, 2));
  console.log(JSON.stringify({ success: true, directory, memos: rows.length, resources: manifest.length, checks: ["SQLite snapshot", "database integrity", "canonical memo IDs", "restored object bytes", "image SHA256", "JSON export"] }));
} finally { objects.close(); restored.close(); }
