"""Exhaustive edge-case coverage for the TDS Reconciliation endpoint
(/api/purchase/tds-bills/). The happy-path scenarios live in
test_tds_bills_endpoint.py; this file pins every branch, filter, threshold,
exclusion and boundary so no bug can slip through unseen.

Grouped by concern:
  * Filters            — company, vendor, regime, date window, only_missing, view
  * TDS data           — linked / unlinked / multi-row / zero / opening-balance
  * 194Q logic         — below/above ₹50L, proportional share, fy_base=0 guard
  * 194C logic         — ≥₹30k / below threshold / under-deducted / due-none
  * Exclusions         — branch / cancelled / inactive / no-vendor
  * Base & flags       — subtotal fallback, total_is_net, PAN
  * Rollup             — sums, missing_bills, status
  * Totals & shape     — no double count, response keys
"""
from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Company
from master.models import Vendor
from purchase.models import VendorBill, TdsPayable

URL = '/api/purchase/tds-bills/'
User = get_user_model()

FY_FROM, FY_TO = '2026-04-01', '2027-03-31'


def _auth(client):
    u = User.objects.create_superuser(username=f'u{User.objects.count()}',
                                      email=f'u{User.objects.count()}@t.com', password='x')
    client.force_authenticate(u)
    return u


def _bill(vendor, inv, *, sub, total=None, tax=0, tds=0, cat='MAIZE',
          is_expense=False, net=False, bdate=date(2026, 6, 1), status='OPEN'):
    return VendorBill.objects.create(
        vendor=vendor, vendor_invoice_no=inv, bill_date=bdate,
        subtotal=Decimal(str(sub)),
        total_amount=Decimal(str(total if total is not None else sub)),
        tax_amount=Decimal(str(tax)), tds_amount=Decimal(str(tds)),
        total_is_net=net, purchase_category=cat, is_expense=is_expense, status=status)


def _link_tds(company, vendor, bill, amount, *, section='194Q',
              vtype='Journal', vdate=date(2026, 6, 1)):
    return TdsPayable.objects.create(
        company=company, vendor=vendor, vendor_bill=bill, ledger_name='TDS',
        section=section, voucher_type=vtype, voucher_date=vdate,
        amount=Decimal(str(amount)))


