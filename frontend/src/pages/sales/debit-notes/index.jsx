import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import MainLayout from '../../../components/layout/MainLayout';
import BackToModule from '../../../components/common/BackToModule';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import useApiData from '../../../hooks/useApiData.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

const TYPE_TABS = [
  { key: '', label: 'All' },
  { key: 'DEBIT', label: 'Debit Notes' },
  { key: 'CREDIT', label: 'Credit Notes' },
];
const SIDE_TABS = [
  { key: '', label: 'All Parties' },
  { key: 'SALES', label: 'Customers' },
  { key: 'PURCHASE', label: 'Vendors' },
];
// `kind` comes from the API (backend/apps/sales/note_kinds.py classifies the
// reason text). Tally's Debit/Credit Note registers hold trade documents;
// journals, TDS withholdings and bank charges reached this table by other
// import paths, and being able to set them aside is the difference between a
// notes list you can reconcile and one you can't.
const KIND_TABS = [
  { key: '', label: 'All kinds', hint: 'Every note, whatever it is' },
  { key: 'trade', label: 'Trade',
    hint: 'Sales adjustments, freight billed on, returns, discounts — what a debit/credit note is meant to be' },
  { key: 'adjustment', label: 'Journal / TDS',
    hint: 'Journals, TDS/TCS, bank charges, contras, round-offs — ledger movements, not trading documents' },
  { key: 'other', label: 'Unclassified',
    hint: 'Reason is blank or matches no known pattern' },
];
const KIND_BADGE = {
  trade: 'bg-slate-100 text-slate-600',
  adjustment: 'bg-amber-100 text-amber-800',
  other: 'bg-violet-100 text-violet-800',
};

