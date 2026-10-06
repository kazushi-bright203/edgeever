import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const credential = join(root, ".tools/secrets/supermemo-token.dpapi");
const decrypted = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$env:PSModulePath=Join-Path $PSHOME 'Modules'; $s=(Get-Content -LiteralPath $env:SUPERMEMO_CREDENTIAL -Raw).Trim() | ConvertTo-SecureString; try {[Console]::Out.Write([System.Net.NetworkCredential]::new('', $s).Password)} finally {$s.Dispose()}"], { windowsHide: true, encoding: "utf8", env: { ...process.env, SUPERMEMO_CREDENTIAL: credential } });
if (decrypted.status !== 0 || !decrypted.stdout.trim()) {
  console.error("Supermemo credential could not be unlocked for this Windows account.");
  process.exit(1);
}
const child = spawn(join(root, ".tools/bun/bun-windows-x64/bun.exe"), [join(root, "research/edgeever/scripts/edgeever-mcp-stdio.mjs")], {
  windowsHide: true, stdio: "inherit", env: { ...process.env, EDGEEVER_TOKEN: decrypted.stdout.trim(), EDGEEVER_URL: "http://127.0.0.1:8787" },
});
decrypted.stdout = "";
child.on("error", () => { console.error("Supermemo adapter could not start."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