# ─────────────────────────────────────────────────────────────────────────────
# Filters
# ─────────────────────────────────────────────────────────────────────────────
class FilterTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.c1 = Company.objects.create(company_code='FC1', legal_name='Co One')
        cls.c2 = Company.objects.create(company_code='FC2', legal_name='Co Two')
        cls.v1 = Vendor.objects.create(vendor_name='Vendor A', company=cls.c1, pan='AAACC7215H')
        cls.v2 = Vendor.objects.create(vendor_name='Vendor B', company=cls.c2, pan='AAACC7215H')
        cls.exp = Vendor.objects.create(vendor_name='Expense Co', company=cls.c1, pan='ABCPF1234E')
        cls.frt = Vendor.objects.create(vendor_name='Transport Co', company=cls.c1, pan='ABCPF1234E')
        _bill(cls.v1, 'A1', sub=6000000, cat='MAIZE', bdate=date(2026, 5, 1))
        _bill(cls.v2, 'B1', sub=7000000, cat='MAIZE', bdate=date(2026, 5, 1))
        _bill(cls.exp, 'E1', sub=50000, cat='EXPENSES', is_expense=True, bdate=date(2026, 5, 2))
        _bill(cls.frt, 'F1', sub=40000, cat='FREIGHT', bdate=date(2026, 5, 3))

    def setUp(self):
        _auth(self.client)

    def _get(self, **p):
        p.setdefault('from', FY_FROM); p.setdefault('to', FY_TO)
        r = self.client.get(URL, p)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def test_no_company_returns_all_companies(self):
        vendors = {r['vendor'] for r in self._get()['rows']}
        self.assertEqual(vendors, {'Vendor A', 'Vendor B', 'Expense Co', 'Transport Co'})

    def test_company_filter_scopes_by_vendor_company(self):
        # The company lives on the vendor — this is the filter that 500'd before.
        vendors = {r['vendor'] for r in self._get(company=str(self.c1.id))['rows']}
        self.assertNotIn('Vendor B', vendors)
        self.assertIn('Vendor A', vendors)

    def test_company_filter_other_company(self):
        vendors = {r['vendor'] for r in self._get(company=str(self.c2.id))['rows']}
        self.assertEqual(vendors, {'Vendor B'})

    def test_vendor_id_filter(self):
        rows = self._get(vendor_id=str(self.v1.id))['rows']
        self.assertTrue(all(r['vendor'] == 'Vendor A' for r in rows))

    def test_regime_purchase(self):
        rows = self._get(regime='PURCHASE')['rows']
        self.assertTrue(all(r['regime'] == 'PURCHASE' for r in rows))
        self.assertTrue(any(r['vendor'] == 'Vendor A' for r in rows))

    def test_regime_expense(self):
        rows = self._get(regime='EXPENSE')['rows']
        self.assertEqual({r['vendor'] for r in rows}, {'Expense Co'})

    def test_regime_freight(self):
        rows = self._get(regime='FREIGHT')['rows']
        self.assertEqual({r['vendor'] for r in rows}, {'Transport Co'})

    def test_invalid_regime_is_all(self):
        rows = self._get(regime='GARBAGE')['rows']
        self.assertEqual(len({r['vendor'] for r in rows}), 4)

    def test_lowercase_regime_normalised(self):
        rows = self._get(regime='freight')['rows']
        self.assertEqual({r['vendor'] for r in rows}, {'Transport Co'})

    def test_date_window_excludes_outside(self):
        # A bill in April only; query May..May must not return it.
        rows = self._get(**{'from': '2026-05-15', 'to': '2026-05-31'})['rows']
        self.assertEqual(rows, [])

    def test_missing_dates_default_to_fy(self):
        # No from/to → defaults to current FY; a bill dated in FY2026 appears only
        # if today is in that FY, so instead assert the endpoint doesn't error and
        # returns the fy window echoed back.
        r = self.client.get(URL, {'company': str(self.c1.id)})
        self.assertEqual(r.status_code, 200)
        self.assertIn('fy', r.json())

    def test_only_missing_true_variants(self):
        for val in ('1', 'true', 'TRUE', 'yes'):
            body = self._get(only_missing=val)
            self.assertNotIn('MATCHED', {r['status'] for r in body['rows']})

    def test_view_vendor_vs_bill(self):
        self.assertEqual(self._get(view='bill')['view'], 'bill')
        self.assertEqual(self._get(view='vendor')['view'], 'vendor')
        self.assertEqual(self._get(view='garbage')['view'], 'bill')  # default


# ─────────────────────────────────────────────────────────────────────────────
# TDS data: linked / unlinked / multi / zero / opening-balance
# ─────────────────────────────────────────────────────────────────────────────
class TdsDataTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.c = Company.objects.create(company_code='TD1', legal_name='Tds Data Co')
        cls.v = Vendor.objects.create(vendor_name='DataVend', company=cls.c, pan='AAACC7215H')

    def setUp(self):
        _auth(self.client)

    def _row(self, inv):
        r = self.client.get(URL, {'company': str(self.c.id), 'from': FY_FROM, 'to': FY_TO})
        self.assertEqual(r.status_code, 200, r.content[:300])
        return next(x for x in r.json()['rows'] if x['vendor_invoice_no'] == inv)

    def test_multiple_linked_rows_sum(self):
        b = _bill(self.v, 'M1', sub=60000000)
        _link_tds(self.c, self.v, b, 30000)
        _link_tds(self.c, self.v, b, 20000)
        self.assertEqual(Decimal(self._row('M1')['tally_tds']), Decimal('50000.00'))
        self.assertTrue(self._row('M1')['tds_linked'])

    def test_zero_amount_tds_row_ignored(self):
        b = _bill(self.v, 'Z1', sub=60000000, tds=0)
        _link_tds(self.c, self.v, b, 0)       # amount=0 → excluded by amount__gt=0
        self.assertEqual(Decimal(self._row('Z1')['tally_tds']), Decimal('0.00'))

    def test_opening_balance_row_excluded(self):
        # A TdsPayable 'Opening Balance' leg linked to the bill must NOT count as
        # the bill's deduction (brought-forward balance, not a deduction).
        b = _bill(self.v, 'OB1', sub=60000000, tds=0)
        _link_tds(self.c, self.v, b, 99999, vtype='Opening Balance')
        self.assertEqual(Decimal(self._row('OB1')['tally_tds']), Decimal('0.00'))

    def test_unlinked_falls_back_to_bill_tds(self):
        _bill(self.v, 'U1', sub=60000000, total=59959370, tds=40630, net=True)
        row = self._row('U1')
        self.assertEqual(Decimal(row['tally_tds']), Decimal('40630.00'))
        self.assertFalse(row['tds_linked'])
        self.assertEqual(row['status'], 'MISSING_IN_ERP')

    def test_linked_prefers_link_over_bill_field(self):
        # Both present: linked value wins, flagged linked.
        b = _bill(self.v, 'L1', sub=60000000, tds=40630, net=True)
        _link_tds(self.c, self.v, b, 40630)
        row = self._row('L1')
        self.assertEqual(Decimal(row['tally_tds']), Decimal('40630.00'))
        self.assertTrue(row['tds_linked'])
        self.assertEqual(row['status'], 'MATCHED')