export default function DebitNoteList() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading, error, refetch } = useApiData('/api/sales/debit-notes/');
  // Honour a ?type=DEBIT|CREDIT deep-link (e.g. from the Sales Analytics note
  // tiles) so the list opens on the respective tab; ignore anything else.
  const initialType = ['DEBIT', 'CREDIT'].includes((searchParams.get('type') || '').toUpperCase())
    ? searchParams.get('type').toUpperCase()
    : '';
  const [type, setType] = useState(initialType);
  const [side, setSide] = useState(searchParams.get('side') || '');
  // Honour ?kind=trade|adjustment|other too, so the analytics tiles can deep-link
  // straight to "show me the journals".
  const initialKind = ['trade', 'adjustment', 'other'].includes((searchParams.get('kind') || '').toLowerCase())
    ? searchParams.get('kind').toLowerCase()
    : '';
  const [kind, setKind] = useState(initialKind);
  const [page, setPage] = useState(Number(searchParams.get('page')) || 1);
  const [sortBy, setSortBy] = useState(searchParams.get('sort') || 'note_date');
  const [sortOrder, setSortOrder] = useState(searchParams.get('dir') || 'desc');
  const [search, setSearch] = useState(searchParams.get('q') || '');

  // Write the controls back into the address. Without this the page READ the
  // URL but never updated it, so switching to the Debit Notes tab, opening a
  // note and pressing Back landed you on the Credit tab again -- the address
  // still said what you arrived with, not what you were looking at.
  // `replace: true`: changing a tab or a sort is not a destination, and must
  // not add a history entry for Back to get stuck on.
  // The page's own period filter -- separate from the inherited scope above,
  // which comes from whichever dashboard tile opened this list. Seeded from
  // the address like the rest of the controls.
  const period = usePeriodFilter(searchParams.get('period') || 'all', {
    anchor: searchParams.get('anchor'),
    customFrom: searchParams.get('cfrom'),
    customTo: searchParams.get('cto'),
  });

  useEffect(() => {
    const p = new URLSearchParams(searchParams);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    put('type', type, !!type);
    put('side', side, !!side);
    put('kind', kind, !!kind);
    put('q', search, !!search.trim());
    put('sort', sortBy, sortBy !== 'note_date');
    put('dir', sortOrder, sortOrder !== 'desc');
    put('page', String(page), page > 1);
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    const next = p.toString();
    if (next !== searchParams.toString()) setSearchParams(p, { replace: true });
  }, [type, side, kind, search, sortBy, sortOrder, page, period.navProps, searchParams, setSearchParams]);

  // Scope inherited from wherever this list was opened from -- the Sales
  // Analytics note tiles pass the window and company they were showing, so the
  // count here matches the tile you clicked instead of jumping to every note
  // ever raised. Read straight from the URL (not state) so a refresh, a
  // bookmark and Back all reproduce the same list.
  const scopeFrom = searchParams.get('from') || '';
  const scopeTo = searchParams.get('to') || '';
  const scopeCompany = searchParams.get('company') || '';
  const scopeCustomer = searchParams.get('customer') || '';
  const scoped = !!(scopeFrom || scopeTo || scopeCustomer);

  // Refresh when the tab comes back to the foreground. Notes are created by
  // the Tally import, not here, so the one moment this page can be stale is
  // while it sits open during an import somewhere else -- and returning to it
  // is exactly when you would want to see the result. `refetch` forces past
  // the 5s cache. No timer: polling a page nobody is looking at would send
  // requests forever, and this list is one of the heavier ones.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') refetch(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [refetch]);

  const rows = useMemo(() => (Array.isArray(data) ? data : (data?.results || [])), [data]);

  // Companies that actually have notes, taken from the rows rather than from
  // the company master -- a company with nothing raised against it is not
  // worth offering.
  const companyOptions = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (r.company && !m.has(String(r.company))) m.set(String(r.company), r.company_name || '—');
    }
    return [...m.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  // The inherited scope, applied before any of the page's own controls. Dates
  // compare as plain ISO strings because note_date is a plain date -- no
  // timezone is involved and none should be introduced.
  const inScope = useMemo(() => {
    let r = rows;
    if (scopeFrom) r = r.filter((x) => (x.note_date || '') >= scopeFrom);
    if (scopeTo) r = r.filter((x) => (x.note_date || '') <= scopeTo);
    if (scopeCompany) r = r.filter((x) => String(x.company) === String(scopeCompany));
    if (scopeCustomer) r = r.filter((x) => String(x.customer) === String(scopeCustomer));
    r = r.filter((x) => period.match(x.note_date));
    return r;
  }, [rows, scopeFrom, scopeTo, scopeCompany, scopeCustomer, period]);

  const filtered = useMemo(() => {
    let r = inScope;
    if (type) r = r.filter((x) => x.note_type === type);
    if (side) r = r.filter((x) => x.side === side);
    if (kind) r = r.filter((x) => (x.kind || 'other') === kind);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter((x) =>
        [x.note_no, x.party_name, x.reason, x.reference]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(q)));
    }
    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...r].sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy];
      if (sortBy === 'amount') return (Number(av) - Number(bv)) * dir;
      return String(av || '').localeCompare(String(bv || '')) * dir;
    });
  }, [inScope, type, side, kind, search, sortBy, sortOrder]);

  // Per-kind counts and money for the pill row. Computed over everything the
  // OTHER filters leave standing, so each pill answers "what would I get if I
  // clicked this?" — a count that changed as you clicked between kinds would
  // be useless for deciding which to click.
  const kindStats = useMemo(() => {
    let r = inScope;
    if (type) r = r.filter((x) => x.note_type === type);
    if (side) r = r.filter((x) => x.side === side);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter((x) => [x.note_no, x.party_name, x.reason, x.reference]
        .filter(Boolean).some((f) => String(f).toLowerCase().includes(q)));
    }
    const out = { '': { count: r.length, amount: 0 } };
    for (const x of r) {
      const k = x.kind || 'other';
      // Debit adds to what the party owes, credit reduces it — a single
      // signed figure is the only one that means anything across a mixed set.
      const signed = Number(x.amount || 0) * (x.note_type === 'CREDIT' ? -1 : 1);
      out[''].amount += signed;
      if (!out[k]) out[k] = { count: 0, amount: 0 };
      out[k].count += 1;
      out[k].amount += signed;
    }
    return out;
  }, [inScope, type, side, search]);

  // Guard against a stranded Kind filter: when the selected kind has nothing
  // under the current tab/party/search, its pill vanishes (hidden at 0 count)
  // and the table would look empty with no way back — so fall back to "All
  // kinds" automatically. e.g. switching to Credit Notes while "Journal / TDS"
  // is selected (which has debit notes only) used to show a blank table.
  useEffect(() => {
    if (kind && !kindStats[kind]) setKind('');
  }, [kind, kindStats]);

  // Totals for the currently-filtered view.
  const totals = useMemo(() => {
    const debit = filtered.filter((x) => x.note_type === 'DEBIT')
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    const credit = filtered.filter((x) => x.note_type === 'CREDIT')
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    return { debit, credit };
  }, [filtered]);

  const columns = [
    { field: 'note_no', header: 'Note No', sortable: true, width: '140px' },
    { field: 'note_date', header: 'Date', sortable: true, width: '110px', render: (v) => formatDate(v) },
    // Which of the two companies raised the note. The API has always returned
    // it; the table simply never showed it, so SS Biochem and United Agro rows
    // sat together with nothing to tell them apart.
    {
      field: 'company_name', header: 'Company', sortable: true, width: '150px',
      render: (v) => <span className="text-slate-500 text-xs">{v || '—'}</span>,
    },
    {
      field: 'note_type', header: 'Type', sortable: true, width: '110px',
      render: (v) => (
        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
          v === 'DEBIT' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {v === 'DEBIT' ? 'Debit' : 'Credit'}
        </span>
      ),
    },
    {
      field: 'side', header: 'Party Type', sortable: true, width: '110px',
      render: (v) => (v === 'PURCHASE' ? 'Vendor' : 'Customer'),
    },
    { field: 'party_name', header: 'Party', sortable: true, width: '220px', render: (v) => v || '-' },
    {
      field: 'kind', header: 'Kind', sortable: true, width: '120px',
      render: (v) => {
        const t = KIND_TABS.find((k) => k.key === (v || 'other'));
        return (
          <span title={t?.hint}
            className={`px-2 py-0.5 rounded text-xs font-semibold ${KIND_BADGE[v] || KIND_BADGE.other}`}>
            {t?.label || 'Unclassified'}
          </span>
        );
      },
    },
    { field: 'reason', header: 'Reason', sortable: false, width: '220px', render: (v) => v || '-' },
    { field: 'reference', header: 'Against Ref', sortable: false, width: '130px',
      render: (v, row) => row?.reference_link
        ? <Link to={row.reference_link.path} onClick={(e) => e.stopPropagation()} className="text-indigo-600 hover:underline">{v}</Link>
        : (v || '-') },
    {
      field: 'amount', header: 'Amount', sortable: true, width: '130px',
      render: (v, row) => (
        <span className={`font-semibold ${row.note_type === 'DEBIT' ? 'text-rose-700' : 'text-emerald-700'}`}>
          {formatCurrency(v)}
        </span>
      ),
    },
  ];

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <BackToModule />
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                <FileText size={20} className="text-blue-600" /> Debit &amp; Credit Notes
              </h1>
              <p className="text-sm text-slate-500">
                Customer and vendor debit/credit notes — freight charges, returns, discounts
                (auto-synced from Tally Debit/Credit Note vouchers).
              </p>
            </div>
          </div>
        </div>

        {/* A narrowed list must SAY it is narrowed. Arriving from a dashboard
            tile and silently seeing fewer notes than the page holds reads as
            missing data, which is worse than the problem this scope solves.
            The clear button drops only the inherited scope -- the page's own
            type / kind / search controls are left exactly as they are. */}
        {scoped && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-900">
            <span className="font-semibold">Showing the notes behind the figure you clicked</span>
            {(scopeFrom || scopeTo) && (
              <span className="tabular-nums">{scopeFrom || '…'} → {scopeTo || '…'}</span>
            )}
            {scopeCustomer && <span>· one customer</span>}
            <button type="button"
              onClick={() => {
                const qp = new URLSearchParams(searchParams);
                // `company` is deliberately NOT cleared here: it is the
                // page's own filter now, shown in its own dropdown, and
                // clearing it from this banner would move a control the
                // banner does not mention.
                ['from', 'to', 'customer'].forEach(k => qp.delete(k));
                setSearchParams(qp, { replace: true });
              }}
              className="ml-auto underline font-medium hover:text-indigo-700">
              Show all notes
            </button>
          </div>
        )}

        {/* Summary chips */}
        <div className="flex flex-wrap gap-3">
          <div className="px-4 py-2 rounded-lg bg-rose-50 border border-rose-100">
            <div className="text-xs text-rose-600 font-medium">Debit total</div>
            <div className="text-lg font-bold text-rose-700">{formatCurrency(totals.debit)}</div>
          </div>
          <div className="px-4 py-2 rounded-lg bg-emerald-50 border border-emerald-100">
            <div className="text-xs text-emerald-600 font-medium">Credit total</div>
            <div className="text-lg font-bold text-emerald-700">{formatCurrency(totals.credit)}</div>
          </div>
          <div className="px-4 py-2 rounded-lg bg-slate-50 border border-slate-200">
            <div className="text-xs text-slate-500 font-medium">Notes</div>
            <div className="text-lg font-bold text-slate-700">{filtered.length}</div>
          </div>
        </div>

        {/* One filter row: when, then the three choices that used to be three
            separate strips of pills. The Kind option labels keep the count and
            the net value each pill carried, so the size of what you would be
            excluding is still visible before you exclude it. A kind with
            nothing in it is still left out rather than offered as a dead
            zero. */}
        <div className="flex flex-wrap items-center gap-2">
          <PeriodNavigator allowAll {...period.navProps} />

          <CustomSelect value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}
            title="Debit or credit"
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[200px]">
            {TYPE_TABS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </CustomSelect>

          <CustomSelect value={side} onChange={(e) => { setSide(e.target.value); setPage(1); }}
            title="Party type"
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[200px]">
            {SIDE_TABS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </CustomSelect>

          <CustomSelect value={scopeCompany}
            onChange={(e) => {
              const qp = new URLSearchParams(searchParams);
              if (e.target.value) qp.set('company', e.target.value); else qp.delete('company');
              setSearchParams(qp, { replace: true });
              setPage(1);
            }}
            title="Company"
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[220px]">
            <option value="">All Companies</option>
            {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>

          <CustomSelect value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}
            title={type
              ? 'Total for each kind, within the filters here'
              : 'Net for each kind, within the filters here — debit notes less credit notes'}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[280px]">
            {KIND_TABS.filter((t) => !t.key || kindStats[t.key]).map((t) => {
              const st = kindStats[t.key] || { count: 0, amount: 0 };
              return (
                <option key={t.key} value={t.key}>
                  {`${t.label} · ${st.count} · ${formatCurrency(st.amount)}`}
                </option>
              );
            })}
          </CustomSelect>

          {period.range && (
            <button type="button" className="text-xs text-slate-500 hover:text-slate-800 underline"
              onClick={() => period.navProps.setPeriod('all')}>
              Clear period
            </button>
          )}
        </div>

        <ListState isLoading={isLoading} error={error} onRetry={refetch}>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable
              columns={columns}
              data={filtered}
              isLoading={isLoading}
              page={page}
              pageSize={15}
              totalRecords={filtered.length}
              onPageChange={setPage}
              onSort={(f, o) => { setSortBy(f); setSortOrder(o); }}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSearch={setSearch}
              searchPlaceholder="Search by note no, party, reason or reference..."
              /* A row opens THAT note. It used to navigate to /sales/invoices
                 or /sales/bills -- the entire invoice or bill list, with no
                 filter and no connection to the note clicked. backTo carries
                 this page's full URL, query string included, so Back returns
                 to the same tab, kind and filters. */
              onRowClick={(row) => row.id && navigate(`/sales/debit-notes/${row.id}`,
                { state: { backTo: `${location.pathname}${location.search}` } })}
              emptyMessage="No debit or credit notes yet"
              emptyIcon={FileText}
              emptyHint="They appear here after a Tally import (Debit/Credit Note vouchers)."
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
