"""
Query selectors and filters for master app.
Optimized queries with select_related and prefetch_related.
"""
from django.db.models import Prefetch, Q, Count
from django.utils import timezone
from .models import (
    Product, ServiceCatalogue, Vendor, Customer, Transporter, PriceList,
    PriceLine, TaxMaster, TemplateLibrary
)


def get_products(active_flag: bool = True, **filters):
    """
    Get products with optional filters.
    Optimized for list views.
    """
    queryset = Product.objects.select_related(
        'qc_template', 'custom_service_category'
    )

    if active_flag is not None:
        queryset = queryset.filter(active_flag=active_flag)

    for key, value in filters.items():
        if value is not None:
            queryset = queryset.filter(**{key: value})

    return queryset.order_by('sku_code')


def get_product_detail(product_id: int):
    """
    Get single product with all related data.
    """
    return Product.objects.filter(id=product_id).select_related(
        'qc_template', 'custom_service_category', 'packing_material_default'
    ).prefetch_related(
        'secondary_uoms'
    ).first()


def get_products_by_type(product_type: str, active_flag: bool = True):
    """
    Get products filtered by type.
    """
    queryset = Product.objects.filter(product_type=product_type)

    if active_flag:
        queryset = queryset.filter(active_flag=True)

    return queryset.select_related(
        'qc_template', 'custom_service_category'
    ).order_by('sku_code')


def get_products_with_batch_tracking():
    """
    Get products requiring batch tracking.
    """
    return Product.objects.filter(
        batch_tracking_required=True,
        active_flag=True
    ).order_by('sku_code')


def get_products_with_yield_tracking():
    """
    Get products with yield tracking enabled.
    """
    return Product.objects.filter(
        yield_tracking_required=True,
        active_flag=True
    ).order_by('sku_code')


def get_active_vendors(company=None):
    """
    Get active vendors with proper optimizations.
    """
    queryset = Vendor.objects.select_related('company').prefetch_related(
        'bank_details', 'preferred_transporters', 'allowed_warehouses'
    ).filter(active_flag=True)

    if company:
        queryset = queryset.filter(company=company)

    return queryset.order_by('vendor_code')


def get_vendor_detail(vendor_id: int):
    """
    Get vendor with all related data.
    """
    return Vendor.objects.filter(id=vendor_id).select_related(
        'company'
    ).prefetch_related(
        'bank_details',
        'preferred_transporters',
        'allowed_warehouses'
    ).first()


def get_vendors_by_type(vendor_type_item: str, active_flag: bool = True):
    """
    Get vendors by type (MATERIAL, SERVICE, FREIGHT, etc.).
    """
    queryset = Vendor.objects.select_related('company')

    if active_flag:
        queryset = queryset.filter(active_flag=True)

    # Filter by vendor type in JSONField
    queryset = queryset.filter(vendor_type__contains=vendor_type_item)

    return queryset.order_by('vendor_code')


def get_vendors_for_warehouse(warehouse):
    """
    Get vendors allowed for a warehouse.
    """
    return Vendor.objects.filter(
        allowed_warehouses=warehouse,
        active_flag=True
    ).select_related('company').prefetch_related(
        'bank_details'
    ).order_by('vendor_code')


def get_active_customers(company=None):
    """
    Get active customers with proper optimizations.
    """
    queryset = Customer.objects.select_related(
        'company'
    ).prefetch_related(
        'shipping_addresses', 'allowed_price_lists'
    ).filter(active_flag=True)

    if company:
        queryset = queryset.filter(company=company)

    return queryset.order_by('customer_code')


def get_customer_detail(customer_id: int):
    """
    Get customer with all related data.
    """
    return Customer.objects.filter(id=customer_id).select_related(
        'company'
    ).prefetch_related(
        'shipping_addresses__default_price_list',
        'allowed_price_lists'
    ).first()


def get_customers_by_credit_terms(credit_terms: str):
    """
    Get customers by credit term type.
    """
    return Customer.objects.filter(
        credit_terms=credit_terms,
        active_flag=True
    ).select_related('company').order_by('customer_code')