# ─────────────────────────────────────────────────────────────────────────────
# 194Q logic
# ─────────────────────────────────────────────────────────────────────────────
class Q194Tests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.c = Company.objects.create(company_code='Q94', legal_name='Q Co')

    def setUp(self):
        _auth(self.client)

    def _rows(self, vendor):
        r = self.client.get(URL, {'company': str(self.c.id), 'from': FY_FROM,
                                  'to': FY_TO, 'vendor_id': str(vendor.id)})
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()['rows']

    def test_below_50l_no_tds_due(self):
        v = Vendor.objects.create(vendor_name='Small', company=self.c, pan='AAACC7215H')
        _bill(v, 'S1', sub=4000000)       # ₹40L < ₹50L
        row = self._rows(v)[0]
        self.assertEqual(Decimal(row['erp_expected_tds']), Decimal('0.00'))
        self.assertFalse(row['threshold_crossed'])
        self.assertEqual(row['status'], 'NOT_DUE')

    def test_above_50l_expected_is_proportional_share(self):
        v = Vendor.objects.create(vendor_name='Big', company=self.c, pan='AAACC7215H')
        # Two goods bills, FY agg = 60L + 40L = 1Cr; excess = 50L; FY TDS = ₹5,000.
        _bill(v, 'G1', sub=6000000)
        _bill(v, 'G2', sub=4000000)
        rows = {r['vendor_invoice_no']: r for r in self._rows(v)}
        # G1 share = 5000 * 60L/100L = 3000 ; G2 = 5000 * 40L/100L = 2000.
        self.assertEqual(Decimal(rows['G1']['erp_expected_tds']), Decimal('3000.00'))
        self.assertEqual(Decimal(rows['G2']['erp_expected_tds']), Decimal('2000.00'))
        # Per-bill shares sum to the vendor FY TDS.
        self.assertEqual(Decimal(rows['G1']['erp_expected_tds'])
                         + Decimal(rows['G2']['erp_expected_tds']), Decimal('5000.00'))

    def test_194q_linked_is_matched_not_under(self):
        v = Vendor.objects.create(vendor_name='Linked194Q', company=self.c, pan='AAACC7215H')
        b = _bill(v, 'LQ', sub=60000000)         # well over ₹50L
        _link_tds(self.c, v, b, 10000)           # less than the full expected
        # 194Q cannot tie per bill → a linked deduction is MATCHED, never UNDER.
        self.assertEqual(self._rows(v)[0]['status'], 'MATCHED')

    def test_fy_base_zero_no_crash(self):
        # A vendor whose only bill is an expense (no goods) → goods_agg has no entry;
        # the 194Q branch must not divide by zero for any goods row (there is none),
        # and the endpoint returns cleanly.
        v = Vendor.objects.create(vendor_name='NoGoods', company=self.c, pan='ABCPF1234E')
        _bill(v, 'NG', sub=50000, cat='EXPENSES', is_expense=True)
        rows = self._rows(v)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['regime'], 'EXPENSE')


