"""Import Tally's Stock Item master hierarchy onto Product records.

Tally groups inventory as  root group -> sub-group (family) -> item, e.g.
    FINISHED GOODS
      Azadirachtin 10000 PPM - TVP        (a family / sub-group)
        Azadirachtin 1% EC Bulk           (the actual stock item)

The Stock Item master export (Gateway -> Export -> Masters -> Inventory
Masters, XML) carries that tree: each <STOCKITEM> has a <PARENT> (its
immediate group) and each <STOCKGROUP> has its own <PARENT> chain up to a
root. This module reads that tree and stamps each matching Product with:
    tally_stock_group = the ROOT group   (e.g. "FINISHED GOODS")
    tally_family      = the immediate sub-group / family, blank when the item
                        sits directly under the root group.

So the sales dashboard's By-Item view can nest exactly like Tally instead of
guessing the family from the product name.

A snapshot of the parsed mapping is committed at data/tally_stock_groups.json
so a migration can apply it on deploy without needing the XML on the server.
Re-generate it from a fresh export with:
    import_stock_groups --master Stock.xml --write
"""
import io
import json
import os
import re

_WS = re.compile(r'\s+')

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'tally_stock_groups.json')


def norm_name(s):
    """Match key: collapse whitespace + lowercase, so 'Azadirachtin  1 % EC'
    (Tally's double spaces) and the ERP's single-spaced name resolve equal."""
    return _WS.sub(' ', (s or '').strip()).lower()


def load_bundled_mapping():
    """The committed snapshot: {normkey: {name, family, group}}."""
    try:
        with io.open(DATA_PATH, encoding='utf-8-sig') as f:
            return json.load(f).get('items', {})
    except FileNotFoundError:
        return {}


def parse_stock_xml(raw_or_text):
    """Parse a Tally Stock Item master export -> {normkey: {name, family, group}}.

    Reuses the Day Book's recovering lxml parser (Tally exports are UTF-16 and
    carry control chars stdlib ElementTree refuses)."""
    from sales.tally_daybook import _lxml_root
    root = _lxml_root(raw_or_text)
    if root is None:
        return {}

    # group name -> immediate parent
    grp_parent = {}
    for g in root.iter('STOCKGROUP'):
        name = (g.get('NAME') or '').strip()
        if not name:
            continue
        pe = g.find('PARENT')
        par = (pe.text or '').strip() if (pe is not None and pe.text) else ''
        grp_parent.setdefault(name, par)

    def resolve_root(grp):
        """Walk up until a group whose parent is empty / 'Primary' -> the root."""
        seen = set()
        cur = grp
        while cur and cur in grp_parent and grp_parent[cur] and grp_parent[cur] != 'Primary':
            if cur in seen:
                break
            seen.add(cur)
            cur = grp_parent[cur]
        return cur

    items = {}
    for it in root.iter('STOCKITEM'):
        name = (it.get('NAME') or '').strip()
        if not name:
            continue
        key = norm_name(name)
        if key in items:
            continue
        pe = it.find('PARENT')
        par = (pe.text or '').strip() if (pe is not None and pe.text) else ''
        group, family = '', ''
        if par and par in grp_parent:
            root_g = resolve_root(par)
            group = root_g
            if par != root_g:
                family = par
        elif par and par != 'Primary':
            group = par
        items[key] = {'name': name, 'family': family, 'group': group}
    return items


def apply_mapping(mapping, dry_run=False):
    """Stamp Product.tally_stock_group / tally_family from `mapping`, matching by
    normalised product name. Idempotent; returns stats."""
    from master.models import Product

    by_name = {}
    for p in Product.objects.all().only('id', 'product_name', 'tally_stock_group', 'tally_family'):
        by_name.setdefault(norm_name(p.product_name), []).append(p)

    matched, to_update, matched_keys = 0, [], set()
    for key, info in mapping.items():
        plist = by_name.get(key)
        if not plist:
            continue
        matched_keys.add(key)
        new_g = info.get('group', '') or ''
        new_f = info.get('family', '') or ''
        for p in plist:
            matched += 1
            if p.tally_stock_group != new_g or p.tally_family != new_f:
                p.tally_stock_group = new_g
                p.tally_family = new_f
                to_update.append(p)

    if not dry_run and to_update:
        Product.objects.bulk_update(to_update, ['tally_stock_group', 'tally_family'])

    return {
        'mapping_items': len(mapping),
        'matched_products': matched,
        'updated': len(to_update),
        'unmatched_items': [mapping[k]['name'] for k in mapping if k not in matched_keys],
    }


def write_bundled_mapping(mapping, source=''):
    """Persist a parsed mapping to the committed JSON snapshot (no BOM)."""
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    out = {'source': source or 'Tally Stock Item master', 'items': mapping}
    with io.open(DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
