# Purchase Module — Developer Handover Document

> **Audience:** New developer taking over the Purchase module.
> **Last updated:** 2026-06-01
> **Tech stack:** Django 4.2 / DRF + React (Vite) + PostgreSQL + Redis + Celery

---

## 1. Module Overview

The Purchase module is the **largest** module in this ERP and covers the full procure-to-pay (P2P) lifecycle:

```
Purchase Request (PR)
   ↓
Request for Quotation (RFQ)
   ↓
Quote Response (from vendor)
   ↓
Quote Evaluation
   ↓
Purchase Order (PO)
   ↓
Receipt Advice (goods inwards)
   ↓
Vendor Bill (invoice booking)
   ↓
Payment Made (settlement)
```

Side flows:
- **Inward Freight** — transporter advice + freight payment
- **Material Rejection** — return-to-vendor
- **Vendor Credit Note** — credit memo from vendor
- **Wage Entries & Wage Payments** — loading/unloading labor
- **Packing Materials** — routed separately from goods receipts

---

## 2. Tech Stack & Project Layout

### Backend
- **Django 4.2** + **Django REST Framework**
- **PostgreSQL 16** (production), SQLite OK for dev
- **Redis 7** — cache + Celery broker
- **Celery 5.3** — async tasks (PO overdue, QC reminders, payment due alerts)
- **Gemini API** — OCR extraction for vendor docs

### Frontend
- **React 18 + Vite** (NOT Next.js — the QUICK_START.md is stale on this)
- **react-router-dom** v6
- **react-hot-toast** for notifications
- **TailwindCSS** for styling
- Custom hook `usePermissions` (per-token cached RBAC)

### Project Tree (top-level)

```
ERP-APPLICATION/
├── backend/
│   ├── apps/
│   │   ├── purchase/          ← THIS MODULE
│   │   ├── master/            (Products, Vendors, Customers)
│   │   ├── rbac/              (Roles, Permissions)
│   │   ├── hr/                (Staff, Departments)
│   │   ├── core/              (Companies, Warehouses, Godowns)
│   │   ├── communications/    (Email, RFQ send-out)
│   │   ├── sales/
│   │   └── accounts/
│   └── config/                (settings, celery)
├── frontend/
│   └── src/
│       └── pages/
│           ├── purchase/      ← THIS MODULE (frontend)
│           ├── masters/
│           ├── admin/
│           └── hr/
├── docker-compose.yml         (dev)
├── docker-compose.prod.yml
├── Makefile
└── render.yaml                (Render.com deploy config)
```

### Purchase Backend Files

```
backend/apps/purchase/
├── models.py                   ~3,400 lines — 35+ models
├── serializers.py              ~4,000+ lines — DRF serializers + nested
├── views.py                    ~5,000+ lines — ModelViewSets + @action endpoints
├── services.py                 cross-model business logic (PR→PO, Quote→PO)
├── selectors.py                read-side query helpers
├── permissions.py              custom DRF permission classes
├── field_permissions.py        per-field RBAC
├── freight_field_permissions.py
├── vendor_aggregation.py       vendor-product rollups for RFQ
├── quote_gemini_extractor.py   OCR for vendor quotes
├── quote_parser.py             non-AI fallback parser
├── receipt_gemini_extractor.py OCR for vendor delivery challans
├── weighment_gemini_extractor.py OCR for weighment slips
├── signals.py                  post_save hooks
├── tasks.py                    Celery tasks
├── admin.py                    Django admin
├── apps.py
├── urls.py                     DRF router registration
└── migrations/                 0001 → 0066 (latest)
```

### Purchase Frontend Pages

```
frontend/src/pages/purchase/
├── requests/                   PR — list, [id], new
├── rfq/                        RFQ — list, [id], new, send-email
├── quotes/                     Quote — list, [id], new
├── evaluations/                Quote evaluation dashboards
├── orders/                     PO — list, [id], new
├── receipts/                   Receipt Advice — list, [id], new
├── bills/                      Vendor Bills — list, [id], new
├── payments-made/              Payments — list, [id], new
├── payments/                   (legacy payment advice)
├── freight/                    Inward Freight — list, [id], new
├── vendor-credits/             Credit notes — list, [id], new
├── vendor-dues/                Aging report
├── rejections/                 Material rejection — list, [id], new
├── extract/                    OCR file upload landing
├── lifecycle/                  Lifecycle visualization
└── components/                 shared form components
```