def get_customers_for_warehouse(warehouse):  # noqa: ARG001
    """
    Default warehouse was removed from Customer; this helper now
    returns an empty queryset to preserve the call signature for any
    external callers.
    """
    return Customer.objects.none()


# ── Customer-name similarity for the price-list sibling bridge ─────────
# Duplicate customer records for the SAME business rarely share an exact
# name: "T.Stanes And Company Ltd., - Coimbatore" vs "T.Stanes And Company
# Ltd - Coimbatore" (punctuation), "Greenstar Fertilisers Limited - North"
# vs "Greenstar Fertilizers Limited" (s/z spelling + regional suffix). An
# exact normalized comparison misses those, so the bridge below scores
# names fuzzily and accepts the best candidate above a HIGH threshold —
# strict enough that a different business ("Greenstar Agro") never bridges.
_NAME_MATCH_STOPWORDS = {
    'PVT', 'LTD', 'PRIVATE', 'LIMITED', 'LLP', 'INC', 'INCORPORATED',
    'CORPORATION', 'CORP', 'COMPANY', 'CO', 'PLC',
    'INDIA', 'INDIAN',
    'NORTH', 'SOUTH', 'EAST', 'WEST', 'BRANCH', 'UNIT', 'DIVISION',
    'THE', 'AND',
}
NAME_BRIDGE_THRESHOLD = 0.8


def _norm_customer_name(name):
    """Uppercase, drop parentheticals/punctuation, strip corporate suffixes
    and regional markers. Returns a token-joined core name."""
    import re
    cleaned = re.sub(r'\([^)]*\)', ' ', str(name or '').upper())
    cleaned = re.sub(r'[^A-Z0-9]+', ' ', cleaned)
    tokens = [t for t in cleaned.split() if t and t not in _NAME_MATCH_STOPWORDS]
    return ' '.join(tokens)


# Regional markers ("- North") that distinguish per-region sibling records
# of the same business. The bridge must not hand a North customer the
# South sibling's price list, so scoring is region-gated via _region_of.
_REGION_MARKERS = {'NORTH', 'SOUTH', 'EAST', 'WEST'}


def _region_of(name):
    """Single regional marker present in a name, '' when none (or when
    several appear — treat that as unmarked rather than guessing)."""
    import re
    tokens = set(re.sub(r'[^A-Z0-9]+', ' ', str(name or '').upper()).split())
    found = tokens & _REGION_MARKERS
    return next(iter(found)) if len(found) == 1 else ''


def customer_name_similarity(a, b):
    """0..1 similarity between two customer names, robust to punctuation,
    corporate suffixes, regional markers, and minor spelling variants
    ("Fertilisers" vs "Fertilizers"). 1.0 = same normalized core."""
    from difflib import SequenceMatcher
    na, nb = _norm_customer_name(a), _norm_customer_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    jaccard = (len(ta & tb) / len(ta | tb)) if (ta or tb) else 0.0
    seq = SequenceMatcher(None, na, nb).ratio()
    # Full containment of a 2+-token core is near-certain same business.
    contained = 0.85 if (
        (len(ta) >= 2 and ta <= tb) or (len(tb) >= 2 and tb <= ta)
    ) else 0.0
    return max(jaccard, seq, contained)


