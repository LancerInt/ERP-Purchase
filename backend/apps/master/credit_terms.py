"""A customer's credit terms, and the due date they imply.

WHY AN EFFECTIVE DATE
---------------------
`Customer.credit_terms` defaults to NET_30 on every master the Tally importer
creates, and most of them have never been looked at. The last time the ERP
trusted that field, it invented credit for 81 parties and parked 185 bills
(Rs 19.52 Cr) in "Not due" while Tally's own ageing showed every one of them
overdue — see the comment in sales.tally_import_run._due_from_ledger.

`credit_terms_effective_from` is what separates "someone agreed these terms"
from "nobody has touched this row". BLANK MEANS NOT IN FORCE: credit_days_for
returns None and every caller falls back to exactly what it did before. A term
only starts deciding due dates once a human dates it.

The date also bounds the change in time. Re-dating an invoice that has already
been reported on is not a correction, it is a restatement — so a new term
applies from its effective date forward and leaves earlier invoices alone.

WHAT IS DELIBERATELY NOT CONFIGURED
-----------------------------------
CUSTOM with no `custom_credit_days` is not "zero days"; it is a row somebody
part-filled. On production that is ~105 of 394 active customers. Reading it as
zero would mark every one of their invoices overdue on the day it was raised,
so it returns None and changes nothing until the days are supplied.
"""
import re
from datetime import date, timedelta

# Labels THIS SYSTEM writes when it derives a due date, rather than reading one
# off the document: "45 Days", "Tally", "Due on invoice", "Terms". Anything
# else in `payment_terms` was stated by the invoice itself — production carries
# "NET30" on 42 of them — and a term the invoice states outranks the customer
# master, because it is what was agreed for that particular sale.
_DERIVED_LABEL = re.compile(r'^\s*(\d+\s*days|tally|due on invoice|terms)\s*$', re.I)

NAMED_TERM_DAYS = {
    'NET_15': 15,
    'NET_30': 30,
    'NET_45': 45,
    'NET_60': 60,
}


def fy_start_for(on_date=None):
    """1 April of the financial year containing `on_date` (default: today)."""
    d = on_date or date.today()
    return date(d.year if d.month >= 4 else d.year - 1, 4, 1)


def credit_days_for(customer, on_date):
    """Days of credit in force for a document dated `on_date`.

    Returns None for "no answer" — unconfigured, or the terms are not yet in
    force — which every caller treats as "carry on as before". 0 is a real
    answer and means CASH: due on presentation, not "no terms".
    """
    if customer is None or on_date is None:
        return None
    effective = getattr(customer, 'credit_terms_effective_from', None)
    if not effective or on_date < effective:
        return None
    terms = (getattr(customer, 'credit_terms', '') or '').upper()
    if terms == 'CASH':
        return 0
    if terms == 'CUSTOM':
        days = getattr(customer, 'custom_credit_days', None)
        # NULL is "nobody filled this in" -> leave invoices alone. A number the
        # operator actually typed, INCLUDING 0, is a real answer: 0 means due
        # on the bill date. The field is nullable, so the two are
        # distinguishable and must not be conflated (they were, which is why
        # setting Custom = 0 appeared to do nothing).
        if days is None:
            return None
        try:
            days = int(days)
        except (TypeError, ValueError):
            return None
        return max(0, days)
    return NAMED_TERM_DAYS.get(terms)


def due_date_for(customer, doc_date):
    """`doc_date` + the customer's credit days, or None if no terms apply."""
    days = credit_days_for(customer, doc_date)
    return None if days is None else doc_date + timedelta(days=days)


def terms_label(customer):
    """Short label for the stored `payment_terms` column (20 chars)."""
    terms = (getattr(customer, 'credit_terms', '') or '').upper()
    if terms == 'CASH':
        return 'Due on invoice'
    days = NAMED_TERM_DAYS.get(terms)
    if days is None and terms == 'CUSTOM':
        days = getattr(customer, 'custom_credit_days', None)
    return ('%s Days' % days) if days else 'Terms'


def is_stated_term(label):
    """True when `payment_terms` came off the invoice, not from our own guess.

    The distinction is what keeps a customer-master edit from rewriting a term
    that was agreed for one particular sale.
    """
    label = (label or '').strip()
    return bool(label) and not _DERIVED_LABEL.match(label)


def days_from_label(label):
    """Credit days a stated term implies, or None if it cannot be read.

    Handles the spellings that actually appear: NET30, NET_30, Net 30, 30,
    and the cash-equivalents. None means "unreadable" — leave the invoice
    alone rather than guess at it.
    """
    s = (label or '').strip().upper().replace('_', '').replace('-', '').replace(' ', '')
    if not s:
        return None
    if s in ('CASH', 'COD', 'DUEONINVOICE', 'IMMEDIATE', 'ONDELIVERY', 'ADVANCE'):
        return 0
    m = re.search(r'(\d+)', s)
    return int(m.group(1)) if m else None
