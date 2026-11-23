"""Create-or-link the counterpart master when a party is marked as "also a
vendor / also a customer".

A single real-world party is sometimes both a supplier and a buyer. The ERP
keeps a separate Vendor and Customer master for each role (different codes,
different ledgers), so when the user ticks "Also a customer" on a vendor (or
"Also a vendor" on a customer) we must make sure the counterpart master exists
and that the two point at each other.

Both helpers are:
  • idempotent — if the counterpart is already linked they do nothing, and if an
    unlinked counterpart already exists in the same company they link to it
    rather than creating a duplicate; and
  • recursion-safe — the counterpart's own flag/link is written with
    ``update_fields`` via a plain ``.save()`` (NOT through its serializer), so
    the sibling helper is never re-invoked from inside this one.

Unchecking the box never deletes the counterpart master — it is a real record
with its own transactions. Only the creation / linking path lives here.
"""

from django.db import transaction, IntegrityError


@transaction.atomic
def ensure_customer_for_vendor(vendor):
    """Ensure a Customer master exists for a vendor marked ``is_also_customer``
    and link the two both ways. No-op unless the flag is set and no customer is
    linked yet."""
    if not getattr(vendor, 'is_also_customer', False):
        return None
    if vendor.linked_customer_id:
        return vendor.linked_customer

    # Imported here (not at module load) to avoid an import cycle with models.
    from .models import Customer

    cust = _find_matching_customer(vendor)

    if cust is None:
        try:
            with transaction.atomic():
                cust = Customer(
                    company=vendor.company,
                    customer_name=vendor.vendor_name,
                    gstin=vendor.gstin,
                    pan=vendor.pan,
                    gst_treatment=vendor.gst_treatment,
                    contact_person=vendor.contact_person,
                    contact_phone=vendor.contact_phone,
                    contact_email=vendor.contact_email,
                    billing_address=getattr(vendor, 'address', None) or {},
                )
                cust.save()  # customer_code auto-generates in Customer.save
        except IntegrityError:
            # A unique (company, gstin) clash — a Customer with this GSTIN was
            # created concurrently / already exists. Fall back to linking it.
            cust = _find_matching_customer(vendor)
            if cust is None:
                raise

    # Link the counterpart back to this vendor. update_fields + a plain save
    # (not the serializer) is the recursion guard: ensure_vendor_for_customer
    # is never called from here.
    cust.is_also_vendor = True
    cust.linked_vendor = vendor
    cust.save(update_fields=['is_also_vendor', 'linked_vendor', 'updated_at'])

    vendor.linked_customer = cust
    vendor.save(update_fields=['linked_customer', 'updated_at'])
    return cust


@transaction.atomic
def ensure_vendor_for_customer(customer):
    """Ensure a Vendor master exists for a customer marked ``is_also_vendor``
    and link the two both ways. No-op unless the flag is set and no vendor is
    linked yet."""
    if not getattr(customer, 'is_also_vendor', False):
        return None
    if customer.linked_vendor_id:
        return customer.linked_vendor

    from .models import Vendor

    vend = _find_matching_vendor(customer)

    if vend is None:
        try:
            with transaction.atomic():
                vend = Vendor(
                    company=customer.company,
                    vendor_name=customer.customer_name,
                    gstin=customer.gstin,
                    pan=customer.pan,
                    gst_treatment=customer.gst_treatment,
                    contact_person=customer.contact_person,
                    contact_phone=customer.contact_phone,
                    contact_email=customer.contact_email,
                    address=getattr(customer, 'billing_address', None) or {},
                )
                vend.save()  # vendor_code auto-generates in Vendor.save
        except IntegrityError:
            # A unique (company, gstin) / name-key clash — link the existing one.
            vend = _find_matching_vendor(customer)
            if vend is None:
                raise

    vend.is_also_customer = True
    vend.linked_customer = customer
    vend.save(update_fields=['is_also_customer', 'linked_customer', 'updated_at'])

    customer.linked_vendor = vend
    customer.save(update_fields=['linked_vendor', 'updated_at'])
    return vend


