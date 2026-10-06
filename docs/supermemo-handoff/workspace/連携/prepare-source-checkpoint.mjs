import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, sep } from "node:path";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, lstatSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(workspace, "research", "edgeever");
const destination = join(workspace, ".tools", "checkpoints", new Date().toISOString().replace(/[:.]/g, "-"));
function git(args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Git checkpoint command failed: ${args[0]}`);
  return result.stdout;
}
const commit = git(["rev-parse", "HEAD"]).trim();
const branch = git(["branch", "--show-current"]).trim();
const patch = git(["diff", "--binary", "HEAD"]);
const additions = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
// Store source changes only; runtime state, credentials and private memo backups
// are intentionally outside this checkpoint. No changes are made to the repo.
for (const path of additions) {
  if (/(^|\/)(\.env(?:\.[^/]*)?|secrets|backups|node_modules|\.wrangler)(\/|$)/i.test(path)) throw new Error("Private/runtime file in source checkpoint");
  const source = resolve(repository, path);
  if (!source.startsWith(repository + sep) || !lstatSync(source).isFile()) throw new Error("Invalid source checkpoint path");
}
mkdirSync(destination, { recursive: true });
writeFileSync(join(destination, "changes.patch"), patch);
const files = [];
for (const path of additions) {
  const target = join(destination, "new-files", path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(repository, path), target);
  files.push({ path, sha256: createHash("sha256").update(readFileSync(target)).digest("hex") });
}
const workspaceFiles = [];
function preserveWorkspaceFile(path) {
  const source = join(workspace, path);
  if (!lstatSync(source).isFile()) throw new Error("Invalid workspace source file");
  const target = join(destination, "workspace-files", path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  workspaceFiles.push({ path, sha256: createHash("sha256").update(readFileSync(target)).digest("hex") });
}
function preserveDirectory(path) {
  for (const entry of readdirSync(join(workspace, path), { withFileTypes: true })) {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) preserveDirectory(relative);
    else if (entry.isFile() && /\.(?:mjs|ts|md|ya?ml)$/.test(entry.name)) preserveWorkspaceFile(relative);
  }
}
for (const directory of ["連携", "skills"]) preserveDirectory(directory);
for (const entry of readdirSync(workspace, { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:cmd|txt)$/.test(entry.name)) preserveWorkspaceFile(entry.name);
}
const metadata = { version: 1, createdAt: new Date().toISOString(), commit, branch, patchSha256: createHash("sha256").update(patch).digest("hex"), files, workspaceFiles };
writeFileSync(join(destination, "manifest.json"), JSON.stringify(metadata, null, 2));
writeFileSync(join(destination, "RESTORE.txt"), "Restore into a separate checkout at the manifest commit. Apply changes.patch with git apply, then copy new-files preserving relative paths. workspace-files contains integration scripts, skill source and work notes for the workspace root. Do not overwrite the working checkout or memo database. Credentials, global Codex configuration and memo data are not included.\n");
console.log(JSON.stringify({ success: true, destination, commit, branch, newFiles: files.length, workspaceFiles: workspaceFiles.length, patchBytes: Buffer.byteLength(patch) }));