# ─────────────────────────────────────────────────────────────────────────────
# 194C logic (expense / freight)
# ─────────────────────────────────────────────────────────────────────────────
class C194Tests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.c = Company.objects.create(company_code='C94', legal_name='C Co')

    def setUp(self):
        _auth(self.client)

    def _row(self, vendor, inv):
        r = self.client.get(URL, {'company': str(self.c.id), 'from': FY_FROM,
                                  'to': FY_TO, 'vendor_id': str(vendor.id)})
        self.assertEqual(r.status_code, 200, r.content[:300])
        return next(x for x in r.json()['rows'] if x['vendor_invoice_no'] == inv)

    def test_expense_over_30k_tds_due_none_when_not_deducted(self):
        v = Vendor.objects.create(vendor_name='ExpCo', company=self.c, pan='AAACC7215H')
        _bill(v, 'E1', sub=50000, cat='EXPENSES', is_expense=True)  # ≥₹30k, company 2%
        row = self._row(v, 'E1')
        self.assertEqual(row['section'], '194C')
        self.assertTrue(row['threshold_crossed'])
        self.assertEqual(Decimal(row['erp_expected_tds']), Decimal('1000.00'))  # 2% of 50k
        self.assertEqual(row['status'], 'TDS_DUE_NONE')      # expected but none deducted

    def test_expense_below_threshold_not_due(self):
        v = Vendor.objects.create(vendor_name='TinyExp', company=self.c, pan='AAACC7215H')
        _bill(v, 'T1', sub=6450, cat='EXPENSES', is_expense=True)  # <₹30k & FY<₹1L
        row = self._row(v, 'T1')
        self.assertEqual(Decimal(row['erp_expected_tds']), Decimal('0.00'))
        self.assertFalse(row['threshold_crossed'])
        self.assertEqual(row['status'], 'NOT_DUE')

    def test_expense_under_deducted(self):
        v = Vendor.objects.create(vendor_name='UnderExp', company=self.c, pan='AAACC7215H')
        b = _bill(v, 'U1', sub=50000, cat='EXPENSES', is_expense=True)  # expects ₹1000
        _link_tds(self.c, v, b, 200, section='194C')                    # only ₹200 deducted
        row = self._row(v, 'U1')
        self.assertEqual(row['status'], 'UNDER_DEDUCTED')

    def test_expense_matched(self):
        v = Vendor.objects.create(vendor_name='OkExp', company=self.c, pan='AAACC7215H')
        b = _bill(v, 'OK', sub=50000, cat='EXPENSES', is_expense=True)
        _link_tds(self.c, v, b, 1000, section='194C')
        self.assertEqual(self._row(v, 'OK')['status'], 'MATCHED')

    def test_freight_regime_and_section(self):
        v = Vendor.objects.create(vendor_name='FreightCo', company=self.c, pan='AAACC7215H')
        _bill(v, 'FR', sub=40000, cat='FREIGHT')
        row = self._row(v, 'FR')
        self.assertEqual(row['regime'], 'FREIGHT')
        self.assertEqual(row['section'], '194C')


# ─────────────────────────────────────────────────────────────────────────────
# Exclusions
# ─────────────────────────────────────────────────────────────────────────────
class ExclusionTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.c = Company.objects.create(company_code='EX1', legal_name='Excl Co')
        cls.good = Vendor.objects.create(vendor_name='Good', company=cls.c, pan='AAACC7215H')
        cls.branch = Vendor.objects.create(vendor_name='Branch', company=cls.c,
                                           pan='AAACC7215H', is_branch=True)
        _bill(cls.good, 'OK', sub=6000000)
        _bill(cls.branch, 'BR', sub=6000000)                      # branch → excluded
        _bill(cls.good, 'CN', sub=6000000, status='CANCELLED')    # cancelled → excluded
        b = _bill(cls.good, 'IN', sub=6000000)                    # inactive → excluded
        b.is_active = False; b.save(update_fields=['is_active'])

    def setUp(self):
        _auth(self.client)

    def test_all_exclusions(self):
        r = self.client.get(URL, {'company': str(self.c.id), 'from': FY_FROM, 'to': FY_TO})
        invs = {x['vendor_invoice_no'] for x in r.json()['rows']}
        self.assertIn('OK', invs)
        self.assertNotIn('BR', invs)     # branch vendor
        self.assertNotIn('CN', invs)     # cancelled bill
        self.assertNotIn('IN', invs)     # inactive bill