# ── Link to a SPECIFICALLY chosen counterpart ────────────────────────────────
# Used when the human picked a particular record in the suggestion picker (the
# fuzzy suggestions only ever SUGGEST — the actual link is always a confirmed,
# explicit choice). Sets both-way flags/links with update_fields + plain saves,
# the same recursion guard the ensure_* path uses.

@transaction.atomic
def link_existing_customer(vendor, customer):
    """Link ``vendor`` to the specific ``customer`` the user chose, both ways."""
    customer.is_also_vendor = True
    customer.linked_vendor = vendor
    customer.save(update_fields=['is_also_vendor', 'linked_vendor', 'updated_at'])
    vendor.is_also_customer = True
    vendor.linked_customer = customer
    vendor.save(update_fields=['is_also_customer', 'linked_customer', 'updated_at'])
    return customer


@transaction.atomic
def link_existing_vendor(customer, vendor):
    """Link ``customer`` to the specific ``vendor`` the user chose, both ways."""
    vendor.is_also_customer = True
    vendor.linked_customer = customer
    vendor.save(update_fields=['is_also_customer', 'linked_customer', 'updated_at'])
    customer.is_also_vendor = True
    customer.linked_vendor = vendor
    customer.save(update_fields=['is_also_vendor', 'linked_vendor', 'updated_at'])
    return vendor


# ── matching helpers ─────────────────────────────────────────────────────────
# Prefer the strongest identity signal available, within the SAME company:
#   gstin (exact) → effective-PAN (exact) → name (case-insensitive exact).
#
# Effective PAN: a party often has no explicit PAN but does carry a GSTIN, and
# the PAN is embedded in the GSTIN as characters 2:12 (state code, then PAN,
# then entity/check). So when the explicit PAN is blank we derive it from the
# GSTIN on BOTH sides of the compare — that catches the "same PAN, one side only
# filled the GSTIN" case deterministically, no fuzziness.
#
# The generic resolvers below take the raw identity fields so the SAME
# precedence drives both the actual link (ensure_* above) and the read-only
# match-preview endpoint (views.party_match_preview) — they can never disagree.
# Each returns (match_or_None, basis) where basis is 'GSTIN' / 'PAN' / 'NAME'.

def _effective_pan(pan='', gstin=''):
    """PAN to compare on: the explicit PAN, else the PAN embedded in the GSTIN
    (chars 2:12). Upper-cased + stripped. '' when neither is available."""
    p = (pan or '').strip().upper()
    if p:
        return p
    g = (gstin or '').strip().upper()
    if len(g) >= 12:
        return g[2:12]
    return ''


def _match_by_effective_pan(base, name_field, target_effpan):
    """First record in ``base`` whose effective PAN equals ``target_effpan``.
    Fast path hits the explicit pan column; the fallback derives the PAN from
    the GSTIN for rows whose pan column is blank."""
    if not target_effpan:
        return None
    hit = base.filter(pan__iexact=target_effpan).first()
    if hit:
        return hit
    # Rows with a GSTIN but blank/other pan — derive and compare in Python.
    for cand in base.exclude(gstin__isnull=True).exclude(gstin=''):
        if _effective_pan(cand.pan, cand.gstin) == target_effpan:
            return cand
    return None


def find_matching_customer(company, gstin='', pan='', name=''):
    """Resolve the best-matching active Customer in ``company``. Returns
    (customer_or_None, basis)."""
    from .models import Customer
    if company is None:
        return None, None
    base = Customer.objects.filter(company=company, is_active=True)
    gstin = (gstin or '').strip()
    if gstin:
        hit = base.filter(gstin__iexact=gstin).first()
        if hit:
            return hit, 'GSTIN'
    effpan = _effective_pan(pan, gstin)
    if effpan:
        hit = _match_by_effective_pan(base, 'customer_name', effpan)
        if hit:
            return hit, 'PAN'
    name = (name or '').strip()
    if name:
        hit = base.filter(customer_name__iexact=name).first()
        if hit:
            return hit, 'NAME'
    return None, None