---

## 3. Local Setup (Step-by-Step)

### Prerequisites
- Python 3.12
- Node 20 (npm 10)
- PostgreSQL 16 (or SQLite for quick start)
- Redis 7 (only needed if you want to test Celery/cache)

### A. Backend Setup

```powershell
# from project root
cd ERP-APPLICATION/backend

# create venv
python -m venv venv
./venv/Scripts/Activate.ps1

# install deps
pip install -r requirements.txt

# environment file
copy .env.example .env
# edit .env — at minimum set DJANGO_SECRET_KEY and DATABASE_URL

# migrations
python manage.py migrate

# seed initial data (creates default company, RBAC roles, etc.)
python manage.py seed_initial_data    # check Makefile for exact command

# superuser
python manage.py createsuperuser

# run dev server
python manage.py runserver
```

Backend will be at: **http://localhost:8000**
Admin: **http://localhost:8000/admin/**
API docs: **http://localhost:8000/api/docs/**

### B. Frontend Setup

```powershell
cd ERP-APPLICATION/frontend

npm install

# environment file
copy .env.example .env
# edit .env — set VITE_API_URL=http://localhost:8000

npm run dev
```

Frontend will be at: **http://localhost:5173** (Vite default) or **http://localhost:3000**.

### C. Docker (alternative — one-shot)

```bash
make setup    # builds, starts, migrates, seeds
make dev      # start
make dev-logs # tail logs
```

### Default Credentials (after seed)
```
Username: admin
Password: admin123
```
Change immediately.

---

## 4. Core Data Model

### Entity Map (high level)

```
PurchaseRequest ──< PRLine
       │
       └──> RFQHeader ──< RFQVendor (M2M to Vendor)
                  │
                  └──> QuoteResponse ──< QuoteLine
                              │
                              └──> QuoteEvaluation ──< ComparisonEntry
                                          │
                                          └──> PurchaseOrder ──< POLine
                                                       │
                                                       ├──> ReceiptAdvice ──< ReceiptLine
                                                       │            │
                                                       │            └──< PackingMaterialLine
                                                       │            │
                                                       │            └──< WeighmentDetail
                                                       │
                                                       └──> VendorBill ──< VendorBillLine
                                                                  │
                                                                  └──> PaymentMade

ReceiptAdvice ──> FreightAdviceInbound ──> FreightPaymentInbound
                          │
                          └──< LoadingUnloadingWage  (→ WageEntry → WagePayment)

ReceiptAdvice ──> MaterialRejection ──< MaterialRejectionLine

VendorBill ──> VendorCredit ──< VendorCreditLine
```

### Key Models (in `models.py`)

| Model | Purpose | Notable Fields |
|---|---|---|
| `PurchaseRequest` | Demand from internal user | status, requirement_type, warehouse, allow_rfq_skip |
| `PRLine` | One product per PR | product_service / machinery / service_catalogue (polymorphic), category |
| `RFQHeader` | Quote invitation | linked PRs (M2M), vendors (M2M), due_date |
| `QuoteResponse` | Vendor's reply | vendor FK, quote_status, gst_percentage |
| `QuoteLine` | One product on a quote | rate, quantity, dimensions (L/B/W/H — migration 0063) |
| `QuoteEvaluation` | Comparison + selection | selected_vendor, status |
| `PurchaseOrder` | Confirmed buy | vendor, po_number, status |
| `POLine` | One item on PO | **category** (migration 0065) — RAW/PACKING/FINISHED |
| `ReceiptAdvice` | Goods inward record | invoice_no, invoice_date, status |
| `ReceiptLine` | Goods row on receipt | dimensions (L/B/W/Weight — migration 0064) |
| `PackingMaterialLine` | Packing items separately | po_line FK, dimensions (migration 0066) |
| `VendorBill` | Booked vendor invoice | vendor_invoice_no, bill_date |
| `PaymentMade` | Cash going out | bill FK, payment_method, amount |
| `FreightAdviceInbound` | Transporter advice | transporter FK (nullable) |
| `MaterialRejection` | Return to vendor | rejection_reason |
| `VendorCredit` | Vendor credit note | linked bill |