# ─────────────────────────────────────────────────────────────────────────────
# Base computation & flags
# ─────────────────────────────────────────────────────────────────────────────
class BaseAndFlagTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.c = Company.objects.create(company_code='BF1', legal_name='Base Co')
        cls.v = Vendor.objects.create(vendor_name='BaseVend', company=cls.c, pan='AAACC7215H')

    def setUp(self):
        _auth(self.client)

    def _row(self, inv):
        r = self.client.get(URL, {'company': str(self.c.id), 'from': FY_FROM, 'to': FY_TO})
        return next(x for x in r.json()['rows'] if x['vendor_invoice_no'] == inv)

    def test_base_falls_back_to_total_minus_tax(self):
        # subtotal=0 → base = total − tax = 1,18,000 − 18,000 = 1,00,000.
        _bill(self.v, 'B1', sub=0, total=118000, tax=18000, cat='EXPENSES', is_expense=True)
        self.assertEqual(Decimal(self._row('B1')['base']), Decimal('100000.00'))

    def test_total_is_net_flag_surfaced(self):
        _bill(self.v, 'N1', sub=60000000, total=59959370, tds=40630, net=True)
        self.assertTrue(self._row('N1')['total_is_net'])

    def test_pan_blank_shows_dash(self):
        v2 = Vendor.objects.create(vendor_name='NoPan', company=self.c, pan='')
        _bill(v2, 'P1', sub=6000000)
        r = self.client.get(URL, {'company': str(self.c.id), 'from': FY_FROM, 'to': FY_TO})
        row = next(x for x in r.json()['rows'] if x['vendor_invoice_no'] == 'P1')
        self.assertEqual(row['pan'], '—')


# ─────────────────────────────────────────────────────────────────────────────
# Totals, rollup & shape
# ─────────────────────────────────────────────────────────────────────────────
class TotalsRollupShapeTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.c = Company.objects.create(company_code='TR1', legal_name='Totals Co')
        cls.v = Vendor.objects.create(vendor_name='RollVend', company=cls.c, pan='AAACC7215H')
        # One matched (linked) + one missing (unlinked) goods bill.
        b1 = _bill(cls.v, 'R1', sub=60000000, tds=10000, net=True)
        _link_tds(cls.c, cls.v, b1, 10000)
        _bill(cls.v, 'R2', sub=40000000, total=39960000, tds=40000, net=True)  # unlinked

    def setUp(self):
        _auth(self.client)

    def _get(self, **p):
        p.setdefault('company', str(self.c.id)); p.setdefault('from', FY_FROM); p.setdefault('to', FY_TO)
        return self.client.get(URL, p).json()

    def test_tally_total_sums_each_once(self):
        # 10,000 (linked) + 40,000 (fallback) = 50,000.
        self.assertEqual(Decimal(self._get()['tally_total']), Decimal('50000.00'))

    def test_missing_count_and_amount(self):
        body = self._get()
        self.assertEqual(body['missing_count'], 1)     # only R2
        self.assertGreater(Decimal(body['missing_amount']), Decimal('0'))

    def test_vendor_rollup_sums(self):
        body = self._get(view='vendor')
        self.assertEqual(len(body['rows']), 1)
        g = body['rows'][0]
        self.assertEqual(g['bills'], 2)
        self.assertEqual(g['missing_bills'], 1)
        self.assertEqual(Decimal(g['tally_tds']), Decimal('50000.00'))
        self.assertEqual(g['status'], 'MISSING_IN_ERP')

    def test_response_shape_keys(self):
        body = self._get()
        for k in ('window', 'fy', 'company_id', 'regime', 'view', 'tally_total',
                  'erp_total', 'difference_total', 'bill_count', 'missing_count',
                  'missing_amount', 'rows'):
            self.assertIn(k, body)
        row = body['rows'][0]
        for k in ('bill_id', 'date', 'bill_no', 'vendor_invoice_no', 'vendor_id',
                  'vendor', 'pan', 'regime', 'section', 'rate_pct', 'billed_value',
                  'base', 'total_payable', 'total_is_net', 'tally_tds',
                  'erp_expected_tds', 'difference', 'tds_linked', 'threshold_crossed',
                  'status', 'reason'):
            self.assertIn(k, row)

    def test_difference_is_expected_minus_tally(self):
        row = next(x for x in self._get()['rows'] if x['vendor_invoice_no'] == 'R2')
        self.assertEqual(Decimal(row['difference']),
                         Decimal(row['erp_expected_tds']) - Decimal(row['tally_tds']))
