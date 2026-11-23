# ERP Master — Standalone

A self-contained carve-out of the Lancer ERP, limited to:

- **Login / Auth** — JWT (access + refresh), logout, logout-all, two-factor (MFA/TOTP)
- **Master** — Companies, Warehouses, Godowns, Vendors, Customers, Products,
  Transporters, Taxes, Price Lists, Brokers, and the other master registers
- **Users & Roles (RBAC)** — users, roles, permissions, per-module access
- **Staff** — the HR Staff page (Staff records + bank account + ID proofs)

It runs on its **own fresh SQLite database**, independent of the main ERP repos.
It is a decoupled snapshot — it does **not** receive ERP updates.

---

## Quick start

### 1. Backend (http://localhost:8200)
```
cd backend
setup.bat          REM first time only: venv + deps + DB + seed admin
run_server.bat     REM every time
```
Login: **admin / Admin@123**

### 2. Frontend (http://localhost:5273)
```
cd frontend
run_frontend.bat   REM installs deps on first run, then starts Vite
```
Open http://localhost:5273 and sign in with the admin credentials.
The frontend proxies `/api` and `/media` to the backend on port 8200.

---

## What's included vs. omitted

**Included (fully working):**
- JWT login + refresh + logout + MFA
- Master CRUD (vendors, products, companies, warehouses, godowns, transporters,
  customers, taxes, etc.) with validation
- RBAC: roles, permissions, module access, user management
- Staff page (create/edit staff, bank account, ID proofs)

**Intentionally omitted:**
- Purchase and Sales modules (and their Tally/Zoho sync, reconcile commands)
- HR attendance, payroll, leave, shifts (only the Staff entity is kept;
  the `shift_assignment` link was dropped)
- Inventory, Finance, Production, Quality, Bank, Communications, etc.
- Frontend nav still lists other modules, but their pages have no backend here.

---

## Structure
```
ERP-MASTER-STANDALONE/
  backend/
    apps/          common, core, master, rbac, mfa, hr (Staff-only, trimmed)
    config/        settings.py, urls.py, wsgi.py  (single settings module)
    manage.py, requirements.txt, setup.bat, run_server.bat
  frontend/        Vite + React (full UI; API proxied to :8200)
```

## Invoice Scan Inbox (OCR) — needs an API key
The **Purchase › Scan Inbox** page reads vendor invoices (PDF/photo) with AI and
turns them into bills. To enable it:
1. Get a free Gemini key at https://aistudio.google.com/apikey
2. Copy `backend/.env.example` to `backend/.env`
3. Put your key in it:  `GEMINI_API_KEY=your-key-here`
4. Restart the backend.

Without a key the page loads and uploads files, but cannot extract invoice data.

## Notes
- Backend DB: `backend/db.sqlite3` (created by `setup.bat`). Delete it and
  re-run `migrate` + `setup_admin` to reset.
- To use Postgres instead, set `DB_ENGINE=postgresql` (+ `DB_*` vars) before
  running — see `config/settings.py`.
- The `hr` app here is a trimmed rewrite: `Staff`, `StaffBankAccount`,
  `StaffIDProof` only. The full ERP hr app (attendance/payroll/leave) is not
  carried over.