def get_price_lists_for_customer(customer, company=None):
    """
    Get all price lists available for a customer.
    Accepts: customer model instance, int ID, UUID, or string UUID.

    When `company` is supplied the result is additionally scoped to price
    lists owned by that company (or to company-agnostic lists). Used by
    the Customer PO auto-extractor so a customer with price lists under
    multiple companies doesn't get a list belonging to a *different*
    company silently auto-selected on the form.
    """
    if hasattr(customer, 'id'):
        customer_id = customer.id
    else:
        customer_id = customer

    # Resolve the customer's name so we can, as a LAST RESORT only, recover a
    # list from a same-named SIBLING record (see the fallback below).
    customer_name = ''
    if hasattr(customer, 'customer_name'):
        customer_name = (customer.customer_name or '').strip()
    else:
        _c = Customer.objects.filter(id=customer_id).only('customer_name').first()
        customer_name = (_c.customer_name or '').strip() if _c else ''

    # Effective-date window is checked against today; NULL dates are
    # open-ended. `dated=False` skips the check (expired-only fallback).
    today = timezone.now().date()

    def _scoped(cust_filter, dated=True, light=False):
        # is_active=True is essential: a soft-deleted price list keeps
        # status='ACTIVE', so without it the auto-extractor kept fetching
        # lists that had been deleted from the Price List master (they no
        # longer appear there, which filters is_active=True).
        # `light=True` skips the heavy joins — the bridge's name scan only
        # reads (customer_id, customer_name) via values_list.
        qs = PriceList.objects.filter(
            cust_filter, status='ACTIVE', is_active=True
        )
        if not light:
            qs = qs.select_related('company', 'customer').prefetch_related(
                'price_lines__product', 'price_lines__state_group')
        if company:
            company_id = company.id if hasattr(company, 'id') else company
            qs = qs.filter(Q(company_id=company_id) | Q(company__isnull=True))
        if dated:
            qs = qs.filter(
                Q(effective_from__isnull=True) | Q(effective_from__lte=today)
            ).exclude(effective_to__lt=today)
        return qs.order_by('-effective_from')

    # Customer-SPECIFIC lists only. The name-bridge / cross-company fallbacks
    # below trigger off THIS, not `own` — otherwise a single company-agnostic
    # (customer=NULL) price list makes `own.exists()` true and silently
    # disables the fallback, so the customer's real list on a DUPLICATE
    # customer record ("...Ltd.," vs "...Ltd") never surfaces. That was the
    # T. Stanes bug: the buyer matched CUS-039 (no list) while the list lived
    # on the price-list-import's PL-CUST-065, and agnostic lists masked it.
    own_specific = _scoped(Q(customer_id=customer_id))
    # Full result set: the customer's own lists PLUS company-agnostic ones.
    own = _scoped(Q(customer_id=customer_id) | Q(customer__isnull=True))

    # ── Sibling / cross-company bridge ─────────────────────────────────
    # Runs ONLY when this customer record has NO list of its own. The same
    # business is often registered as several Customer rows (one per company,
    # or minted by the price-list import as PL-CUST-###), and the record a PO
    # matches frequently isn't the record the price list hangs off. We must
    # NOT pull a sibling's list when the customer already has their own —
    # that previously leaked another record's list onto a PO whose customer
    # did have a list.
    #
    # The bridge is FUZZY (customer_name_similarity ≥ NAME_BRIDGE_THRESHOLD):
    # exact/normalized equality alone missed real duplicates that differ by
    # punctuation ("Ltd.," vs "Ltd"), spelling ("Fertilisers"/"Fertilizers"),
    # or regional suffixes ("- North"). The best-scoring sibling wins and
    # ONLY that one customer's lists are returned — never a mix. Search
    # order: same company first, then any company (cross-company data split).
    if company and not own_specific.exists():
        def _any(cust_filter, dated=True, light=False):
            qs = PriceList.objects.filter(
                cust_filter, status='ACTIVE', is_active=True
            )
            if not light:
                qs = qs.select_related('company', 'customer').prefetch_related(
                    'price_lines__product', 'price_lines__state_group')
            if dated:
                qs = qs.filter(
                    Q(effective_from__isnull=True) | Q(effective_from__lte=today)
                ).exclude(effective_to__lt=today)
            return qs.order_by('-effective_from')

        # 1. This exact customer's lists under ANOTHER company.
        any_own = _any(Q(customer_id=customer_id))
        if any_own.exists():
            return any_own

        # 2. Fuzzy name-bridge to a sibling record — company-scoped pass
        #    first, then unscoped. Score every candidate list's customer,
        #    pick the single best customer above threshold.
        if customer_name:
            target_region = _region_of(customer_name)

            def _best_sibling(scan_qs, full):
                # Scan a cheap (customer_id, customer_name) projection —
                # values_list ignores the prefetch, so the fuzzy pass never
                # materializes the whole catalog. `full` rebuilds the real
                # (prefetched) queryset for the winning customer only.
                best_cust, best_score = None, 0.0
                top_regions = set()
                for cust_id, nm in scan_qs.values_list(
                        'customer_id', 'customer__customer_name').distinct():
                    region = _region_of(nm)
                    # Region gate: a "- North" target never bridges to a
                    # "- South" sibling; a marker-less parent record is
                    # always allowed.
                    if target_region and region and region != target_region:
                        continue
                    score = customer_name_similarity(customer_name, nm)
                    if score > best_score:
                        best_cust, best_score = cust_id, score
                        top_regions = {region} if region else set()
                    elif score == best_score and best_cust is not None and region:
                        top_regions.add(region)
                if best_cust is None or best_score < NAME_BRIDGE_THRESHOLD:
                    return None
                # Region-less target with a top-score TIE across different
                # regions is ambiguous — don't guess which region applies.
                if not target_region and len(top_regions) > 1:
                    return None
                return full(Q(customer_id=best_cust))

            for scan_qs, full in (
                (_scoped(Q(customer__isnull=False), light=True), _scoped),  # same company
                (_any(Q(customer__isnull=False), light=True), _any),        # any company
            ):
                bridged = _best_sibling(scan_qs, full)
                if bridged is not None and bridged.exists():
                    return bridged

    # A customer whose ONLY lists are date-expired keeps a working picker:
    # fall back to the undated result rather than returning nothing.
    if not own.exists():
        own_undated = _scoped(
            Q(customer_id=customer_id) | Q(customer__isnull=True), dated=False)
        if own_undated.exists():
            return own_undated

    return own


