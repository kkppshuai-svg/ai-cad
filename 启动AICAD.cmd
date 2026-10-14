@echo off
cd /d "%~dp0"
echo AICAD: http://127.0.0.1:3101
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:3101/api/status' -UseBasicParsing -TimeoutSec 5 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:3101"
  exit /b 0
)
node server.js
pause
