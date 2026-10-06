@echo off
set "PATH=%~dp0.tools\bun\bun-windows-x64;%PATH%"
cd /d "%~dp0research\edgeever"
bun run dev
pause