def get_active_price_lists(company=None):
    """
    Get currently active price lists.
    """
    today = timezone.now().date()

    queryset = PriceList.objects.filter(
        status='ACTIVE',
        effective_from__lte=today
    ).exclude(effective_to__lt=today).select_related(
        'company', 'customer'
    ).prefetch_related('price_lines')

    if company:
        queryset = queryset.filter(company=company)

    return queryset.order_by('-effective_from', 'price_list_id')


def get_price_list_detail(price_list_id: int):
    """
    Get price list with all lines.
    """
    return PriceList.objects.filter(id=price_list_id).select_related(
        'company', 'customer'
    ).prefetch_related(
        'price_lines__product'
    ).first()


def get_price_for_product(customer, product, date=None, *, state_code='', packing='', state_group=None):
    """
    Get the best-matching PriceLine for a (customer, product) pair.

    State filtering can be supplied EITHER as:
      • `state_group` — a resolved StateGroup instance (or its id). Use
        this path when the caller already knows which group applies
        (e.g. CPO has `state_group` set explicitly by the user or by
        the auto-extractor). Avoids re-running address parsing.
      • `state_code` — ISO 3166-2:IN code ("TN", "KA"). Used when the
        caller has only the address and wants the resolver to pick
        the most-specific group automatically.

    When neither is supplied the lookup runs in legacy mode — only
    state_group=NULL price lines are considered.

    `packing` is matched fuzzily: an exact (case-insensitive) match
    wins, otherwise a line whose packing string CONTAINS the requested
    label is accepted (so a CPO asking for "20 KG" hits a price list
    line tagged "20 KG & 40 KG"). When `packing` is blank we don't
    filter on it at all.

    Returns the PriceLine instance, or None if nothing matched.
    """
    from django.db.models import Q
    from .state_resolver import best_state_group_for
    from .models import StateGroup

    if date is None:
        date = timezone.now().date()

    price_lists = get_price_lists_for_customer(customer)

    # Resolve the state group ONCE up front. Caller-supplied instance
    # wins; otherwise fall back to address-driven resolution. None at
    # the end means we'll only consider default (state_group__isnull=
    # True) lines.
    resolved_group = None
    if state_group is not None:
        if isinstance(state_group, StateGroup):
            resolved_group = state_group
        else:
            resolved_group = StateGroup.objects.filter(pk=state_group).first()
    elif state_code:
        resolved_group = best_state_group_for(state_code)
    state_group = resolved_group

    def _packing_filter(qs):
        if not packing:
            return qs
        # Exact (case-insensitive) match preferred; the caller falls
        # back to the fuzzy contains() when exact returns nothing.
        return qs.filter(Q(packing__iexact=packing) | Q(packing__icontains=packing))

    def _date_valid(line):
        # PriceLine.valid_from / valid_to are optional. Treat NULL as
        # "always valid" instead of crashing the old code's
        # `valid_from <= date` comparison.
        if line.valid_from and line.valid_from > date:
            return False
        if line.valid_to and line.valid_to < date:
            return False
        return True

    # The destination expressed as a set of state codes: the explicit
    # group's members when the caller passed one, else the single
    # resolved code. Empty set = legacy mode (no state info at all).
    if state_group is not None:
        dest_codes = {str(s).upper() for s in (state_group.member_states or [])}
    elif state_code:
        dest_codes = {state_code.upper()}
    else:
        dest_codes = set()

    for price_list in price_lists:
        # Honor the price list's own effective_from / effective_to.
        if price_list.effective_from and price_list.effective_from > date:
            continue
        if price_list.effective_to and price_list.effective_to < date:
            continue

        base_qs = price_list.price_lines.filter(product=product)

        # 1. State-specific line for this exact group.
        if state_group is not None:
            line = _packing_filter(base_qs.filter(state_group=state_group)).first()
            if line and _date_valid(line):
                return line

        # 1b. Membership match. The globally most-specific group for
        # the destination (say "TAMIL NADU") is often NOT the group the
        # price list's lines are tagged with (say "SOUTH STATES") — so
        # rank the groups THIS product's lines actually use: any group
        # covering every destination code qualifies, fewest members
        # wins (a KERALA line beats the SOUTH STATES cluster for a
        # Kerala buyer).
        if dest_codes:
            used_groups = {
                ln.state_group
                for ln in base_qs.select_related('state_group')
                if ln.state_group_id
            }
            covering = [
                g for g in used_groups
                if dest_codes <= {str(s).upper() for s in (g.member_states or [])}
            ]
            covering.sort(key=lambda g: (len(g.member_states or []), g.name))
            for g in covering:
                line = _packing_filter(base_qs.filter(state_group=g)).first()
                if line and _date_valid(line):
                    return line

        # 2. Default (customer-wide) line — state_group is NULL.
        line = _packing_filter(base_qs.filter(state_group__isnull=True)).first()
        if line and _date_valid(line):
            return line

        # 3. Last-ditch: any line for this product, ignoring state /
        # packing — but ONLY in legacy mode (caller gave no state
        # info). A state-aware caller must never be handed some other
        # state's rate just because it exists on the list.
        if not dest_codes:
            line = base_qs.first()
            if line and _date_valid(line):
                return line

    return None


