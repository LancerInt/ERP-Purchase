"""Keep the ERPModule registry in step with the views that actually gate on it.

WHY
---
Adding a page meant hand-writing a data migration to insert its ERPModule row —
there are twelve of those (0039..0052), one per feature. Miss it and the page
does not merely lack a permission row: check_permission FAILS CLOSED, so every
non-superuser is locked out of a feature that looks shipped, and the Permissions
screen has no row to grant it with. The failure is silent and only shows up when
a real user complains.

The module a view gates on is already declared on the view itself:

    class CreditorViewSet(...):
        module_name = 'Creditors'

so that declaration is the source of truth. This walks the URLconf, reads it off
every routed view, and creates any row that does not exist yet. Adding a page is
now one attribute, and the row appears on the next deploy.

CATEGORY IS DECLARED, NOT GUESSED
---------------------------------
The Permissions UI splits modules into per-domain tabs by `category`, and a row
with no category shows up in NO tab — so getting it wrong is as bad as missing
the row. Category cannot be inferred from the app label: measured against the
live registry, `purchase` views map to both PURCHASE and FREIGHT, `production`
to PRODUCTION and INVENTORY, `core` to MASTERS and ADMIN, and `ai_parser` to
PURCHASE and SALES. An app-label guess would misfile roughly one module in six.

So a view states it when the app default is not right:

    module_name = 'Freight Advice'
    module_category = 'FREIGHT'      # optional; APP_CATEGORY is the fallback

NOTHING IS EVER REMOVED
-----------------------
Only creates. A name can be gated from places this walk cannot see (management
commands, celery tasks, `check_permission` called directly), so a row that looks
orphaned may still be load-bearing — and deleting it locks users out, which is
the exact failure this module exists to prevent. Pruning stays a human decision.
"""
from django.utils.text import slugify

# Fallback only — used when a view does not declare `module_category`.
# Derived from the categories the live registry actually uses.
APP_CATEGORY = {
    'purchase': 'PURCHASE',
    'sales': 'SALES',
    'finance': 'FINANCE',
    'bank': 'BANK',
    'expenses': 'EXPENSES',
    'hr': 'HR',
    'inventory': 'INVENTORY',
    'production': 'PRODUCTION',
    'quality': 'QUALITY',
    'master': 'MASTERS',
    'core': 'MASTERS',
    'rbac': 'ADMIN',
    'audit': 'ADMIN',
    'archive': 'ADMIN',
    'communications': 'ADMIN',
    'notifications': 'ADMIN',
    'workflow': 'ADMIN',
}


def _iter_view_classes(resolver=None, seen=None):
    """Every view CLASS reachable from the root URLconf, once each."""
    from django.urls import get_resolver
    resolver = resolver or get_resolver()
    seen = seen if seen is not None else set()
    for pattern in resolver.url_patterns:
        sub = getattr(pattern, 'url_patterns', None)
        if sub is not None:
            yield from _iter_view_classes(pattern, seen)
            continue
        cb = getattr(pattern, 'callback', None)
        # DRF puts the class on `.cls`; plain Django CBVs on `.view_class`.
        cls = getattr(cb, 'cls', None) or getattr(cb, 'view_class', None)
        if cls is not None and id(cls) not in seen:
            seen.add(id(cls))
            yield cls


def discover():
    """{module name: category} for every routed view that gates on a module."""
    found = {}
    for cls in _iter_view_classes():
        name = getattr(cls, 'module_name', None)
        # Must be a plain string. At least one viewset defines `module_name` as
        # a PROPERTY (resolved per-request), which arrives here as the property
        # object itself — writing that to the DB would create a garbage row.
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()
        category = getattr(cls, 'module_category', None)
        if not isinstance(category, str) or not category.strip():
            category = APP_CATEGORY.get(cls.__module__.split('.')[0], '')
        # First declaration wins, but never let a blank overwrite a real one.
        if name not in found or (not found[name] and category):
            found[name] = category
    return found


def sync(dry_run=False):
    """Create ERPModule rows for any discovered module that has none.

    Returns {'created': [...], 'existing': n, 'uncategorised': [...]}.
    """
    from .models import ERPModule

    found = discover()
    have = set(ERPModule.objects.values_list('name', flat=True))
    missing = sorted(n for n in found if n not in have)

    created = []
    for name in missing:
        category = found[name]
        slug = slugify(name)[:150] or slugify(f'module-{len(created)}')
        # Slug is unique too; disambiguate rather than blow up the deploy.
        base, i = slug, 2
        while ERPModule.objects.filter(slug=slug).exclude(name=name).exists():
            slug = f'{base}-{i}'[:150]
            i += 1
        if not dry_run:
            ERPModule.objects.create(name=name, slug=slug, category=category)
        created.append((name, slug, category or '(none)'))

    # A row with no category renders in no Permissions tab, so it is invisible
    # to whoever needs to grant it. Surfaced rather than silently accepted.
    uncategorised = sorted(
        n for n in found
        if not found[n] and not ERPModule.objects.filter(name=n).exclude(category='').exists()
    )
    return {'created': created, 'existing': len(found) - len(missing),
            'uncategorised': uncategorised}
