"""Answer a question once per RESPONSE instead of once per row.

THE SHAPE OF THE BUG THIS EXISTS FOR
------------------------------------
A serializer field reaches for something that does not vary much:

    def get_godowns_detail(self, obj):
        ids = obj.godown_ids or []
        return list(Godown.objects.filter(id__in=ids).values('id', 'godown_name'))

Read that on one record and it is a single query. Read it on a list page and it
is one query PER ROW - and the table it is reading usually has a handful of
rows in it. Measured on production: Purchase Requests ran this 149 times
against a Godown table of 19, in one response.

The same shape turns up in HR (companies, locations, godowns per staff row),
and will turn up again, because it reads perfectly sensibly one record at a
time.

HOW THIS HELPS
--------------
DRF's `.context` is the ROOT serializer's dict, so every serializer in one
response - parent and nested line alike - sees the same object. Anything parked
there is computed once for the whole response and thrown away with it.

    from common.serializer_cache import lookup_map

    def get_godowns_detail(self, obj):
        names = lookup_map(self, Godown, 'id', 'godown_name')
        return [{'id': str(i), 'name': names[str(i)]}
                for i in (obj.godown_ids or []) if str(i) in names]

ONLY FOR SMALL, SLOW-MOVING TABLES
----------------------------------
`lookup_map` reads the WHOLE table once. That is right for companies (3),
warehouses (12), godowns (19) and the like, and wrong for anything that grows
with transactions. There is a guard: past `MAX_ROWS` it refuses and returns
None, so the caller falls back to its own query rather than quietly loading a
hundred thousand rows into memory. The limit is deliberately low - if a table
is big enough to trip it, this is the wrong tool for it.

The cache lives for ONE response and is never shared between requests, so a
master edited a second ago shows up on the very next page load.
"""
MAX_ROWS = 2000


def ctx_store(serializer, bucket):
    """A dict shared by every serializer in this one response.

    Tested with isinstance, not truthiness: an empty context is a perfectly
    good - and very common - dict, and `if ctx` would hand back a throwaway,
    turning the memo into a no-op that looks like it works.
    """
    ctx = getattr(serializer, 'context', None)
    return ctx.setdefault(bucket, {}) if isinstance(ctx, dict) else {}


def lookup_map(serializer, model, key_field, *value_fields):
    """{str(key): value} for a whole small table, read once per response.

    One value field gives a flat map; several give a dict per row. Returns None
    when the table is too big to be read this way - the caller must then do what
    it did before, rather than get a wrong answer.
    """
    bucket = '_map_%s_%s_%s' % (model._meta.label, key_field, ','.join(value_fields))
    store = ctx_store(serializer, bucket)
    if store:
        return store.get('m')

    qs = model._default_manager.all()
    try:
        if qs.count() > MAX_ROWS:
            store['m'] = None
            return None
        rows = qs.values(key_field, *value_fields)
        if len(value_fields) == 1:
            m = {str(r[key_field]): r[value_fields[0]] for r in rows}
        else:
            m = {str(r[key_field]): {f: r[f] for f in value_fields} for r in rows}
    except Exception:           # noqa: BLE001 - never break a response over a memo
        m = None
    store['m'] = m
    return m


def page_pks(serializer):
    """Primary keys of every object in THIS response, or None when unknown.

    `serializer.root` is the ListSerializer DRF wraps a page in, and its
    `.instance` is the page itself - so a figure that was being fetched once per
    row can be fetched once per page instead.

    Returns None rather than guessing when there is no list to read: a detail
    route, a create or update response. Every caller must then fall back to the
    single-object query it ran before, so the answer is never wrong - only the
    number of round trips changes.
    """
    inst = getattr(getattr(serializer, 'root', None), 'instance', None)
    if inst is None:
        return None
    if hasattr(inst, 'pk'):
        return [inst.pk]
    try:
        return [o.pk for o in inst]
    except Exception:           # noqa: BLE001 - not a list we can read
        return None


def root_objects(serializer):
    """The objects THIS response is being built from, or None when unknown.

    Same idea as page_pks, but hands back the objects rather than their keys -
    needed when the figure to pre-compute lives on their CHILDREN. A nested line
    serializer sees the parent page here (its `.root` is the parent's
    ListSerializer), so it can gather every line on the page and ask about all
    of them at once.

    Returns None on a detail, create or update response, where there is no page
    to read; the caller must then do exactly what it did before.
    """
    inst = getattr(getattr(serializer, 'root', None), 'instance', None)
    if inst is None:
        return None
    if hasattr(inst, 'pk'):
        return [inst]
    try:
        return list(inst)
    except Exception:           # noqa: BLE001 - not a list we can read
        return None