### Three-FK Polymorphic Line Pattern

PR/PO/Quote/Bill lines reference items via **one of three** FKs:

```python
product_service     = FK(ProductService, null=True)   # Goods/Service
machinery           = FK(Machinery, null=True)        # Equipment line
service_catalogue   = FK(ServiceCatalogue, null=True) # Service rate card
```

Exactly one is non-null per line. Migrations 0053–0058 added the M&SC columns.

---

## 5. API Surface

All endpoints under `/api/purchase/`. Router-generated CRUD for each viewset plus custom actions.

### URL Map (from `urls.py`)

| Path | ViewSet |
|---|---|
| `/api/purchase/purchase-requests/` | PurchaseRequestViewSet |
| `/api/purchase/rfqs/` | RFQHeaderViewSet |
| `/api/purchase/quotes/` | QuoteResponseViewSet |
| `/api/purchase/evaluations/` | QuoteEvaluationViewSet |
| `/api/purchase/purchase-orders/` | PurchaseOrderViewSet |
| `/api/purchase/receipts/` | ReceiptAdviceViewSet |
| `/api/purchase/payment-advices/` | VendorPaymentAdviceViewSet |
| `/api/purchase/bills/` | VendorBillViewSet |
| `/api/purchase/payments-made/` | PaymentMadeViewSet |
| `/api/purchase/vendor-credits/` | VendorCreditViewSet |
| `/api/purchase/freight/` | FreightAdviceInboundViewSet |
| `/api/purchase/freight-payments/` | FreightPaymentInboundViewSet |
| `/api/purchase/wage-entries/` | WageEntryViewSet |
| `/api/purchase/wage-payments/` | WagePaymentViewSet |
| `/api/purchase/rejections/` | MaterialRejectionViewSet |
| `/api/purchase/evaluation-dashboard/` | EvaluationDashboardView |
| `/api/purchase/evaluation-dashboard/submit/` | EvaluationDashboardSubmitView |

### Common Custom Actions

**PR ViewSet**
- `POST /pending_for_warehouse/`
- `POST /{id}/add-line/`
- `PATCH /{id}/update-line/{line_id}/`
- `DELETE /{id}/remove-line/{line_id}/`
- `POST /{id}/proceed-to-approve/`
- `POST /{id}/approve/`
- `POST /{id}/reject/`
- `GET /{id}/skip-rfq-po-data/`
- `GET /{id}/preferred-vendors/`
- `POST /{id}/skip-rfq-create-po/`

**RFQ ViewSet**
- `GET /summary/`
- `GET /open_rfqs/`
- `GET /{id}/products/`
- `GET /pending_evaluation/`
- `GET /{id}/vendors/`
- `POST /{id}/close/`

**Quote ViewSet**
- `GET /for_rfq/`
- `POST /{id}/add-line/`
- `DELETE /{id}/remove-line/{line_id}/`
- `POST /{id}/approve/`

**PO ViewSet**
- `GET /pending/`
- `GET /open_pos_for_vendor/`
- `GET /overdue/`
- `POST /{id}/approve/`
- `POST /{id}/add-line/`

**Receipt ViewSet**
- `POST /{id}/approve/` — allows EITHER receipt_lines OR packing_materials non-empty
- `POST /{id}/reject/`
- OCR endpoints for invoice/delivery-challan extraction

---

## 6. Key Business Flows

### Flow A: Full P2P Cycle

```
1. User raises PR        → status DRAFT → APPROVED
2. Buyer creates RFQ     → links PR(s), invites vendors → SENT
3. Vendor replies        → QuoteResponse with QuoteLines → SUBMITTED
4. Evaluation            → compares quotes → SELECT vendor → status APPROVED
5. PO auto-created       → from winning quote
6. Vendor delivers       → Receipt Advice booked → APPROVED
7. Vendor invoices       → VendorBill auto-fills from receipt → APPROVED
8. Treasury pays         → PaymentMade → PAID
```

### Flow B: Skip-RFQ (urgent / sole-source)

```
PR (allow_rfq_skip=True) → Configure-Skip-RFQ → Skip-RFQ-Create-PO → Receipt → Bill → Payment
```

### Flow C: Packing Materials (NEW — added today)

