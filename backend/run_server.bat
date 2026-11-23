@echo off
REM Run the standalone backend on port 8200.
REM First time only: run setup.bat to create the venv + migrate + seed admin.
cd /d "%~dp0"
if exist env\Scripts\python.exe (
    set PY=env\Scripts\python.exe
) else (
    set PY=python
)
set DJANGO_SETTINGS_MODULE=config.settings
"%PY%" manage.py runserver 127.0.0.1:8200
