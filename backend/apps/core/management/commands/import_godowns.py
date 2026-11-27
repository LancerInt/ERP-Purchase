"""Import the real Warehouse + Godown master from a godowns.xlsx export.

Each row carries a unique Godown Code, Name, Company, Warehouse and storage
condition. We create/update the 2 companies' Warehouses (NKP-UAI, TVP-SS,
SLP YARD/PLANT, TVP-UAI) and the 19 Godowns, keyed by their codes so the
import is idempotent (re-running updates in place, never duplicates).

Usage:
    python manage.py import_godowns --file "C:\\path\\godowns.xlsx"
    python manage.py import_godowns            # defaults to Downloads/godowns.xlsx
"""
import os
from decimal import Decimal, InvalidOperation

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import Company, Warehouse, Godown

# Legal-name (as it appears in the sheet) -> the Company already seeded here.
COMPANY_ALIASES = {
    'SS BIOCHEM INDIA PVT LTD': ['biochem'],
    'UNITED AGRO INDUSTRIES': ['united agro', 'uai'],
}


def _dec(v):
    try:
        return Decimal(str(v or '0'))
    except (InvalidOperation, TypeError):
        return Decimal('0')


class Command(BaseCommand):
    help = "Import Warehouses + Godowns (with their codes) from godowns.xlsx."

    def add_arguments(self, parser):
        parser.add_argument('--file', default=os.path.expanduser('~/Downloads/godowns.xlsx'))
        parser.add_argument('--dry-run', action='store_true', help='Show what would change, write nothing.')

    def _company_for(self, sheet_name):
        """Match a sheet company name to a seeded Company by alias."""
        key = (sheet_name or '').strip().lower()
        for legal, aliases in COMPANY_ALIASES.items():
            if legal.lower() == key or any(a in key for a in aliases):
                for c in Company.objects.all():
                    blob = f"{c.legal_name} {c.trade_name} {c.company_code}".lower()
                    if any(a in blob for a in aliases):
                        return c
        return None

    @transaction.atomic
    def handle(self, *args, **opts):
        try:
            import openpyxl
        except ImportError:
            raise CommandError("openpyxl is required (pip install openpyxl).")

        path = opts['file']
        if not os.path.exists(path):
            raise CommandError(f"File not found: {path}")
        dry = opts['dry_run']

        wb = openpyxl.load_workbook(path)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        header = [str(h or '').strip().lower() for h in rows[0]]

        def col(name):
            for i, h in enumerate(header):
                if name in h:
                    return i
            return None

        c_code, c_name, c_comp = col('godown code'), col('godown name'), col('company')
        c_wh, c_cond, c_cap, c_capuom = col('warehouse'), col('storage'), col('capacity'), col('capacity uom')
        if None in (c_code, c_name, c_comp, c_wh):
            raise CommandError(f"Missing expected columns. Found header: {header}")

        wh_created = wh_updated = g_created = g_updated = skipped = 0
        wh_cache = {}

        for r in rows[1:]:
            if not r or not r[c_code]:
                continue
            gcode = str(r[c_code]).strip()
            gname = str(r[c_name] or '').replace('\ufffd', '-').strip()
            comp = self._company_for(r[c_comp])
            whcode = str(r[c_wh] or '').strip()
            if not comp or not whcode:
                self.stdout.write(self.style.WARNING(f"  skip {gcode}: company/warehouse unresolved ({r[c_comp]} / {whcode})"))
                skipped += 1
                continue

            # ── Warehouse (unique per company+code) ──
            wkey = (comp.id, whcode)
            wh = wh_cache.get(wkey)
            if wh is None:
                wh = Warehouse.objects.filter(company=comp, warehouse_code=whcode).first()
                if wh is None:
                    if not dry:
                        wh = Warehouse.objects.create(company=comp, warehouse_code=whcode, name=whcode)
                    wh_created += 1
                    self.stdout.write(f"  + Warehouse {whcode} ({comp.company_code})")
                wh_cache[wkey] = wh

            # ── Godown (unique per warehouse+code) ──
            cond = (str(r[c_cond] or 'AMBIENT').strip().upper() if c_cond is not None else 'AMBIENT')
            g = Godown.objects.filter(warehouse=wh, godown_code=gcode).first() if wh else None
            fields = dict(
                godown_name=gname,
                storage_condition=cond if cond in ('AMBIENT', 'COLD', 'FROZEN') else 'AMBIENT',
                capacity_value=_dec(r[c_cap]) if c_cap is not None else Decimal('0'),
                capacity_uom=(str(r[c_capuom]).strip() if c_capuom is not None and r[c_capuom] else 'UNIT'),
            )
            if g:
                if not dry:
                    for k, v in fields.items():
                        setattr(g, k, v)
                    g.save(update_fields=list(fields.keys()))
                g_updated += 1
            else:
                if not dry and wh:
                    Godown.objects.create(warehouse=wh, godown_code=gcode, **fields)
                g_created += 1
                self.stdout.write(f"  + Godown {gcode} — {gname} ({whcode})")

        if dry:
            transaction.set_rollback(True)
        self.stdout.write(self.style.SUCCESS(
            f"\n{'DRY-RUN ' if dry else ''}Done: warehouses +{wh_created}/~{wh_updated}, "
            f"godowns +{g_created}/~{g_updated}, skipped {skipped}."
        ))
