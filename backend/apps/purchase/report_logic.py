"""Pure computation logic for the Consolidated Report.

Kept deliberately free of Django / DB access so it is fast and exhaustively
unit-testable: every function here takes already-fetched module figures (the
output of the existing, Tally-reconciled dashboard methods) and returns the
report's derived numbers. The view layer (report_views.py) does the DB reads
and feeds the raw figures in; ALL the arithmetic that can be wrong lives here.

Two bases are produced side by side — 'exgst' (a true trading P&L: GST is
neither income nor cost) and 'inclgst' (gross bill totals) — because the user
asked for both.

Freight double-count rule
-------------------------
On-bill freight is booked under the FREIGHT purchase-category, so it is already
inside the dashboard's `expenses` scope. The Direct/Indirect split, however,
comes from `expense_group` on purchase bills and does NOT include the separate
transporter slips. To present ONE honest "Less Freight (all flows)" line we:
  * take freight from the freight-overview total (on-bill + separate), and
  * subtract any freight that is already inside the direct/indirect figures,
    passed in as `freight_in_direct_indirect`, so it is counted exactly once.
The caller measures `freight_in_direct_indirect` from real data; when it is 0
(freight not in the expense_group split) nothing is subtracted.
"""

from decimal import Decimal

Z = Decimal('0')


def _d(v):
    """Coerce anything (None, int, float, str, Decimal) to a Decimal."""
    if v is None:
        return Z
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))


def compute_pnl(*, sales_revenue, purchases, direct_expenses, indirect_expenses,
                freight_total, freight_in_direct_indirect=Z):
    """Build one P&L block from already-fetched, same-basis figures.

    All inputs are a single basis (all ex-GST, or all incl-GST). Returns a dict
    of Decimals. `freight_in_direct_indirect` is the portion of freight already
    sitting inside direct+indirect, removed so freight is counted once.
    """
    sales_revenue = _d(sales_revenue)
    purchases = _d(purchases)
    direct = _d(direct_expenses)
    indirect = _d(indirect_expenses)
    freight = _d(freight_total)
    overlap = _d(freight_in_direct_indirect)

    # Remove freight already embedded in the expense split, so the dedicated
    # freight line owns it. Never let the subtraction push an expense negative.
    direct_net = direct - overlap if overlap <= direct else Z
    # If the overlap exceeds direct, spill the remainder out of indirect too.
    spill = overlap - direct if overlap > direct else Z
    indirect_net = indirect - spill if spill <= indirect else Z

    gross_margin = sales_revenue - purchases
    operating_profit = gross_margin - direct_net - indirect_net - freight

    margin_pct = (operating_profit / sales_revenue * Decimal('100')
                  ).quantize(Decimal('0.01')) if sales_revenue else Z

    return {
        'sales_revenue': _q(sales_revenue),
        'less_purchases': _q(purchases),
        'gross_margin': _q(gross_margin),
        'less_direct_expenses': _q(direct_net),
        'less_indirect_expenses': _q(indirect_net),
        'less_freight': _q(freight),
        'operating_profit': _q(operating_profit),
        'margin_pct': margin_pct,
        'is_profit': operating_profit >= 0,
    }


def _q(v):
    return _d(v).quantize(Decimal('0.01'))


def build_cards(*, sales_billed, sales_count, purchase_exgst, purchase_count,
                direct_expenses, indirect_expenses, freight_total,
                receivables, payables, pnl_operating_profit, pnl_margin_pct):
    """The six summary cards, as a dict of {value, foot, tone}."""
    expense_total = _q(_d(direct_expenses) + _d(indirect_expenses) + _d(freight_total))
    op = _d(pnl_operating_profit)
    return {
        'sales':       {'value': _q(sales_billed), 'foot': f'{sales_count} invoices', 'tone': 'neutral'},
        'purchase':    {'value': _q(purchase_exgst), 'foot': f'{purchase_count} bills', 'tone': 'neutral'},
        'expense':     {'value': expense_total, 'foot': f'incl. freight {_q(freight_total)}', 'tone': 'neutral'},
        'receivables': {'value': _q(receivables), 'foot': 'open', 'tone': 'good'},
        'payables':    {'value': _q(payables), 'foot': 'goods + expense + freight', 'tone': 'alert'},
        'pnl':         {'value': _q(op), 'foot': f"{'profit' if op >= 0 else 'loss'} · margin {pnl_margin_pct}%",
                        'tone': 'good' if op >= 0 else 'alert'},
    }


def module_totals(*, sales, purchase, expense, freight):
    """Billed / Settled / Outstanding rows. Each arg is a dict with those keys."""
    def row(name, d):
        return {
            'module': name,
            'billed': _q(d.get('billed')),
            'settled': _q(d.get('settled')),
            'outstanding': _q(d.get('outstanding')),
        }
    return [row('Sales', sales), row('Purchase', purchase),
            row('Expense', expense), row('Freight', freight)]