Packing material lines flow **end-to-end** but land in the **Packing Materials** subform, not Receipt Line Items:

```
PR (category=PACKING_MATERIAL)
   ↓
RFQ → Quote (preserves category)
   ↓
PO (POLine.category=PACKING_MATERIAL — migration 0065)
   ↓
Receipt → PackingMaterialLine (not ReceiptLine)
   ↓
Vendor Bill — auto-fill concatenates [goods, packing]
```

Resolution chain in `POLineSerializer.pr_line_category`:
1. PO override (explicit)
2. linked PR line
3. Quote line → PR line
4. RFQ chain match by item FK

Frontend enforcer in `receipts/new.jsx`: `useEffect` watches `receiptLines/poLines/productRaw` and **migrates** any packing-material row out of receiptLines.

### Flow D: Inward Freight

```
ReceiptAdvice
   ↓
FreightAdviceInbound (transporter, vehicle, freight_amount, billed_amount)
   ↓
LoadingUnloadingWage (optional — labor charges)
   ↓
FreightPaymentInbound (transporter payment)
```

Transporter field is now a **searchable text input + datalist** (not dropdown). On save: text matches a known transporter → store FK; no match → save `transporter=null` and stash text in `_transporterText`.

### Flow E: Vendor Credit (refund/return)

```
VendorBill → MaterialRejection → VendorCredit ──< VendorCreditLine
                                         │
                                         └─> offset future payments
```

---

## 7. RBAC / Permissions

### Permission Model
- `ERPRole` — role definition
- `ERPModule` — module/page (e.g. "Receipt Advice", "Inward Freight")
- `RolePermission` — grid: role × module × {can_view, can_create, can_edit, can_delete, can_approve, can_reject, can_email, can_export, can_print}
- DRF guard: `HasModulePermission`

### Key Rules (added/changed today)

1. **Implicit View** — if any mutate permission (`can_create`/`can_edit`/`can_delete`/`can_approve`/...) is true, View is auto-granted. See `rbac/permissions.py`.

2. **Button gating** — Receipt Advice's Approve / Delete buttons no longer use hardcoded roles. They check `canApprove('Receipt Advice')` / `canDelete('Receipt Advice')` from `usePermissions` hook.

3. **Module-name aliasing** — DB module name is `Freight Advice` but UI shows it as **Inward Freight**. See `frontend/src/pages/admin/permissions/purchase.jsx` → `MODULE_DISPLAY_NAMES`.

4. **Page vs Button tabs** — Permission grid splits permissions across two tabs:
   - Page (View / Create / Edit / Delete)
   - Button (Approve / Reject / Email / Export / Print)
   User Detail page shows the union of both — this is by design, not a bug.

### usePermissions Cache
- Cached **per-token** in browser memory.
- Backend permission changes do NOT propagate until **logout + login**.
- Document this to end-users when they ask "why is the button still showing?"

---

## 8. OCR / AI Extraction

Vendor documents (invoices, delivery challans, quotes, weighment slips) are parsed via **Gemini API**.

### Files
- `quote_gemini_extractor.py` — vendor quote PDFs
- `receipt_gemini_extractor.py` — delivery challan
- `weighment_gemini_extractor.py` — weighbridge slips
- `quote_parser.py` — non-AI regex fallback

### Known Quirks & Guards
- **GSTIN vs GST%** — prompt has disambiguation block; post-extraction clamp rejects `gst_percentage > 28` (no legal Indian GST rate exceeds 28).
- **Quantity range strings** — e.g. `"150 / 155 MT"` was concatenating to `150155`. Fixed by `_coerce_quantity()` which detects ranges and picks the first value.

### How to Re-run OCR
Upload via `/purchase/extract/` page or POST raw file to the relevant viewset's extraction action.

---

## 9. Frontend Architecture Notes

### Master Pattern for a Purchase Page
Each domain folder follows the same shape:

```
purchase/<entity>/
├── index.jsx     ← list view (filterable, paginated)
├── [id].jsx      ← detail / edit view
└── new.jsx       ← create form
```

### Shared Helpers
- `frontend/src/constants/uom.js` — `UOM_OPTIONS` / `UOM_VALUES`
- `frontend/src/hooks/usePermissions.js` — `canView/canCreate/canEdit/canDelete/canApprove/...`
- `frontend/src/lib/api.js` (or similar) — axios wrapper with auth token

