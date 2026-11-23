"""Shared engine for merging duplicate party masters (customers, vendors).

Both merge_customers and merge_vendors are thin wrappers around this, so the
safety rules live in exactly one place: relations are discovered from Django's
own metadata, each one moves in its own savepoint, and a source that still has
rows attached afterwards is left ACTIVE rather than orphaning them.
"""
import re

from django.db import transaction

# Legal-form noise, and nothing else. Deliberately far shorter than
# cleanup_customers._NOISE, which also drops corporation / industries /
# enterprises / traders — fine for customers, where those are decoration, but
# for vendors that word is often the only thing separating two real firms
# ('Rekha Chemical Corporation' vs 'Rekha Chemical Industries').
_LEGAL = re.compile(r'\b(pvt|private|ltd|limited|llp|inc|incorporated|'
                    r'co|company|and|the)\b')


def vkey(s):
    """Strict party identity: punctuation, spacing and legal suffixes only.

        'Jet Inks Private Limited - Chennai' == 'Jet Inks  Private Ltd - Chennai'
        'Rekha Chemical Corporation'         != 'Rekha Chemical Industries'

    Shared by vendor_audit (finding duplicates) and the Zoho/Tally import
    (matching an incoming name to an existing master), so a pair that reads as
    the same vendor in one place cannot read as two in the other.
    """
    s = (s or '').lower()
    s = _LEGAL.sub(' ', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


# Unit spellings that mean the same thing. Anything not listed is treated as
# "no unit" rather than guessed at, so an ordinary word after a number ("VAM
# 1000 Spores") never masquerades as one.
_UNITS = {
    'ml': 'ml',
    'l': 'l', 'lt': 'l', 'lts': 'l', 'ltr': 'l', 'ltrs': 'l',
    'litre': 'l', 'litres': 'l', 'liter': 'l', 'liters': 'l',
    'kg': 'kg', 'kgs': 'kg', 'g': 'g', 'gm': 'g', 'gms': 'g', 'gram': 'g',
    'mm': 'mm', 'cm': 'cm', 'mtr': 'm', 'mts': 'mts', 'ton': 'ton', 'tons': 'ton',
    '%': '%', 'gal': 'gal', 'gallon': 'gal', 'gallons': 'gal',
    'nos': 'nos', 'pcs': 'pcs', 'pc': 'pcs',
}
_MEASURE = re.compile(r'(\d+(?:\.\d+)?)\s*(%|[a-z]{1,7})?')


def word_key(s):
    """Sorted word multiset with every measurement token removed.

    Product names are written in whatever order the person typing felt like:
    '3MM N.C.P Pellets' and 'N.C.P Pellets - 3 MM' are the same item, and a
    key that preserves word order calls them different. Pair this with
    measures() — which DOES keep order, because '5 % 1 Ltr' and '1 % 5 Ltr'
    are genuinely different products — and the two together identify a product
    regardless of how it was written.
    """
    t = re.sub(r'\d+(?:\.\d+)?', ' ', (s or '').replace('\xa0', ' ').lower())
    t = re.sub(r'[^a-z]+', ' ', t)
    return tuple(sorted(w for w in t.split() if w not in _UNITS))


def measures(s):
    """Ordered (number, unit) pairs — a product's real identity.

    The numbers are a tiny fraction of a product name, so string similarity is
    at its most confident exactly where it is most wrong. Measured on a real
    Zoho preview:

        'Neem Oil 1.2% 50 Ltr'   vs 'Neem Oil 1.2 % - 5 Ltr'       97%
        'Spic Scytoz 50 ML'      vs 'Spic Scytoz - 50 Ltr'   same number, wrong unit
        'Label Nimbecidine 5 % 1 Ltr' vs '1 % - 5 Ltr'       same numbers, swapped

    So the comparison keeps both the unit and the ORDER: a sorted set of bare
    numbers calls the last two pairs identical, and they are different products.
    """
    out = []
    for num, unit in _MEASURE.findall((s or '').lower()):
        out.append((num.rstrip('0').rstrip('.') if '.' in num else num,
                    _UNITS.get((unit or '').strip(), '')))
    return tuple(out)


def resolve(Model, token, code_field, name_field):
    """Find one record by code (preferred), then exact name, then pk.

    Returns (obj, error_message). Ambiguous names are an error rather than a
    guess — picking the wrong master would move real history onto it.
    """
    token = (token or '').strip()
    if not token:
        return None, 'empty'
    qs = Model.objects.filter(**{f'{code_field}__iexact': token})
    if qs.count() == 1:
        return qs.first(), ''
    qs = Model.objects.filter(**{f'{name_field}__iexact': token})
    if qs.count() == 1:
        return qs.first(), ''
    if qs.count() > 1:
        return None, f'{token!r} matches {qs.count()} records by name — use the code'
    try:
        return Model.objects.get(pk=token), ''
    except Exception:  # noqa: BLE001
        return None, f'nothing matches {token!r}'


def plan(obj):
    """[(relation, related_model, field_name, count, kind)] pointing at `obj`.

    Walks _meta.related_objects, so every FK/M2M in the project counts and a
    model added later is picked up without touching this code.
    """
    out = []
    for rel in obj._meta.related_objects:
        model = rel.related_model
        field = rel.field.name
        try:
            n = model.objects.filter(**{field: obj}).count()
        except Exception:  # noqa: BLE001
            continue
        if n:
            kind = 'm2m' if rel.many_to_many else ('o2o' if rel.one_to_one else 'fk')
            out.append((rel, model, field, n, kind))
    return out


def record_alias(retired_name, keeper, company):
    """Remember that `retired_name` really means `keeper`.

    Without this a merge only holds on the database it was run on. The import
    resolves a Tally/Zoho name by map, then exact name, then a normalised
    match; a retired master matches none of those, so the very next import
    RECREATES the duplicate the merge was performed to remove — and on a fresh
    device the merge never happened at all.

    TallyPartyMap is the ERP's existing alias table and is already consulted
    first by every resolver, so writing the retired NAME here makes the
    correction survive re-imports and travel between databases (see
    export_corrections / import_corrections).

    Returns True when a row was written or repointed.
    """
    from sales.models import TallyPartyMap
    name = (retired_name or '').strip()
    if not name or company is None:
        return False          # the alias table is keyed on (company, name)
    field = {'Customer': 'customer', 'Vendor': 'vendor',
             'Product': 'product', 'Transporter': 'transporter'}.get(
                 keeper._meta.object_name)
    if not field:
        return False
    row, _ = TallyPartyMap.objects.get_or_create(company=company, tally_name=name)
    setattr(row, field, keeper)
    row.skip = False
    row.save(update_fields=[field, 'skip', 'updated_at'])
    return True


def execute(keeper, sources, plans, *, hard, w, style, code_field):
    """Move every planned row onto `keeper`, then retire the emptied sources.

    Returns (moved, failed). Never raises for a single bad relation — a
    unique-constraint clash on one table is reported and skipped so the rest
    of the merge still lands.
    """
    moved = failed = 0
    for s in sources:
        for _rel, model, field, n, kind in plans[s.pk]:
            try:
                with transaction.atomic():
                    if kind == 'm2m':
                        for obj in model.objects.filter(**{field: s}):
                            getattr(obj, field).remove(s)
                            getattr(obj, field).add(keeper)
                    else:
                        model.objects.filter(**{field: s}).update(**{field: keeper})
                moved += n
            except Exception as e:  # noqa: BLE001
                failed += 1
                w(style.ERROR(f'  ! {model._meta.label}.{field} ({n} row(s)) '
                              f'could not move: {e}'))
                w('    -> left on the source; resolve by hand.')

        code = getattr(s, code_field, s.pk)
        leftover = plan(s)
        if leftover:
            w(style.WARNING(
                f'  {code} still has {sum(x[3] for x in leftover)} row(s) attached '
                '— left ACTIVE so nothing is orphaned.'))
            continue
        # Write the alias BEFORE retiring: once the row is deleted its name is
        # gone, and that name is the only thing a future import will see.
        aliased = False
        try:
            with transaction.atomic():
                aliased = record_alias(getattr(s, 'vendor_name', None)
                                       or getattr(s, 'customer_name', None)
                                       or getattr(s, 'product_name', None)
                                       or getattr(s, 'name', None),
                                       keeper, getattr(s, 'company', None))
        except Exception as e:  # noqa: BLE001 — an alias must never block a merge
            w(style.WARNING(f'  ! could not record alias for {code}: {e}'))
        try:
            with transaction.atomic():
                if hard:
                    s.delete()
                else:
                    s.is_active = False
                    s.save(update_fields=['is_active'])
            w(style.SUCCESS(f'  {code} emptied and '
                            + ('deleted.' if hard else 'deactivated.')
                            + (' Name aliased to the keeper, so re-imports '
                               'resolve it here.' if aliased else '')))
        except Exception as e:  # noqa: BLE001
            w(style.ERROR(f'  ! could not retire {code}: {e}'))
    return moved, failed


def run_merge(cmd, *, Model, label, code_field, name_field, into, sources_arg,
              apply_, hard, force):
    """Full dry-run/apply flow shared by both merge commands."""
    w = cmd.stdout.write
    style = cmd.style

    keeper, err = resolve(Model, into, code_field, name_field)
    if err:
        w(style.ERROR(f'--into: {err}'))
        return
    sources = []
    for tok in (sources_arg or '').split(','):
        if not tok.strip():
            continue
        obj, err = resolve(Model, tok, code_field, name_field)
        if err:
            w(style.ERROR(f'--from: {err}'))
            return
        if obj.pk == keeper.pk:
            w(style.ERROR(f'--from {tok!r} is the same record as --into.'))
            return
        sources.append(obj)
    if not sources:
        w(style.ERROR('--from resolved to nothing.'))
        return

    def _line(o):
        co = getattr(o, 'company', None)
        return (f'{getattr(o, name_field)}  [{getattr(o, code_field)}]  '
                f'{co.legal_name if co else "(no company)"}')

    w('')
    w('=' * 68)
    w(f'KEEP    {_line(keeper)}')
    for s in sources:
        w(f'MERGE   {_line(s)}')
    w('=' * 68)

    bad = [s for s in sources if s.company_id != keeper.company_id]
    if bad and not force:
        w(style.ERROR(
            'These belong to a DIFFERENT company than the keeper:\n  '
            + '\n  '.join(_line(s) for s in bad)
            + f'\nSame-named {label}s under different companies are usually genuinely '
              'different parties. Re-run with --force only if you are certain.'))
        return

    plans = {s.pk: plan(s) for s in sources}
    grand = 0
    for s in sources:
        rows = plans[s.pk]
        total = sum(n for _, _, _, n, _ in rows)
        grand += total
        w('')
        w(f'From {_line(s)} — {total} record(s) to move:')
        if not rows:
            w('  (nothing attached — it will just be retired)')
        for _rel, model, field, n, kind in rows:
            flag = '  !! one-to-one' if kind == 'o2o' else ''
            w(f'  {model._meta.label:<38} .{field:<22} {n:>5}  ({kind}){flag}')

    w('')
    if not apply_:
        w(style.WARNING(
            f'DRY RUN — nothing was changed. {grand} record(s) would move onto '
            f'{getattr(keeper, code_field)}.'))
        w('Re-run with --apply to perform the merge '
          '(sources are deactivated; add --hard to delete them).')
        return

    moved, failed = execute(keeper, sources, plans, hard=hard, w=w, style=style,
                            code_field=code_field)
    w('')
    w(style.SUCCESS(f'Moved {moved} record(s) onto {getattr(keeper, code_field)}.')
      if not failed else
      style.WARNING(f'Moved {moved} record(s); {failed} relation(s) failed — see above.'))