def get_active_transporters(min_rating: int = None):
    """
    Get active transporters. `min_rating` kept as an arg for
    backwards-compat with callers, but now a no-op — `rating` was
    removed from the Transporter master per user request.
    """
    return Transporter.objects.filter(active_flag=True).order_by('transporter_code')


def get_transporter_detail(transporter_id: int):
    """
    Get transporter details.
    """
    return Transporter.objects.filter(id=transporter_id).first()


def get_applicable_taxes(company, tax_type: str = None):
    """
    Get currently applicable tax rules.
    """
    today = timezone.now().date()

    queryset = TaxMaster.objects.filter(
        company_scope=company,
        effective_from__lte=today
    ).exclude(effective_to__lt=today)

    if tax_type:
        queryset = queryset.filter(tax_type=tax_type)

    return queryset.order_by('-effective_from', 'tax_type')


def get_tax_for_transaction(company, tax_type: str, amount=None):
    """
    Get applicable tax rule for a transaction.
    """
    today = timezone.now().date()

    queryset = TaxMaster.objects.filter(
        company_scope=company,
        tax_type=tax_type,
        effective_from__lte=today
    ).exclude(effective_to__lt=today)

    # If amount provided, filter by threshold
    if amount:
        queryset = queryset.filter(
            Q(threshold_amount__isnull=True) | Q(threshold_amount__lte=amount)
        )

    return queryset.order_by('-effective_from').first()


