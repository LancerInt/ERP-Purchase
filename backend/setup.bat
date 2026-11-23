@echo off
REM One-time setup for the standalone backend:
REM   creates a virtualenv, installs deps, builds the SQLite DB, seeds admin.
cd /d "%~dp0"

echo === Creating virtual environment (env\) ===
python -m venv env
if errorlevel 1 goto :err

set PY=env\Scripts\python.exe
set DJANGO_SETTINGS_MODULE=config.settings

echo === Installing dependencies ===
"%PY%" -m pip install --upgrade pip
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 goto :err

echo === Applying migrations (fresh SQLite) ===
"%PY%" manage.py migrate
if errorlevel 1 goto :err

echo === Seeding admin user, company, warehouse, roles ===
"%PY%" manage.py setup_admin

echo === Seeding demo data (vendors, bills, payments, staff...) ===
"%PY%" manage.py seed_demo

echo.
echo === DONE ===
echo   Login:    admin / Admin@123
echo   Start the API with:  run_server.bat
echo   (Re-seed demo data anytime with:  manage.py seed_demo --wipe)
goto :eof

:err
echo.
echo SETUP FAILED - see the error above.
exit /b 1
