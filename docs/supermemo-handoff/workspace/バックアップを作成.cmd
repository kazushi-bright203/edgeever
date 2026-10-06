@echo off
setlocal
cd /d "%~dp0research\edgeever"
set "PATH=%~dp0.tools\bun\bun-windows-x64;%PATH%"
bun scripts/supermemo-backup.ts
pause
