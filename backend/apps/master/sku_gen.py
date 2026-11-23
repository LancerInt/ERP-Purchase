"""Auto-generate product SKU codes following the production master conventions.

  Raw Material    : RAW-###
  Finished Good   : FIN GO-###          (note the space + spelling — kept
  Semi Finished   : SIMI FINI-###        exactly so new codes CONTINUE the
                                          existing series rather than start a
                                          fresh, unmatched one)
  Packing Material: <series>-PACK-###    plant-scoped, e.g. SSB-002-PACK-684
                                          (SS Biochem) / UAI-001-PACK-77
                                          (United Agro) — the series is picked
                                          on the form (like a machine base)
  Services        : SRV-###              (matches the existing SRV-001.. series)
  Machinery       : <machine-base>/###   e.g. BU-001/014 (part continues per base)

The "max + 1" always scans ALL products (incl. soft-deleted) via _base_manager,
because sku_code is globally unique — the next number must never reuse a code an
inactive product still holds. Numbering is DB-driven (max of whatever codes are
present), so it stays correct across the master import without hardcoded counts.
"""
import re

from master.models import Product

# Prefix carries its exact trailing separator so the number regex anchors right
# after it. Value is (prefix, zero-pad width).
GOODS_PREFIX = {
    'RAW_MATERIAL':  ('RAW-', 3),
    'FINISHED_GOOD': ('FIN GO-', 3),
    'SEMI_FINISHED': ('SIMI FINI-', 3),
    # PACKING_MATERIAL is plant-scoped ('<series>-PACK-###'); see the pack_* helpers.
}
SERVICE_PREFIX = ('SRV-', 3)
PACK_INFIX = '-PACK-'


def prefix_for(product_type, goods_sub_type):
    """The (prefix, pad) for a globally-numbered goods/service category, or None
    (machinery / packing / a sub-type with no established prefix -> caller falls
    back to a picker or manual entry)."""
    if product_type == 'SERVICES':
        return SERVICE_PREFIX
    if product_type == 'GOODS':
        return GOODS_PREFIX.get(goods_sub_type)
    return None


def _max_number(regex, startswith):
    rx = re.compile(regex)
    mx = 0
    for sku in (Product._base_manager
                .filter(sku_code__startswith=startswith)
                .values_list('sku_code', flat=True)):
        m = rx.match(sku or '')
        if m:
            mx = max(mx, int(m.group(1)))
    return mx


def next_machine_sku(base):
    base = re.sub(r'\s+', '', (base or '').strip())
    if not base:
        return None
    mx = _max_number(re.escape(base) + r'\s*/\s*0*(\d+)\s*$', base)
    return f'{base}/{mx + 1:03d}'


def next_pack_sku(base):
    base = re.sub(r'\s+', '', (base or '').strip())
    if not base:
        return None
    stem = base + PACK_INFIX
    mx = _max_number(re.escape(stem) + r'0*(\d+)\s*$', stem)
    return f'{stem}{mx + 1:03d}'


def next_sku(product_type, goods_sub_type=None, machine_base=None, pack_base=None):
    """Preview / generate the next SKU for a category. None when the category
    needs a picker choice not yet made (machinery without a base, packing
    without a series) or has no auto scheme (SKU entered manually)."""
    if product_type == 'MACHINERY':
        return next_machine_sku(machine_base) if machine_base else None
    if product_type == 'GOODS' and goods_sub_type == 'PACKING_MATERIAL':
        return next_pack_sku(pack_base) if pack_base else None
    pf = prefix_for(product_type, goods_sub_type)
    if not pf:
        return None
    prefix, pad = pf
    mx = _max_number(re.escape(prefix) + r'0*(\d+)\s*$', prefix)
    return f'{prefix}{mx + 1:0{pad}d}'


def machine_bases():
    """Distinct machine bases in use (for the 'pick an existing base' dropdown),
    each with its godown and part count."""
    out = {}
    for p in (Product._base_manager
              .filter(product_type='MACHINERY', sku_code__contains='/')
              .select_related('godown')
              .only('sku_code', 'godown__godown_name')):
        base = re.sub(r'\s+', '', p.sku_code.split('/', 1)[0])
        if not base:
            continue
        e = out.setdefault(base, {'base': base, 'godown': '', 'count': 0})
        e['count'] += 1
        if not e['godown'] and p.godown_id:
            e['godown'] = p.godown.godown_name
    return sorted(out.values(), key=lambda x: x['base'])


def pack_bases():
    """Distinct packing series in use ('<series>-PACK-###'), each with its
    company and count, for the 'pick a series' dropdown."""
    out = {}
    for p in (Product._base_manager
              .filter(product_type='GOODS', goods_sub_type='PACKING_MATERIAL',
                      sku_code__contains=PACK_INFIX)
              .select_related('company')
              .only('sku_code', 'company__legal_name')):
        m = re.match(r'^(.*?)' + re.escape(PACK_INFIX), p.sku_code or '')
        if not m:
            continue
        base = m.group(1).strip()
        if not base:
            continue
        e = out.setdefault(base, {'base': base, 'company': '', 'count': 0})
        e['count'] += 1
        if not e['company'] and p.company_id:
            e['company'] = p.company.legal_name
    return sorted(out.values(), key=lambda x: x['base'])