### State Patterns
- Form data in `useState` objects keyed by entity (`formData`, `lines`, `packingLines`)
- Vendor / product dropdowns hydrated via separate `useEffect` calls
- Auto-fill from upstream record (PR → Quote, PO → Receipt) via dedicated handlers (`applyReceiptExtraction`, `packingLineToBillLine`)

### Save-payload Conventions
- Empty string Decimals → `null` before POST (recent vendor GST fix).
- Polymorphic FKs — set exactly one of `product_service / machinery / service_catalogue`, others remain `null`.

---

## 10. Testing

### A. Backend Unit Tests

```powershell
cd backend
python manage.py test apps.purchase            # all purchase tests
python manage.py test apps.purchase.tests.test_receipt   # specific module
```

Or via Make:
```bash
make test APP=purchase
make test-coverage
```

### B. Manual End-to-End Smoke Test (do this after any change)

| # | Step | Where | Expected |
|---|---|---|---|
| 1 | Create a Product in Master | `/masters/products/new` | Listed in Products |
| 2 | Create a PR with 2 lines (1 RAW + 1 PACKING) | `/purchase/requests/new` | Saved, status DRAFT |
| 3 | Approve the PR | detail page | status APPROVED |
| 4 | Create RFQ linked to PR, invite 2 vendors | `/purchase/rfq/new` | RFQ SENT |
| 5 | Send RFQ Email with CC | RFQ detail → Send | Email received by vendor + CC address |
| 6 | Submit a Quote Response for one vendor | `/purchase/quotes/new` | Quote SUBMITTED |
| 7 | Evaluate & approve quote | `/purchase/evaluations/...` | PO auto-created |
| 8 | Open the PO | `/purchase/orders/[id]` | RAW row shows blue pill, PACKING row shows amber pill |
| 9 | Create Receipt from PO | `/purchase/receipts/new` | RAW lands in Line Items, PACKING lands in Packing Materials subform |
| 10 | Approve Receipt | detail page | Approves even if only packing materials present |
| 11 | Create Bill from Receipt | `/purchase/bills/new` | Lines include BOTH goods + packing; vendor_invoice_no auto-fills |
| 12 | Record PaymentMade | `/purchase/payments-made/new` | Bill marked PAID |

### C. RBAC Sanity Tests

1. Create a fresh role, grant **only** `can_create` on Receipt Advice.
2. Login as user with that role.
3. Verify:
   - Receipt list page is accessible (implicit View rule).
   - New button shown.
   - Approve / Delete buttons HIDDEN on detail page.

### D. OCR Tests

| File type | Test for |
|---|---|
| GST invoice with GSTIN `33AABFU0310L1ZM` | `gst_percentage` is NOT 33 |
| Delivery challan with `"150 / 155 MT"` | parsed quantity is 150, not 150155 |
| Vendor quote PDF | gst_percentage ≤ 28 |

### E. Migrations

Always after pulling new code:
```powershell
python manage.py migrate purchase
```
The latest migration is `0066_expand_packingmaterialline.py`.

---

## 11. Recent Changes (last session — context for you)

| Area | Change |
|---|---|
| Packing material flow | PR→Quote→PO→Receipt→Bill all category-aware; lands in Packing Materials subform |
| Quotes / Receipts | Dimension columns L/B/W/Weight added (migrations 0063, 0064) |
| PO | `category` field added (migration 0065); colored pill UI |
| RFQ Email | CC/BCC now actually deliver (frontend was dropping them) |
| Vendor Bill | Auto-fill includes packing materials + vendor_invoice_no |
| HR | "Office" option in Primary Location; ensure-office endpoint |
| RBAC | Implicit View rule; Receipt Approve/Delete gated by RBAC grid; Inward Freight row added |
| OCR | GSTIN-vs-GST% guard; quantity range parser |
| Freight | Transporter = text+datalist; better error toasts |
| Vendor Form | Empty optional numeric fields stripped from payload to avoid DRF validation errors |

---

## 12. Common Gotchas (read this first when stuck)

1. **"My permission change isn't taking effect"** — logout/login required; `usePermissions` caches per-token.