def get_active_templates(template_type: str = None):
    """
    Get currently active templates.
    """
    today = timezone.now().date()

    queryset = TemplateLibrary.objects.filter(
        status='ACTIVE',
        effective_from__lte=today
    ).exclude(effective_to__lt=today).prefetch_related(
        'warehouse_scope'
    )

    if template_type:
        queryset = queryset.filter(template_type=template_type)

    return queryset.order_by('template_type', '-revision_no')


def get_templates_by_type(template_type: str):
    """
    Get templates by type, latest first.
    """
    return TemplateLibrary.objects.filter(
        template_type=template_type
    ).prefetch_related(
        'warehouse_scope', 'approval_logs'
    ).order_by('-revision_no')


def get_template_detail(template_id: int):
    """
    Get template with all approvals.
    """
    return TemplateLibrary.objects.filter(id=template_id).prefetch_related(
        'warehouse_scope',
        'approval_logs__approved_by__user'
    ).first()


def get_templates_for_warehouse(warehouse, template_type: str = None):
    """
    Get templates applicable for a warehouse.
    """
    today = timezone.now().date()

    queryset = TemplateLibrary.objects.filter(
        Q(warehouse_scope=warehouse) | Q(warehouse_scope__isnull=True),
        status='ACTIVE',
        effective_from__lte=today
    ).exclude(effective_to__lt=today).distinct()

    if template_type:
        queryset = queryset.filter(template_type=template_type)

    return queryset.order_by('template_type', '-revision_no')


def search_products(query: str):
    """
    Search products by SKU or name.
    """
    return Product.objects.filter(
        Q(sku_code__icontains=query) | Q(product_name__icontains=query),
        active_flag=True
    ).select_related('custom_service_category').order_by('sku_code')


def search_vendors(query: str, company=None):
    """
    Search vendors by code or name.
    """
    queryset = Vendor.objects.filter(
        Q(vendor_code__icontains=query) | Q(vendor_name__icontains=query),
        active_flag=True
    ).select_related('company')

    if company:
        queryset = queryset.filter(company=company)

    return queryset.order_by('vendor_code')


def search_customers(query: str, company=None):
    """
    Search customers by code or name.
    """
    queryset = Customer.objects.filter(
        Q(customer_code__icontains=query) | Q(customer_name__icontains=query),
        active_flag=True
    ).select_related('company')

    if company:
        queryset = queryset.filter(company=company)

    return queryset.order_by('customer_code')


def get_price_list_statistics(price_list):
    """
    Get statistics for a price list.
    """
    from django.db.models import Avg, Min, Max, Count

    stats = price_list.price_lines.aggregate(
        line_count=Count('id'),
        avg_rate=Avg('rate'),
        min_rate=Min('rate'),
        max_rate=Max('rate'),
        avg_discount=Avg('discount'),
        avg_gst=Avg('gst')
    )

    return {
        'line_count': stats['line_count'],
        'rate_stats': {
            'average': float(stats['avg_rate'] or 0),
            'minimum': float(stats['min_rate'] or 0),
            'maximum': float(stats['max_rate'] or 0),
        },
        'avg_discount': float(stats['avg_discount'] or 0),
        'avg_gst': float(stats['avg_gst'] or 0),
    }


def get_vendor_statistics(vendor):
    """
    Get statistics for a vendor.
    """
    return {
        'code': vendor.vendor_code,
        'name': vendor.vendor_name,
        'credit_limit': float(vendor.credit_limit),
        'credit_days': vendor.credit_days,
        'bank_accounts': vendor.bank_details.count(),
        'allowed_warehouses': vendor.allowed_warehouses.count(),
        'preferred_transporters': vendor.preferred_transporters.count(),
    }
