@echo off
REM Run the standalone frontend dev server (http://localhost:5273).
REM Proxies /api and /media to the backend on http://localhost:8200.
REM First time only: run  npm install  in this folder.
cd /d "%~dp0"
if not exist node_modules (
    echo === Installing frontend dependencies (first run) ===
    call npm install --no-audit --no-fund
)
call npm run dev