2. **"Receipt approval fails for packing-only delivery"** — fixed; ensure backend has migrations through 0066 and view code allows `packing_materials.count() > 0`.

3. **"Bill line items empty after auto-fill"** — verify the receipt has either goods or packing rows; `packingLineToBillLine` helper must be present in `bills/new.jsx`.

4. **"GST: A valid number is required" on Vendor form** — empty optional numeric strings must be removed from payload (see `NUMERIC_OPTIONAL` array in `masters/vendor/new.jsx`).

5. **"CC isn't being sent on RFQ email"** — confirm frontend payload includes `custom_cc` / `custom_bcc` strings; the backend already supports them.

6. **"Freight detail page says 'not found'"** — improved toast surfaces actual HTTP status. 404 → record missing; 403 → no permission; 401 → session expired.

7. **"Inward Freight not showing in Permission grid"** — DB module name is `Freight Advice`. Confirm `MODULE_DISPLAY_NAMES` override is loaded.

8. **"Office option causes 500"** — warehouse_code must be ≤10 chars. Format is `OFC-{last4 of company_code}`.

9. **PR→PO category drop** — if PO line shows blank category after Quote→PO, check the 4-step resolver in `POLineSerializer.pr_line_category`.

10. **Polymorphic line null violations** — exactly ONE of `product_service / machinery / service_catalogue` must be set; the others MUST be null (not blank string).

---

## 13. Where to Find Things — Cheatsheet

| I want to... | Open this file |
|---|---|
| Add a new field to a model | `models.py` + `makemigrations purchase` |
| Add a new endpoint | `views.py` (add `@action`) + `urls.py` (router auto-discovers) |
| Change what's returned in API | `serializers.py` |
| Add cross-record business logic | `services.py` |
| Add background job | `tasks.py` (+ register in `config/celery.py`) |
| Tweak OCR extraction prompt | `quote_gemini_extractor.py` / `receipt_gemini_extractor.py` |
| Edit a UI page | `frontend/src/pages/purchase/<area>/[index|new|id].jsx` |
| Wire RBAC into a button | `usePermissions` hook + check `canApprove('Module Name')` |
| See/edit module list | Django admin → RBAC → Modules |
| Master Excel template | `backend/apps/master/management/commands/generate_master_template.py` |

---

## 14. Deployment

Deployed on **Render.com** with **two services**:
- **Backend** — Django + Gunicorn
- **Frontend** — Vite static build

Config: `render.yaml`, `render.staging.yaml`.

Branches:
- `main` — production
- `mohan` — staging (or per-developer)

Build hooks run `migrate` automatically on backend deploys.

**Local production-like:**
```bash
make prod-build
make prod
make migrate
make health-check
```

---

## 15. Documentation Links

- `ARCHITECTURE.md` — system architecture
- `DEPLOYMENT.md` — full deployment guide
- `RENDER_DEPLOYMENT.md` — Render specifics
- `backend/apps/purchase/IMPLEMENTATION_SUMMARY.md` — older implementation notes
- `backend/apps/purchase/QUICK_START.md` — Django-app quick start
- `backend/api_schema.yml` — OpenAPI/Swagger schema (generate with `make docs`)

---

## 16. First-Week Checklist for New Developer

- [ ] Clone repo, run `make setup` (or follow Section 3 manual setup)
- [ ] Log in as admin, change password
- [ ] Walk through Section 10.B smoke test end-to-end
- [ ] Read `models.py` for purchase (skim section headers — 35 models)
- [ ] Read `views.py` for one entity end-to-end (suggest: ReceiptAdviceViewSet)
- [ ] Open Django admin → RBAC → Modules; familiarize with module names
- [ ] Create a test role, login as test user, verify permissions work
- [ ] Run `python manage.py test apps.purchase`
- [ ] Skim `frontend/src/pages/purchase/receipts/new.jsx` — it's the most complex page
- [ ] Read Section 12 (Gotchas) before making changes

---

## 17. Support & Contact

- **Project owner email:** it@lancers.in
- **Branch policy:** never push to `main` without PR review
- **Commit policy:** small, atomic commits; clear messages
- **Never** skip pre-commit hooks (`--no-verify` forbidden)

Welcome to the project — when in doubt, smoke-test the full P2P cycle (Section 10.B). If that works, your change is probably safe.
