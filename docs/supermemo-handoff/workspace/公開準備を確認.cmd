@echo off
chcp 65001 >nul
cd /d "%~dp0"
"C:\Users\kazuk\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "連携\check-cloud-readiness.mjs"
pause
