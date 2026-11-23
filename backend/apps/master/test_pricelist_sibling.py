"""get_price_lists_for_customer: normalised sibling-name fallback.

Duplicate customer records (same business, one row per company) often differ
only in punctuation/spacing. When the PO matches the record WITHOUT a price
list, the list tied to a same-named sibling under the PO's company must still
be found — even when the two names aren't byte-identical.
"""
from django.test import TestCase

from core.models import Company
from master.models import Customer, PriceList
from master.selectors import get_price_lists_for_customer


class SiblingNamePriceListTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.uai = Company.objects.create(
            company_code='UAI', legal_name='United Agro', trade_name='UAI',
            gstin='33AAAAA0000A1Z5', pan='AAAAA0000A',
        )
        cls.ssb = Company.objects.create(
            company_code='SSB', legal_name='SS Biochem', trade_name='SSB',
            gstin='33BBBBB0000B1Z5', pan='BBBBB0000B',
        )
        # Same business, two records, names differ only by a comma.
        cls.cust_uai = Customer.objects.create(
            customer_code='CUS-039', customer_name='T.Stanes And Company Ltd., - Coimbatore',
            company=cls.uai,
        )
        cls.cust_ssb = Customer.objects.create(
            customer_code='CUS-069', customer_name='T.Stanes And Company Ltd - Coimbatore',
            company=cls.ssb,
        )
        # The price list lives on the SS Biochem record.
        cls.pl = PriceList.objects.create(
            price_list_id='SSB-T.STANS-026', company=cls.ssb, customer=cls.cust_ssb,
            status='ACTIVE', is_active=True,
        )
        # A decoy: different customer, same company — must NOT be returned.
        cls.other = Customer.objects.create(
            customer_code='CUS-100', customer_name='Greenstar Fertilisers - North',
            company=cls.ssb,
        )
        PriceList.objects.create(
            price_list_id='SSB-GFL-N-012', company=cls.ssb, customer=cls.other,
            status='ACTIVE', is_active=True,
        )

    def test_sibling_list_found_despite_name_punctuation_diff(self):
        # PO matched the UAI record (no SSB list of its own); the SSB sibling's
        # list must be recovered, scoped to the SS Biochem company.
        result = get_price_lists_for_customer(self.cust_uai.id, company=self.ssb.id)
        ids = {pl.price_list_id for pl in result}
        self.assertIn('SSB-T.STANS-026', ids)
        self.assertNotIn('SSB-GFL-N-012', ids)  # decoy stays out

    def test_no_leak_when_customer_has_own_list(self):
        # If the matched customer DOES have a list, we never reach for a sibling.
        PriceList.objects.create(
            price_list_id='UAI-TS-001', company=self.uai, customer=self.cust_uai,
            status='ACTIVE', is_active=True,
        )
        result = get_price_lists_for_customer(self.cust_uai.id, company=self.uai.id)
        ids = {pl.price_list_id for pl in result}
        self.assertIn('UAI-TS-001', ids)
        self.assertNotIn('SSB-T.STANS-026', ids)
