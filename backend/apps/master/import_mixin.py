"""Bulk Excel-import mixin shared by every Master ViewSet.

The Master module needs a uniform "upload an .xlsx and create rows" flow
across Customers, Vendors, Products, Price Lists, Transporters, Tax
Master, Service Catalogue and Template Library. Rather than write that
flow eight times we provide one mixin: each ViewSet just declares which
columns its Excel template should have (and any FK lookups to perform)
and gets two endpoints for free:

    GET  {prefix}/import-template/   →  download blank .xlsx with headers
    POST {prefix}/import/            →  upload .xlsx, returns counts + errors

The mixin is intentionally permissive: blank rows are skipped, extra
columns in the uploaded file are ignored, and FK fields are resolved
case-insensitively against the field declared by the ViewSet (e.g. a
"Company" column matches an existing Company by `legal_name`).
"""
from io import BytesIO

from django.apps import apps
from django.db import transaction
from django.db.models import ProtectedError
from django.http import HttpResponse
from openpyxl import Workbook, load_workbook
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response


def _clean(value):
    """Trim, convert empty cells / "None" / "NULL" to ''."""
    if value is None:
        return ''
    s = str(value).strip()
    if s.lower() in ('none', 'null', 'nan'):
        return ''
    return s


# ─────────────────────────────────────────────────────────────────────────
# Address helpers — shared by the Excel export (readable format) and the
# Excel import (parse back into a JSONField-friendly dict). The format is
# a single line, 5 pipe-separated fields:
#
#     "Line1, Line2 | City | State | Pincode | Country"
#
# This is human-readable, round-trips cleanly, and survives Excel cell
# editing (no JSON braces / quotes the user might accidentally break).
# ─────────────────────────────────────────────────────────────────────────
ADDRESS_FIELD_ORDER = ['line', 'city', 'state', 'pincode', 'country']


def format_address(addr):
    """Dict → readable pipe-separated string. Safe on already-strings."""
    if not addr:
        return ''
    if isinstance(addr, str):
        return addr
    if not isinstance(addr, dict):
        return str(addr)

    def get(*keys):
        for k in keys:
            v = addr.get(k)
            if v is not None and str(v).strip() != '':
                return str(v).strip()
        return ''

    line = ', '.join(p for p in [
        get('line1', 'raw_address', 'address'),
        get('line2'),
    ] if p)
    city = get('city', 'district')
    state = get('state')
    pincode = get('pincode', 'pin', 'zip')
    country = get('country') or 'INDIA'
    return ' | '.join([line, city, state, pincode, country])


def parse_address(value):
    """Reverse of format_address. Accepts:

       • a dict / list — returned as-is
       • a JSON string starting with '{' or '[' — parsed
       • a pipe-separated readable string — split into a dict
       • an empty / blank cell — returns {}

    The 5-slot pipe format is the canonical readable format produced by
    the export. We tolerate a 4-slot variant (no country) for forgiveness.
    """
    if value is None or value == '':
        return {}
    if isinstance(value, (dict, list)):
        return value
    text = str(value).strip()
    if not text:
        return {}

    # JSON path — the old export wrote raw JSON, still accept it.
    if text.startswith('{') or text.startswith('['):
        import json as _json
        try:
            return _json.loads(text)
        except _json.JSONDecodeError:
            pass  # fall through to pipe parsing

    if '|' in text:
        parts = [p.strip() for p in text.split('|')]
        # Pad up to 5 slots so missing tail fields don't crash.
        parts += [''] * (5 - len(parts))
        line, city, state, pincode, country = parts[:5]
        return {
            'line1':   line,
            'city':    city,
            'state':   state,
            'pincode': pincode,
            'country': country or 'INDIA',
        }
    # Final fallback — stuff the whole text into line1 so nothing is lost.
    return {'line1': text, 'country': 'INDIA'}


def _header_lookup(headers, target):
    """Find a header column by name, case- and space-insensitive."""
    norm_target = target.replace(' ', '').replace('_', '').lower()
    for idx, h in enumerate(headers):
        if h is None:
            continue
        norm = str(h).replace(' ', '').replace('_', '').lower()
        if norm == norm_target:
            return idx
    return None


def read_export_ids(request):
    """Row-id filter for an export request. The frontend POSTs
    {"ids": [...]} to scope the export to exactly the rows visible on the
    filtered list page; a plain GET (no ids) exports the whole queryset."""
    if request is None:
        return None
    data = getattr(request, 'data', None) or {}
    ids = data.get('ids')
    if not ids:
        try:
            ids = request.query_params.getlist('ids')
        except Exception:
            ids = None
    return ids or None