def find_matching_vendor(company, gstin='', pan='', name=''):
    """Resolve the best-matching active Vendor in ``company``. Returns
    (vendor_or_None, basis)."""
    from .models import Vendor
    if company is None:
        return None, None
    base = Vendor.objects.filter(company=company, is_active=True)
    gstin = (gstin or '').strip()
    if gstin:
        hit = base.filter(gstin__iexact=gstin).first()
        if hit:
            return hit, 'GSTIN'
    effpan = _effective_pan(pan, gstin)
    if effpan:
        hit = _match_by_effective_pan(base, 'vendor_name', effpan)
        if hit:
            return hit, 'PAN'
    name = (name or '').strip()
    if name:
        hit = base.filter(vendor_name__iexact=name).first()
        if hit:
            return hit, 'NAME'
    return None, None


def _find_matching_customer(vendor):
    hit, _basis = find_matching_customer(
        vendor.company, vendor.gstin, vendor.pan, vendor.vendor_name)
    return hit


def _find_matching_vendor(customer):
    hit, _basis = find_matching_vendor(
        customer.company, customer.gstin, customer.pan, customer.customer_name)
    return hit


# ── Loose name SUGGESTIONS (deterministic, no fuzzy auto-link) ────────────────
# When the exact matcher finds nothing we still help the operator spot a
# spelling-variant / role-suffixed counterpart ("Sri Sastha Traders -Dindigul -
# RM" vs "Sri Sastha Traders Dindugal - Sales"). These ONLY suggest — the link
# is never made without a human pick. Scoring is plain token overlap + substring
# containment on role-token-stripped, punctuation-normalised names. No libs, no
# LLM.

# Role / document tokens that distinguish the SAME party's vendor vs customer
# ledger and must not count against a name match.
_ROLE_TOKENS = frozenset({
    'rm', 'raw', 'material', 'materials', 'packing', 'pack',
    'sales', 'sale', 'purchase', 'purchases', 'expense', 'expenses',
    'contractor', 'freight', 'po', 'so', 'unit',
})


def _norm_tokens(name):
    """Lower-case, strip punctuation, drop role tokens. Returns a token list."""
    import re
    s = re.sub(r'[^a-z0-9]+', ' ', (name or '').lower()).strip()
    return [t for t in s.split() if t and t not in _ROLE_TOKENS]


def _name_score(q_toks, c_toks):
    """Deterministic similarity in [0, 1.5]: Jaccard token overlap, +0.5 when
    one normalised name contains the other. 0 when there is no signal."""
    if not q_toks or not c_toks:
        return 0.0
    qs, cs = set(q_toks), set(c_toks)
    inter = len(qs & cs)
    q_str, c_str = ' '.join(q_toks), ' '.join(c_toks)
    contained = q_str in c_str or c_str in q_str
    if inter == 0 and not contained:
        return 0.0
    score = inter / (len(qs | cs) or 1)
    if contained:
        score += 0.5
    return score


def _rank_suggestions(rows, query_name, limit, exclude_id):
    """rows: iterable of (id, name, code). Returns best-first [{id,name,code}]."""
    q_toks = _norm_tokens(query_name)
    scored = []
    for rid, rname, rcode in rows:
        if exclude_id and str(rid) == str(exclude_id):
            continue
        score = _name_score(q_toks, _norm_tokens(rname))
        if score > 0:
            scored.append((score, rname or '', {'id': str(rid), 'name': rname, 'code': rcode}))
    # Best score first; ties broken by name for a stable deterministic order.
    scored.sort(key=lambda x: (-x[0], x[1].lower()))
    return [item for _s, _n, item in scored[:limit]]


def suggest_customers(company, name, limit=5, exclude_id=None):
    """Up to ``limit`` loose-name Customer candidates in ``company`` (active)."""
    from .models import Customer
    if company is None or not (name or '').strip():
        return []
    rows = (Customer.objects.filter(company=company, is_active=True)
            .values_list('id', 'customer_name', 'customer_code'))
    return _rank_suggestions(rows, name, limit, exclude_id)


def suggest_vendors(company, name, limit=5, exclude_id=None):
    """Up to ``limit`` loose-name Vendor candidates in ``company`` (active)."""
    from .models import Vendor
    if company is None or not (name or '').strip():
        return []
    rows = (Vendor.objects.filter(company=company, is_active=True)
            .values_list('id', 'vendor_name', 'vendor_code'))
    return _rank_suggestions(rows, name, limit, exclude_id)