def build_export_xlsx_response(
    *,
    queryset,
    parent_columns,
    parent_fk_resolvers=None,
    parent_address_fields=(),
    line_relation='',
    line_columns=(),
    line_fk_resolvers=None,
    filename='export',
    sheet_title='Export',
    ids=None,
):
    """Build an .xlsx HttpResponse from a queryset, optionally flattening
    a child relation into the same sheet.

    Each `*_columns` entry is either a bare string (used as both header
    and attribute name) or a `(label, field)` tuple. When `line_relation`
    + `line_columns` are given, every parent row is expanded into one
    row per line (parent cells repeated); a parent with no lines still
    emits one row so it isn't silently dropped.

    Used by both the Master `BulkImportMixin.export_data` action and the
    Sales viewsets (SO / DC / Invoice), so the "flatten lines into one
    sheet" behaviour is consistent across modules.
    """
    parent_fk_resolvers = parent_fk_resolvers or {}
    line_fk_resolvers   = line_fk_resolvers   or {}
    address_set = set(parent_address_fields or ())

    # When the caller passes a set of ids (the exact rows visible on the
    # filtered list page), scope the export to them so the file matches
    # what the user is looking at. Empty/None → export the whole queryset.
    if ids:
        queryset = queryset.filter(pk__in=ids)

    def _primary_label(col):
        if isinstance(col, str):
            return col
        label, _field = col[0], col[1]
        if isinstance(label, (list, tuple)):
            return label[0]
        return label

    def _field_name(col):
        return col if isinstance(col, str) else col[1]

    def _resolve_fk_cell(related, resolvers, field):
        if related is None:
            return ''
        # Resolver specs may carry an optional third scope element (used
        # by the importer) — only the first two matter for exports.
        spec = resolvers[field]
        _model, lookup = spec[0], spec[1]
        lookups = (lookup,) if isinstance(lookup, str) else tuple(lookup)
        for lk in lookups:
            val = getattr(related, lk, '') or ''
            if val:
                return val
        return str(related)

    # Ordered list of attribute names we try when emitting an FK cell
    # without an explicit resolver. Picking the first non-empty match
    # keeps the export human-readable for every master regardless of
    # which "code / name" convention the model uses. The final UUID-ish
    # fallback is intentionally absent: we'd rather emit `str(obj)` (the
    # model's __str__, almost always a useful label) than a UUID.
    _FK_READABLE_FALLBACKS = (
        'warehouse_code', 'company_code', 'customer_code', 'vendor_code',
        'transporter_code', 'godown_code', 'sku_code', 'product_code',
        'price_list_id', 'broker_code',
        'name', 'product_name', 'customer_name', 'vendor_name',
        'transporter_name', 'godown_name', 'legal_name', 'trade_name',
        'so_no', 'dc_no', 'invoice_no', 'po_number',
        'gstin', 'email', 'username',
    )

    def _looks_like_uuid(v):
        s = str(v)
        return len(s) == 36 and s.count('-') == 4

    def _readable_value(value):
        """Best-effort readable representation of any value that would
        otherwise serialise as a UUID. Handles Django model instances
        (auto-resolves a name/code attribute) and bare UUIDs (returns
        empty string — emitting a UUID into a user-facing sheet is
        never useful)."""
        if value is None:
            return ''
        # Django model instance — try the common readable attrs first,
        # then fall back to the model's __str__ (almost always nicer
        # than the PK).
        if hasattr(value, '_meta') and hasattr(value._meta, 'model'):
            for attr in _FK_READABLE_FALLBACKS:
                v = getattr(value, attr, '') or ''
                if v and not _looks_like_uuid(v):
                    return v
            s = str(value)
            return '' if _looks_like_uuid(s) else s
        # Bare UUID (or UUID-shaped string) — strip it, it's never
        # what the user wants to see in Excel.
        if _looks_like_uuid(value):
            return ''
        return value

    def _format_cell(obj, field, addr_fields, fk_resolvers):
        value = getattr(obj, field, '')
        if value is None:
            return ''
        if field in addr_fields:
            return format_address(value)
        if field in fk_resolvers:
            return _resolve_fk_cell(getattr(obj, field, None), fk_resolvers, field)
        if isinstance(value, bool):
            return 'True' if value else 'False'
        # Auto-resolve any FK / UUID-shaped value into a readable label,
        # even when the ViewSet didn't declare an explicit resolver.
        # Keeps exports useful for fields that slipped through.
        return _readable_value(value)

    parent_headers = [_primary_label(c) for c in parent_columns]
    parent_fields  = [_field_name(c)    for c in parent_columns]
    line_headers   = [f'Line {_primary_label(c)}' for c in line_columns]
    line_fields    = [_field_name(c) for c in line_columns]

    wb = Workbook()
    ws = wb.active
    ws.title = (sheet_title or 'Export')[:31]
    headers = parent_headers + line_headers
    ws.append(headers)
    for cell in ws[1]:
        cell.font = cell.font.copy(bold=True)

    for obj in queryset:
        parent_row = [
            _format_cell(obj, f, address_set, parent_fk_resolvers)
            for f in parent_fields
        ]
        if not line_relation or not line_columns:
            ws.append(parent_row)
            continue
        lines = list(getattr(obj, line_relation).all()) if hasattr(obj, line_relation) else []
        if not lines:
            ws.append(parent_row + [''] * len(line_fields))
            continue
        for line in lines:
            line_row = [
                _format_cell(line, f, set(), line_fk_resolvers)
                for f in line_fields
            ]
            ws.append(parent_row + line_row)

    for col_idx in range(1, len(headers) + 1):
        ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = 22

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    resp = HttpResponse(
        buf.read(),
        content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    resp['Content-Disposition'] = f'attachment; filename="{filename}.xlsx"'
    return resp


class SoftDeleteMixin:
    """Soft-delete behaviour for master ViewSets.

    The default DRF `destroy` calls `instance.delete()` — a hard delete.
    For master records that are referenced from across the ERP (Company →
    Vendor / Customer / PriceList / Warehouse / etc., usually with
    `on_delete=PROTECT`) this raises `ProtectedError` and the user sees
    "Failed to delete" with no recourse.

    BaseModel already carries an `is_active` flag and a `soft_delete()`
    helper. We override `destroy()` to:

      1. Try to soft-delete (set is_active=False) — succeeds on every
         master row, regardless of how many things reference it. The list
         queryset already filters by is_active=True so the row disappears
         from the UI as expected.
      2. Fall back to a hard delete only when soft-delete makes no sense
         (instance lacks `is_active`, which BaseModel guarantees won't
         happen here, but the fallback is defensive).
      3. Surface a clean message if the database still refuses.
    """

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        try:
            self._soft_delete_one(instance)
        except ProtectedError as exc:
            related = ', '.join({obj._meta.verbose_name for obj in exc.protected_objects})
            return Response(
                {'error': f'Cannot delete — record is still referenced by: {related}.'},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @staticmethod
    def _soft_delete_one(instance):
        """Flip every soft-delete flag the instance exposes and save.

        Master models inherit BaseModel.is_active; some legacy models
        ALSO carry an `active_flag`. Flipping both means a single click
        hides the row regardless of which flag the list queryset is
        filtering on. Falls through to a hard delete only when neither
        flag exists (BaseModel guarantees at least is_active, so this
        branch is defensive).
        """
        update_fields = []
        if hasattr(instance, 'is_active'):
            instance.is_active = False
            update_fields.append('is_active')
        if hasattr(instance, 'active_flag'):
            instance.active_flag = False
            update_fields.append('active_flag')
        if update_fields:
            # updated_at auto_now only fires when listed explicitly
            # alongside update_fields.
            instance.save(update_fields=update_fields + ['updated_at'])
        else:
            instance.delete()

    # ─────────────────────────────────────────────────────────────────
    # POST /<resource>/bulk-delete/
    # ─────────────────────────────────────────────────────────────────
    @action(
        detail=False,
        methods=['post'],
        url_path='bulk-delete',
    )
    @transaction.atomic
    def bulk_delete(self, request):
        """Soft-delete a list of records in one request.

        Body: ``{"ids": ["uuid1", "uuid2", ...]}``

        Permission is gated by the standard ``can_delete`` flag on the
        module. The mapping lives in ``rbac.permissions.ACTION_PERM_MAP``
        — any role granted Delete on this module's row in the admin
        permission grid can call this endpoint. Other roles get 403
        before any rows are touched.

        Behaviour:
          - Soft-deletes via the same path as the per-row destroy()
            (flips is_active + active_flag).
          - Each row is wrapped in its own ``savepoint`` so a
            ``ProtectedError`` on one record doesn't roll back the
            whole batch — successes commit, failures report.
          - Response: ``{deleted, failed, errors: [...]}`` with the
            same error shape the BulkImport endpoint uses.
        """
        ids = request.data.get('ids') or []
        if not isinstance(ids, list) or not ids:
            return Response(
                {'error': 'Send a non-empty "ids" array.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Cap the batch to a sane upper bound — a 50k-row delete
        # request is almost certainly a UI mistake, and an open
        # transaction that big would hold locks for a while.
        if len(ids) > 500:
            return Response(
                {'error': f'Too many ids: {len(ids)}. Bulk delete is capped at 500 per request.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        qs = self.get_queryset().filter(pk__in=ids)
        # Index by string PK so the "not found" lookup is O(1).
        instances_by_id = {str(obj.pk): obj for obj in qs}
        deleted = 0
        errors = []
        for raw_id in ids:
            instance = instances_by_id.get(str(raw_id))
            if instance is None:
                errors.append({'id': str(raw_id), 'error': 'Not found in current scope.'})
                continue
            try:
                with transaction.atomic():
                    self._soft_delete_one(instance)
                deleted += 1
            except ProtectedError as exc:
                related = ', '.join({o._meta.verbose_name for o in exc.protected_objects})
                errors.append({
                    'id': str(raw_id),
                    'error': f'Cannot delete — referenced by: {related}.',
                })
            except Exception as exc:  # noqa: BLE001
                errors.append({'id': str(raw_id), 'error': str(exc)[:300]})

        return Response({
            'requested': len(ids),
            'deleted':   deleted,
            'failed':    len(errors),
            'errors':    errors[:200],
        }, status=status.HTTP_200_OK)


class BulkImportMixin:
    """Mix into any ModelViewSet to expose `/import/` and
    `/import-template/` endpoints.

    Subclasses configure two class attributes:

      import_columns   List[str | (label, field)]
                       Column order for the template + the set of
                       fields the importer will look for in the
                       uploaded file. A bare string is treated as both
                       label and serializer field name. A tuple lets
                       you set a human-friendly label that differs
                       from the field name.

      import_fk_resolvers Dict[str, Tuple[str, str]]
                       {field_name: (app_label.ModelName, lookup_field)}
                       For each FK column the cell value is matched
                       against `lookup_field` (case-insensitive) on
                       the target model; the resolved id replaces the
                       cell value before validation. Missing lookups
                       produce a row-level error rather than crashing.

      import_address_fields  Iterable[str]
                       Names of JSONField address columns whose cell
                       contents must be parsed by `parse_address` before
                       being handed to the serializer. Accepts the
                       readable "Line | City | State | Pincode | Country"
                       format, raw JSON, or a free-text fallback.

      import_defaults  Dict[str, Any | Callable[[dict], Any]]
                       Values applied to a row when the corresponding
                       cell is blank. Used to keep imports compatible
                       with exports that omitted required-but-derivable
                       columns (e.g. product_type defaults to "GOODS"
                       so the user's exported sheets round-trip cleanly).
                       A value may be a callable instead of a literal —
                       it's called with the row's already-resolved
                       payload dict and its return value becomes the
                       default, e.g. deriving total_amount from a
                       subtotal cell the sheet did supply.

    Column label syntax:

        ('Product Type', 'product_type')               # single label
        (('Product Type', 'Type'), 'product_type')     # alias list
        'sku_code'                                     # bare → label == field

    The first label in an alias list becomes the column header in the
    downloaded template; every alias is recognised on upload.
    """
    import_columns = []
    import_fk_resolvers = {}
    import_address_fields = ()
    import_defaults = {}
    # Optional: declare ONE serializer field whose value uniquely
    # identifies a row across imports (e.g. 'sku_code' for Product,
    # 'vendor_code' for Vendor). When set, the importer no longer
    # silently fails on a unique-constraint collision with a
    # previously soft-deleted record. Instead it:
    #
    #   - looks up the existing row by this field,
    #   - if the match exists and is soft-deleted, reactivates it
    #     (is_active=True + active_flag=True) and updates its fields
    #     from the row payload via the serializer's update() path,
    #   - if the match exists and is ACTIVE, lets the normal unique
    #     validation surface "already exists" so the operator can
    #     fix the duplicate intentionally,
    #   - if no match exists, creates as usual.
    #
    # This is what makes a "soft delete → re-import" round-trip work
    # cleanly on every master that opts in.
    import_restore_on_match = ''

    # Optional: name a unique field for the LINE-AWARE import path that
    # makes a re-import UPSERT instead of erroring "already exists". When
    # a group's unique value (e.g. price_list_id) matches an existing
    # record — active OR soft-deleted — the parent serializer runs in
    # UPDATE mode: header fields are overwritten and the nested lines are
    # fully REPLACED (the serializer's update() deletes + recreates them).
    # This makes re-importing a corrected sheet idempotent, and repairs
    # rows created by earlier buggy imports (e.g. wrong customer link).
    # Leave blank to keep the create-only "already exists" behaviour.
    import_upsert_field = ''

    # Optional: declare child/subform rows to flatten into the export
    # sheet. When set, every parent row produces N output rows (one per
    # line), with the parent's cells repeated and each line's cells
    # appended to the right. Parents with no lines still emit a single
    # row so they're not silently dropped from the export.
    #
    #   export_line_relation  str — the reverse-accessor on the parent
    #                          (e.g. 'price_lines', 'so_lines').
    #   export_line_columns   list[(label, field)] — same shape as
    #                          import_columns. Bare strings allowed.
    #   export_line_fk_resolvers Dict[field, (app.Model, lookup|tuple)]
    #                          — emit a related obj's first non-empty
    #                          lookup field instead of the opaque id.
    export_line_relation = ''
    export_line_columns = []
    export_line_fk_resolvers = {}

    # Optional: line-aware import. When set, the importer expects the
    # flattened export format (parent cells repeated per line row) and
    # groups consecutive rows that share `import_parent_unique_field`
    # into one parent + N nested lines, then POSTs the combined payload
    # through the parent serializer (which must accept the nested write,
    # e.g. PriceListSerializer's `price_lines` field).
    #
    #   import_line_relation       str — write key on the serializer.
    #   import_line_columns        list[(label, field)] — same shape as
    #                               import_columns; matches the "Line "
    #                               prefixed headers the export emits.
    #   import_line_fk_resolvers   Dict[field, (app.Model, lookup|tuple)]
    #   import_parent_unique_field str — column that identifies the
    #                               parent across grouped rows (defaults
    #                               to the field of the first parent
    #                               column when blank).
    import_line_relation = ''
    import_line_columns = []
    import_line_fk_resolvers = {}
    import_parent_unique_field = ''

    # ─────────────────────────────────────────────────────────────
    # GET /import-template/
    # ─────────────────────────────────────────────────────────────
    @action(detail=False, methods=['get'], url_path='import-template')
    def import_template(self, request):
        if not self.import_columns:
            return Response(
                {'error': 'Import not configured for this resource.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        wb = Workbook()
        ws = wb.active
        ws.title = self.basename if hasattr(self, 'basename') else 'Import'

        # First row = column headers. Bold so the user can tell which
        # row to keep when filling the template. When a column declares
        # multiple alias labels, the FIRST one is used as the visible
        # header — it should be the most descriptive variant.
        def _primary_label(col):
            if isinstance(col, str):
                return col
            label, _field = col[0], col[1]
            if isinstance(label, (list, tuple)):
                return label[0]
            return label

        headers = [_primary_label(col) for col in self.import_columns]
        # When the ViewSet declared line-import columns, append them to
        # the template (with the "Line " prefix the export uses) so the
        # template matches the flattened format the importer accepts —
        # one row per line, parent cells repeated.
        if self.import_line_relation and self.import_line_columns:
            headers += [f'Line {_primary_label(col)}' for col in self.import_line_columns]
        ws.append(headers)
        for cell in ws[1]:
            cell.font = cell.font.copy(bold=True)

        # A reasonable default column width — enough for typical
        # field names without making the file enormous.
        for col_idx in range(1, len(headers) + 1):
            ws.column_dimensions[ws.cell(row=1, column=col_idx).column_letter].width = 22

        buf = BytesIO()
        wb.save(buf)
        buf.seek(0)

        entity = getattr(self, 'basename', 'master')
        resp = HttpResponse(
            buf.read(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        resp['Content-Disposition'] = f'attachment; filename="{entity}-import-template.xlsx"'
        return resp

    # ─────────────────────────────────────────────────────────────
    # GET /export/
    # ─────────────────────────────────────────────────────────────
    # Produces a clean XLSX using `import_columns` as the schema:
    #   - JSONField address columns (declared in `import_address_fields`)
    #     are flattened to the readable "Line | City | State | Pin | Country"
    #     pipe-string via format_address — so the export round-trips
    #     cleanly through the existing import endpoint.
    #   - FK columns (declared in `import_fk_resolvers`) emit the
    #     resolved object's first lookup field (legal_name, code, etc.)
    #     instead of the opaque UUID — so the file is human-readable.
    #   - All other columns emit the raw model attribute via getattr.
    #
    # Replaces the frontend DataTable's client-side stringify export,
    # which dumped JSONField cells as raw `{"line1": "..."}` strings.
    @action(detail=False, methods=['get', 'post'], url_path='export')
    def export_data(self, request):
        if not self.import_columns:
            return Response(
                {'error': 'Export not configured for this resource.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Use the same queryset the list endpoint uses (respects
        # soft-delete, show_all, etc.). When the client POSTs the ids of the
        # rows visible on the filtered list page, the export is scoped to
        # exactly those; a plain GET exports everything.
        qs = self.filter_queryset(self.get_queryset())
        entity = getattr(self, 'basename', None) or 'master'
        return build_export_xlsx_response(
            queryset=qs,
            parent_columns=self.import_columns,
            parent_fk_resolvers=self.import_fk_resolvers,
            parent_address_fields=self.import_address_fields,
            line_relation=self.export_line_relation,
            line_columns=self.export_line_columns,
            line_fk_resolvers=self.export_line_fk_resolvers,
            filename=f'{entity}-export',
            sheet_title=entity,
            ids=read_export_ids(request),
        )

    # ─────────────────────────────────────────────────────────────
    # POST /import/
    # ─────────────────────────────────────────────────────────────
    @action(
        detail=False,
        methods=['post'],
        url_path='import',
        parser_classes=[MultiPartParser, FormParser],
    )
    @transaction.atomic
    def import_bulk(self, request):
        if not self.import_columns:
            return Response(
                {'error': 'Import not configured for this resource.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        upload = request.FILES.get('file')
        if not upload:
            return Response(
                {'error': 'No file uploaded. Send the file under the "file" key.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            wb = load_workbook(filename=BytesIO(upload.read()), data_only=True, read_only=True)
        except Exception as exc:  # noqa: BLE001 — invalid file format
            return Response(
                {'error': f'Could not read Excel file: {exc}'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Pick the worksheet to import from. A workbook may bundle several
        # sheets (e.g. a factory template with "How to fill" / "BOM" /
        # "Process" / hidden reference tabs). Scan every sheet and use the
        # first whose header row contains THIS resource's key column (the
        # first declared import column — "Template Name" for BOM,
        # "Process Name" for Process) so the same file works on each
        # entity's Import button. Fall back to the active sheet otherwise.
        def _labels_of(col):
            if isinstance(col, str):
                return [col]
            raw = col[0]
            return list(raw) if isinstance(raw, (list, tuple)) else [raw]

        key_labels = _labels_of(self.import_columns[0])

        def _has_key_col(header):
            hl = list(header)
            return any(_header_lookup(hl, lbl) is not None for lbl in key_labels)

        ws = None
        header_row = None
        rows_iter = None
        for cand in wb.worksheets:
            cand_iter = cand.iter_rows(values_only=True)
            try:
                cand_header = next(cand_iter)
            except StopIteration:
                continue
            if cand_header is not None and _has_key_col(cand_header):
                ws, header_row, rows_iter = cand, cand_header, cand_iter
                break

        if ws is None:
            ws = wb.active
            rows_iter = ws.iter_rows(values_only=True)
            try:
                header_row = next(rows_iter)
            except StopIteration:
                return Response(
                    {'error': 'Excel file is empty.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # Build column-to-field map. Header names match
        # case-insensitively + ignoring spaces/underscores. A column
        # declaration may list multiple aliases — we try each label and
        # keep the first one that exists in the uploaded header row.
        header_list = list(header_row)

        def _build_col_map(columns, header_prefixes=('',)):
            """Map sheet-column index → serializer field for the given
            column declarations. Tries each declared alias optionally
            prefixed with one of `header_prefixes` (used to match the
            "Line " prefix the export emits on line columns)."""
            mapping = {}
            for col in columns:
                if isinstance(col, str):
                    labels, field = [col], col
                else:
                    raw_label, field = col[0], col[1]
                    labels = list(raw_label) if isinstance(raw_label, (list, tuple)) else [raw_label]
                for prefix in header_prefixes:
                    found = False
                    for label in labels:
                        idx = _header_lookup(header_list, f'{prefix}{label}')
                        if idx is not None:
                            mapping[idx] = field
                            found = True
                            break
                    if found:
                        break
            return mapping

        parent_col_to_field = _build_col_map(self.import_columns)
        # Line headers may appear EITHER as-is or with the "Line "
        # prefix the export emits. Try the prefixed form first so a
        # parent column and a line column that share a base label
        # (e.g. "Status") don't collide on the same sheet column.
        line_col_to_field = (
            _build_col_map(self.import_line_columns, header_prefixes=('Line ', ''))
            if self.import_line_relation and self.import_line_columns
            else {}
        )

        if not parent_col_to_field:
            def _primary(col):
                if isinstance(col, str):
                    return col
                label = col[0]
                return label[0] if isinstance(label, (list, tuple)) else label
            return Response(
                {
                    'error': 'Header row does not contain any expected columns. '
                             'Download the import template to see the correct columns.',
                    'expected_columns': [_primary(c) for c in self.import_columns],
                    'found_columns': [_clean(h) for h in header_row if h is not None],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Caches for _resolve_cell's three full-table-scan fallback paths,
        # scoped to THIS import request only (cleared implicitly when
        # import_bulk returns — never shared across requests). Before this,
        # every unresolved cell that reached one of these fallbacks re-ran
        # the same scan from scratch: a sheet with one bad column (e.g.
        # trailing-space Company names) meant one query PER ROW instead of
        # one query for the whole import. The underlying data can't change
        # mid-request (nothing here writes to the DB until every row has
        # been resolved), so caching for the request's lifetime is safe.
        _ws_scan_cache = {}     # (model, lookup, scope items) -> [(pk, raw_value), ...]
        _all_rows_cache = {}    # model -> list(model.objects.all())
        _pool_cache = {}        # (model, primary, scope items) -> [value, ...]

        def _nws(s):
            return ' '.join(str(s).split()).lower()

        # Per-cell resolution shared by parent + line rows. Returns
        # (parsed_value, error_message_or_None). Address-parsing only
        # applies to parent fields (lines don't currently carry addr
        # JSON), but we accept an `address_fields` arg for symmetry.
        def _resolve_cell(field, value, address_fields, fk_resolvers, scope_payload=None):
            if field in address_fields:
                try:
                    return parse_address(value), None
                except Exception as exc:  # noqa: BLE001
                    return None, f'Could not parse address: {exc}'
            if field in fk_resolvers:
                # A resolver spec is (model, lookups[, scope]). The
                # optional scope dict ({'scope_field', 'scope_attr'})
                # narrows candidates by another already-resolved FK on
                # the same row — e.g. a Customer cell resolves within
                # the row's Company, so two same-named customers under
                # different companies can never cross-match.
                spec = fk_resolvers[field]
                target_model, lookup_field = spec[0], spec[1]
                scope = spec[2] if len(spec) > 2 else None
                try:
                    app_label, model_name = target_model.split('.')
                    Model = apps.get_model(app_label, model_name)
                except (ValueError, LookupError):
                    return None, f'Configured target {target_model} not found on server.'
                lookups = (lookup_field,) if isinstance(lookup_field, str) else tuple(lookup_field)
                scope_kwargs = {}
                if scope and scope_payload:
                    scope_pk = scope_payload.get(scope['scope_field'])
                    if scope_pk:
                        scope_kwargs = {scope['scope_attr']: scope_pk}
                obj = None
                for lk in lookups:
                    obj = Model.objects.filter(**{f'{lk}__iexact': value}, **scope_kwargs).first()
                    if obj:
                        break
                if not obj:
                    # Whitespace-insensitive fallback. Master rows carry
                    # invisible spacing variants ("Limited -  North" with a
                    # double space, trailing spaces) that iexact can't see
                    # but the human filling the sheet can't either. Accept a
                    # collapsed-whitespace match when it's UNAMBIGUOUS.
                    #
                    # The (pk, raw value) list for this (Model, lookup,
                    # scope) is fetched once per import and reused for every
                    # cell that lands here — previously it was a fresh
                    # Model.objects.filter(...).values_list(...) PER CELL,
                    # so one sloppy column with trailing spaces meant one
                    # full-table scan per affected row instead of one for
                    # the whole sheet.
                    want = _nws(value)
                    for lk in lookups:
                        ck = (Model, lk, tuple(sorted(scope_kwargs.items())))
                        if ck not in _ws_scan_cache:
                            _ws_scan_cache[ck] = list(
                                Model.objects.filter(**scope_kwargs).values_list('pk', lk))
                        pks = {pk for pk, v in _ws_scan_cache[ck] if v and _nws(v) == want}
                        if len(pks) == 1:
                            obj = Model.objects.get(pk=pks.pop())
                            break
                        if len(pks) > 1:
                            names = list(Model.objects.filter(pk__in=list(pks)[:3])
                                         .values_list(lk, flat=True))
                            return None, (
                                f'"{value}" is ambiguous — {len(pks)} {model_name} rows '
                                f'differ only in spacing: {", ".join(repr(n) for n in names)}. '
                                f'Copy the exact value from the master.'
                            )
                if not obj and scope_kwargs:
                    # The value may exist under a DIFFERENT parent (e.g. a
                    # duplicate Company record) — say so explicitly, this
                    # is otherwise indistinguishable from a typo.
                    #
                    # The unscoped Model.objects.all() below is the single
                    # most expensive line in this function — every row whose
                    # scope resolution fails at least once re-scanned the
                    # ENTIRE table. Fetched once per Model per import instead.
                    elsewhere = None
                    for lk in lookups:
                        elsewhere = Model.objects.filter(**{f'{lk}__iexact': value}).first()
                        if not elsewhere:
                            if Model not in _all_rows_cache:
                                _all_rows_cache[Model] = list(Model.objects.all())
                            elsewhere = next(
                                (o for o in _all_rows_cache[Model]
                                 if _nws(getattr(o, lk, '') or '') == _nws(value)),
                                None,
                            )
                        if elsewhere:
                            break
                    if elsewhere is not None:
                        actual_parent = getattr(elsewhere, scope['scope_field'], None)
                        row_parent = None
                        try:
                            rel = Model._meta.get_field(scope['scope_field']).remote_field.model
                            row_parent = rel.objects.filter(
                                pk=scope_payload.get(scope['scope_field'])).first()
                        except Exception:  # noqa: BLE001
                            pass
                        return None, (
                            f'"{value}" exists in {model_name} master but under '
                            f'"{actual_parent}", while this row\'s '
                            f'{scope["scope_field"].capitalize()} column resolved to '
                            f'"{row_parent}". Fix the {scope["scope_field"].capitalize()} '
                            f'column, or move/merge the {model_name} record.'
                        )
                if not obj:
                    # Still nothing — name the closest existing values so
                    # the user can see the master's actual spelling instead
                    # of guessing.
                    import difflib
                    primary = lookups[0] if len(lookups) == 1 else (
                        'customer_name' if 'customer_name' in lookups
                        else 'product_name' if 'product_name' in lookups
                        else 'name' if 'name' in lookups else lookups[0])
                    pk = (Model, primary, tuple(sorted(scope_kwargs.items())))
                    if pk not in _pool_cache:
                        _pool_cache[pk] = [
                            v for v in Model.objects.filter(**scope_kwargs)
                            .values_list(primary, flat=True) if v
                        ]
                    pool = _pool_cache[pk]
                    close = difflib.get_close_matches(str(value), pool, n=3, cutoff=0.6)
                    hint = (' Closest existing: '
                            + ', '.join(f'"{c}"' for c in close)) if close else ''
                    return None, (
                        f'No {model_name} found matching "{value}" '
                        f'(tried {", ".join(lookups)}'
                        + (' under this row\'s '
                           f'{scope["scope_field"]}' if scope_kwargs else '')
                        + f'). Create it in master first, or fix the spelling.{hint}'
                    )
                return str(obj.pk), None
            return value, None

        def _row_payload(row, col_map, address_fields, fk_resolvers):
            """Resolve every populated cell in `row` according to
            `col_map`. Returns (payload_dict, row_errors_dict). Scoped
            FK cells resolve in a second pass so the field they scope
            by (e.g. company) is already in the payload."""
            payload, errs = {}, {}
            deferred = []
            for idx, field in col_map.items():
                if idx >= len(row):
                    continue
                value = _clean(row[idx])
                if value == '':
                    continue
                spec = fk_resolvers.get(field)
                if spec is not None and len(spec) > 2 and spec[2]:
                    deferred.append((field, value))
                    continue
                resolved, err = _resolve_cell(field, value, address_fields, fk_resolvers)
                if err is not None:
                    errs[field] = err
                else:
                    payload[field] = resolved
            for field, value in deferred:
                resolved, err = _resolve_cell(
                    field, value, address_fields, fk_resolvers, scope_payload=payload)
                if err is not None:
                    errs[field] = err
                else:
                    payload[field] = resolved
            return payload, errs

        created_count = 0
        updated_count = 0
        errors = []
        serializer_class = self.get_serializer_class()

        # ── Line-aware path ────────────────────────────────────────
        # When the ViewSet declared `import_line_relation`, group
        # consecutive rows that share the parent's unique key into
        # ONE parent + nested line payloads. The parent serializer
        # must accept the nested-write list (e.g. PriceListSerializer
        # accepts `price_lines`); we just feed it the right shape.
        if self.import_line_relation and line_col_to_field:
            line_rel = self.import_line_relation
            # Pick the column that identifies "same parent across rows".
            # Defaults to the first parent field — works for masters
            # whose first column is the human-readable unique id
            # (price_list_id, sku_code, etc.).
            unique_field = self.import_parent_unique_field or (
                self.import_columns[0] if isinstance(self.import_columns[0], str)
                else self.import_columns[0][1]
            )
            address_set = set(self.import_address_fields or ())

            groups = []  # list of {'unique': str, 'parent': dict, 'lines': [dict, ...], 'rows': [int, ...], 'errors': [...]}
            current = None

            for row_num, row in enumerate(rows_iter, start=2):
                if row is None or not any(_clean(c) for c in row):
                    continue  # blank row — ignore (don't reset the group)

                parent_payload, parent_errs = _row_payload(
                    row, parent_col_to_field, address_set,
                    self.import_fk_resolvers or {},
                )
                line_payload, line_errs = _row_payload(
                    row, line_col_to_field, set(),
                    self.import_line_fk_resolvers or {},
                )

                # Determine whether this row starts a NEW parent or
                # contributes a line to the current one. We compare
                # the RAW cell value of the unique column rather than
                # the resolved payload — so two rows that share
                # "PL-001" group together even before FK resolution.
                raw_unique = ''
                for idx, field in parent_col_to_field.items():
                    if field == unique_field and idx < len(row):
                        raw_unique = _clean(row[idx])
                        break

                if current is None or (raw_unique and raw_unique != current['unique']):
                    if current is not None:
                        groups.append(current)
                    current = {
                        'unique': raw_unique,
                        'parent': parent_payload,
                        'lines': [],
                        'rows': [row_num],
                        'errors': [],
                    }
                    if parent_errs:
                        current['errors'].append({'row': row_num, 'errors': parent_errs})
                else:
                    current['rows'].append(row_num)
                    # Only the FIRST row in a group seeds parent fields;
                    # later rows may leave parent cells blank (or repeat
                    # them) — we don't overwrite the seed even if they
                    # differ. Per-row line-only errors still surface.

                if line_errs:
                    current['errors'].append({'row': row_num, 'errors': line_errs})
                # Skip empty line payloads — a sheet with parent-only
                # rows (no line cells filled) means "create the parent
                # without lines" rather than "import an empty line".
                if line_payload:
                    current['lines'].append(line_payload)

            if current is not None:
                groups.append(current)

            for grp in groups:
                first_row = grp['rows'][0]
                if grp['errors']:
                    errors.extend(grp['errors'])
                    continue

                payload = dict(grp['parent'])
                for field_name, default_value in self.import_defaults.items():
                    if not payload.get(field_name):
                        payload[field_name] = default_value(payload) if callable(default_value) else default_value
                if grp['lines']:
                    payload[line_rel] = grp['lines']

                # Upsert: when the ViewSet opts in, an existing record with
                # this unique value is UPDATED (header + lines replaced)
                # rather than colliding on "already exists". Reactivate a
                # soft-deleted match first so the update isn't seen as a
                # deactivated row mid-write.
                existing = None
                upsert_field = self.import_upsert_field
                if upsert_field and payload.get(upsert_field):
                    model_cls = getattr(serializer_class.Meta, 'model', None)
                    if model_cls is not None:
                        existing = model_cls.objects.filter(
                            **{upsert_field: payload[upsert_field]}).first()
                    if existing is not None:
                        reactivate = []
                        if getattr(existing, 'is_active', True) is False:
                            existing.is_active = True
                            reactivate.append('is_active')
                        if getattr(existing, 'active_flag', True) is False:
                            existing.active_flag = True
                            reactivate.append('active_flag')
                        if reactivate:
                            existing.save(update_fields=reactivate + ['updated_at'])

                if existing is not None:
                    serializer = serializer_class(
                        instance=existing, data=payload, partial=True,
                        context={'request': request})
                else:
                    serializer = serializer_class(data=payload, context={'request': request})

                if serializer.is_valid():
                    try:
                        with transaction.atomic():
                            serializer.save()
                        if existing is not None:
                            updated_count += 1
                        else:
                            created_count += 1
                    except Exception as exc:  # noqa: BLE001
                        errors.append({'row': first_row, 'errors': {'__all__': str(exc)[:300]}})
                else:
                    errors.append({'row': first_row, 'errors': serializer.errors})

        else:
            # ── Original simple path: one row → one serializer save. ──
            for row_num, row in enumerate(rows_iter, start=2):
                if row is None or not any(_clean(c) for c in row):
                    continue

                payload, row_errors = _row_payload(
                    row, parent_col_to_field,
                    set(self.import_address_fields or ()),
                    self.import_fk_resolvers or {},
                )

                if row_errors:
                    errors.append({'row': row_num, 'errors': row_errors})
                    continue

                for field_name, default_value in self.import_defaults.items():
                    if not payload.get(field_name):
                        payload[field_name] = default_value(payload) if callable(default_value) else default_value

                # Restore-on-match: when the ViewSet declares a unique
                # field (e.g. sku_code), look up an existing instance
                # by that field. If it exists and is soft-deleted,
                # reactivate + update via the serializer's update path.
                # Active duplicates still surface the normal "already
                # exists" error so the operator sees the conflict.
                existing_instance = None
                match_field = self.import_restore_on_match
                if match_field and payload.get(match_field):
                    try:
                        model_cls = serializer_class.Meta.model
                    except AttributeError:
                        model_cls = None
                    if model_cls is not None:
                        existing_instance = (
                            model_cls.objects
                            .filter(**{match_field: payload[match_field]})
                            .first()
                        )
                        # Only an inactive row gets the restore path —
                        # an active row should report "already exists".
                        is_inactive = existing_instance is not None and (
                            getattr(existing_instance, 'is_active', True) is False
                            or getattr(existing_instance, 'active_flag', True) is False
                        )
                        if existing_instance is not None and not is_inactive:
                            existing_instance = None

                if existing_instance is not None:
                    # Reactivate before validation so the serializer
                    # doesn't see the row as deactivated mid-update.
                    update_fields = []
                    if hasattr(existing_instance, 'is_active'):
                        existing_instance.is_active = True
                        update_fields.append('is_active')
                    if hasattr(existing_instance, 'active_flag'):
                        existing_instance.active_flag = True
                        update_fields.append('active_flag')
                    if update_fields:
                        existing_instance.save(
                            update_fields=update_fields + ['updated_at'],
                        )
                    serializer = serializer_class(
                        instance=existing_instance, data=payload, partial=True,
                        context={'request': request},
                    )
                else:
                    serializer = serializer_class(data=payload, context={'request': request})

                if serializer.is_valid():
                    try:
                        with transaction.atomic():
                            serializer.save()
                        created_count += 1
                    except Exception as exc:  # noqa: BLE001
                        errors.append({'row': row_num, 'errors': {'__all__': str(exc)[:300]}})
                else:
                    errors.append({'row': row_num, 'errors': serializer.errors})

        # All-or-nothing: if ANY row failed, mark the outer atomic block
        # (decorator on this method) for rollback so the operator never
        # has to clean up "half-imported" rows that the old per-row
        # commit behaviour left behind. Successful rows that were saved
        # earlier in this request are reverted on method return.
        if errors:
            transaction.set_rollback(True)
            created_count = 0  # reflect the rollback in the response
            updated_count = 0

        return Response({
            'created': created_count,
            'updated': updated_count,
            'failed': len(errors),
            'total_rows': created_count + updated_count + len(errors),
            'errors': errors[:200],  # cap so a giant broken file doesn't return MB of JSON
        }, status=status.HTTP_200_OK)
