import { confirm } from '@/components/common/confirm';
import CustomSelect from "@/components/ui/CustomSelect";
import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronDown, Plus, Pencil, Eye, Trash2, Settings2, GitBranch, Truck, X, CheckCircle2, Clock, Search, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import BackToModule from '../../../components/common/BackToModule';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import StatusBadge from '../../../components/common/StatusBadge';
import MobileListCards from '../components/MobileListCards';
import { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_H } from '@/components/common/controls';

// A multi-select from the old filter panel is stored as an array; a single
// picker can only honestly show one value, so anything else reads blank.
const pickOf = (v) => (Array.isArray(v) ? (v.length === 1 ? v[0] : '') : (v || ''));
import { useConfigureFields } from '../../../components/common/ConfigureFields';
import ExpandableLines, { SO_LINE_COLUMNS, SO_EXPORT_LINES } from '../../../components/common/ExpandableLines';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import { exportServerSide } from '../../../utils/exportExcel.js';
import useLookup from '../../../hooks/useLookup.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import ListAttachments, { useListAttachments } from '../components/ListAttachments';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

export default function SalesOrderList() {
  const navigate = useNavigate();
  // ?dc=<soId> in the URL auto-opens the Create-DC modal for that SO —
  // used by the Sales Order detail page's "Create Dispatch Challan"
  // button (which lights up only once the Factory Stock Check matrix
  // has Remaining=0 on every line). Reading the param via the router
  // hook so a manual paste of the URL works too.
  const [searchParams, setSearchParams] = useSearchParams();
  const { canCreate, canEdit, canDelete, canExport, canCreateDc, canView, isLoading: isLoadingPerms } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Order');
  // Dedicated single-tick Create-DC gate. Matches the detail page —
  // both surfaces read can_create_dc on the Sales Order row in the
  // admin grid. Backend CreateDispatchChallanPermission honors this
  // flag too, so one tick = button visible AND save succeeds.
  const canCreateDC = canCreateDc('Sales Order');
  // Flow Dashboard shortcut. Reuses the existing View permission on
  // the Sales Flow Dashboard module — same flag the sidebar entry
  // already checks. Admins control this from the Page Permissions
  // tab → Sales Flow Dashboard row → View column. One tick hides the
  // sidebar entry, the page itself, AND the row-action Flow icon.
  const canSeeFlow = canView('Sales Flow Dashboard');
  const { data, isLoading, error, refetch } = useApiData('/api/sales/orders/');
  // Same arrangement as Sales Invoices and Dispatch Challans: the filters live
  // in the address, so opening an order and pressing Back brings the list back
  // exactly as it was.
  const period = usePeriodFilter(searchParams.get('period') || 'all', {
    anchor: searchParams.get('anchor'),
    customFrom: searchParams.get('cfrom'),
    customTo: searchParams.get('cto'),
  });
  const [page, setPage] = useState(() => Math.max(1, parseInt(searchParams.get('page'), 10) || 1));
  const [sortBy, setSortBy] = useState(searchParams.get('sort') || 'so_date');
  const [sortOrder, setSortOrder] = useState(searchParams.get('dir') || 'asc');   // oldest first (Apr 1 → today)
  const [searchTerm, setSearchTerm] = useState(searchParams.get('q') || '');
  const [activeFilters, setActiveFilters] = useState(() => {
    const f = {};
    if (searchParams.get('company')) f.company_name = searchParams.get('company');
    if (searchParams.get('customer')) f.customer_name = searchParams.get('customer');
    return f;
  });
  const [fieldsOpen, setFieldsOpen] = useState(false);   // Fields dropdown
  const [advancedRules, setAdvancedRules] = useState([]);
  const [advancedLogic, setAdvancedLogic] = useState('AND');
  // Categorisation of post-approval SOs: '' = no filter, 'pending' =
  // approved-but-not-yet-acknowledged, 'acknowledged' = factory has
  // claimed the stock-check sheet. Drives the two chip buttons above
  // the data table.
  const [ackFilter, setAckFilter] = useState(searchParams.get('ack') || '');
  const { openFlow, FlowPopup } = useFlowDashboard();
  const { attachmentMap } = useListAttachments('SALES_ORDER');

  // Create DC modal state
  // `delivery_terms` is hydrated from the SO when the modal opens. When
  // it equals 'EX_FACTORY' the customer collects at the gate, so we
  // never bill freight on the DC — Transporter / Freight Type / per-line
  // Freight Rate are hidden and their validation is skipped.
  // For Ex-Factory delivery, transporter doesn't apply (customer's own
  // vehicle / driver collects at the gate). Capture driver_name and
  // driver_phone instead so the DC record still identifies who actually
  // hauled the goods. Both default to '' and are only sent to the API
  // when Ex-Factory.
  const [dcModal, setDcModal] = useState({ open: false, soId: null, soNo: '', lines: [], warehouse: '', lorry_no: '', transporter: '', freight_type: '', destination: '', delivery_terms: '', driver_name: '', driver_phone: '', godown: '', useSameGodown: false, isCreating: false });
  const [dcPendingAttachments, setDcPendingAttachments] = useState([]);
  const { options: transporterOptions } = useLookup('/api/transporters/');
  // Warehouse-scoped godown lookup for the inline Create-DC modal.
  // Backend filters by `?warehouse=<id>` via DjangoFilterBackend, so
  // we trust that and use the options directly — an earlier defensive
  // client-side filter (comparing `g.warehouse` to `dcModal.warehouse`)
  // ended up rejecting every row whenever the two values were
  // serialised differently (e.g. UUID vs nested-obj), leaving the
  // dropdown empty even when the API had returned real godowns.
  const { options: godownOptions } = useLookup(
    dcModal.warehouse ? `/api/godowns/?warehouse=${dcModal.warehouse}` : null
  );

  // ── Packing-size inference for No-of-bags auto-calc ─────────────
  // Parses the per-pack quantity out of the product name (e.g.
  // "EMP-BUCKET-5 KG" → { value: 5, unit: 'KG' }) so we can divide
  // the dispatch quantity by it and pre-fill the "No. of bags"
  // column. First match wins, so "1 KG Pouch in 50 KG Bag" picks the
  // pouch size — that's the unit the warehouse counts in. The user
  // can always override the auto-filled number if they want.
  const _parsePacking = (productName) => {
    const re = /(\d+(?:\.\d+)?)\s*(KGS?|KILOGRAMS?|GMS?|GRAMS?|ML|MILLILITRES?|LTR?S?|LITRE?S?|TONS?|TONNES?|MTS?)\b/i;
    const m = (productName || '').match(re);
    if (!m) return null;
    const value = parseFloat(m[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const raw = m[2].toUpperCase();
    let unit = raw;
    if (/^(KGS?|KILOGRAMS?)$/i.test(raw))         unit = 'KG';
    else if (/^(GMS?|GRAMS?)$/i.test(raw))        unit = 'G';
    else if (/^(ML|MILLILITRES?)$/i.test(raw))    unit = 'ML';
    else if (/^(L|LTR|LTRS|LITRE|LITRES|LITER|LITERS)$/i.test(raw)) unit = 'LTR';
    else if (/^(MT|MTS|TON|TONS|TONNE|TONNES)$/i.test(raw)) unit = 'MT';
    return { value, unit };
  };

  // Convert any quantity to a single base unit per dimension:
  //   Mass   → grams
  //   Volume → millilitres
  // Returns null if the unit isn't recognised so the bag math can
  // bail safely instead of producing a wrong number.
  const _toBaseUnit = (val, unit) => {
    const u = (unit || '').toUpperCase().trim();
    // Mass — grams as base
    if (u === 'KG' || u === 'KGS')   return { val: val * 1000, dim: 'mass' };
    if (u === 'G' || u === 'GM' || u === 'GMS' || u === 'GRAM' || u === 'GRAMS') return { val, dim: 'mass' };
    if (u === 'MT' || u === 'MTS' || u === 'TON' || u === 'TONS' || u === 'TONNE' || u === 'TONNES') return { val: val * 1_000_000, dim: 'mass' };
    // Volume — millilitres as base
    if (u === 'LTR' || u === 'LTRS' || u === 'L' || u === 'LITRE' || u === 'LITRES' || u === 'LITER' || u === 'LITERS') return { val: val * 1000, dim: 'volume' };
    if (u === 'ML' || u === 'MILLILITRE' || u === 'MILLILITRES') return { val, dim: 'volume' };
    return null;
  };

  // UOMs that are already a unit-count (each "1" = one piece /
  // bag / box). For these we don't need a pack size in the product
  // name — the dispatch qty IS the No. of. Matched case-insensitively
  // against the line's UOM value.
  const _UNIT_COUNT_UOMS = new Set([
    'NOS', 'NO', 'NUMBER', 'NUMBERS',
    'PCS', 'PC', 'PIECE', 'PIECES',
    'EACH', 'EA', 'UNIT', 'UNITS',
    'BAG', 'BAGS', 'BOX', 'BOXES',
    'POUCH', 'POUCHES', 'BOTTLE', 'BOTTLES',
    'JAR', 'JARS', 'CAN', 'CANS', 'DRUM', 'DRUMS',
  ]);

  const _computeBags = (dispatchQty, lineUom, productName) => {
    const qty = parseFloat(dispatchQty);
    if (!Number.isFinite(qty) || qty <= 0) return null;

    // Path A: UOM is already a unit count (NOS, PCS, etc.). The
    // dispatch qty is itself the No. of. Don't bother parsing pack
    // sizes — for these UOMs the qty IS the count.
    const uomKey = (lineUom || '').toUpperCase().trim();
    if (_UNIT_COUNT_UOMS.has(uomKey)) {
      // Use Math.round so a stray "10.000" still resolves to 10.
      // Integer dispatch is the norm for piece-count UOMs.
      return Math.round(qty);
    }

    // Path B: UOM is a mass/volume measure (KG / MT / LTR / ML).
    // Parse the per-pack quantity out of the product name
    // ("EMP-BUCKET-5 KG" → 5 KG/pack) and divide.
    const pack = _parsePacking(productName);
    if (!pack) return null;
    const qBase = _toBaseUnit(qty, lineUom);
    const pBase = _toBaseUnit(pack.value, pack.unit);
    if (!qBase || !pBase) return null;
    // Refuse if dimensions don't match (e.g. dispatch in MTS, pack in
    // ML — would silently divide and produce nonsense).
    if (qBase.dim !== pBase.dim) return null;
    if (pBase.val <= 0) return null;
    return Math.round(qBase.val / pBase.val);
  };

  const openDcModal = async (soId, soNo) => {
    try {
      const res = await apiClient.get(`/api/sales/orders/${soId}/dispatch-lines/`);
      const allLines = res.data?.lines || res.data || [];
      const lines = allLines.filter(l => parseFloat(l.pending_qty) > 0).map(l => ({
        ...l, dispatch_qty: '', noa: '', freight_rate: '', godown: '',
      }));
      if (lines.length === 0) { toast.error('No pending items to dispatch — all fully dispatched'); return; }
      setDcPendingAttachments([]);
      // Title prefers an explicit soNo (passed when the user clicked a row
      // on the list), but falls back to the dispatch-lines response so
      // deep-link entries (?dc=<soId>) get the right SO number too.
      // Cross-check the warehouse: prefer dispatch-lines' value, fall
      // back to the SO detail endpoint. Older dispatch-lines builds
      // sometimes returned an empty warehouse, which left the godown
      // dropdown stuck on placeholder. SO detail is the source of
      // truth — fetch in parallel so the modal still opens fast.
      let warehouseId = res.data?.warehouse || '';
      let warehouseName = res.data?.warehouse_name || '';
      if (!warehouseId) {
        try {
          const soRes = await apiClient.get(`/api/sales/orders/${soId}/`);
          warehouseId = soRes.data?.warehouse || '';
          warehouseName = soRes.data?.warehouse_name || warehouseName;
        } catch { /* fall through — empty-warehouse warning below kicks in */ }
      }
      if (!warehouseId) {
        toast.error('This Sales Order has no warehouse linked. Edit the SO and set a warehouse before creating a DC.');
        return;
      }
      // Title prefers an explicit soNo (passed when the user clicked a row
      // on the list), but falls back to the dispatch-lines response so
      // deep-link entries (?dc=<soId>) get the right SO number too.
      setDcModal({ open: true, soId, soNo: soNo || res.data?.so_no || '', lines, warehouse: warehouseId, warehouse_name: warehouseName, destination: res.data?.destination || '', delivery_terms: res.data?.delivery_terms || '', lorry_no: '', transporter: '', freight_type: '', driver_name: '', driver_phone: '', isCreating: false });
    } catch { toast.error('Failed to load dispatch lines'); }
  };

  // Deep-link: open the DC modal when the URL carries ?dc=<soId>.
  // We intentionally DON'T search the local list for the SO — the list
  // is paginated and may not include the target row on the current page,
  // which previously surfaced a spurious "Sales Order not found" toast.
  // The dispatch-lines endpoint resolves the SO directly and tells us if
  // it's no longer dispatchable (404 / no pending lines). The query
  // param is stripped after firing so a refresh doesn't re-open it.
  useEffect(() => {
    const wantedDcSoId = searchParams.get('dc');
    if (!wantedDcSoId) return;
    // Race guard: usePermissions is async — on first render after a
    // navigate(`?dc=...`) hop, isLoading is still true and every
    // canXxx() call returns false. If we evaluated the deep-link
    // here we'd toast "no permission" and strip the param before
    // the real perms even arrived. Wait for the fetch to settle;
    // the effect re-runs when isLoading flips to false because
    // it's in the dep list.
    if (isLoadingPerms) return;
    // Deep-link guard: a user without permission could still trigger
    // the modal by pasting /sales/orders?dc=<id> directly. Strip the
    // param without opening the modal and surface a toast instead.
    if (!canCreateDC) {
      toast.error('You do not have permission to create a Dispatch Challan.');
    } else {
      openDcModal(wantedDcSoId, '');
    }
    searchParams.delete('dc');
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isLoadingPerms, canCreateDC]);

  const handleCreateDC = async () => {
    // When the SO is Ex-Factory the customer collects at our gate — we
    // don't bill freight, so transporter / freight-type / freight-rate
    // checks are skipped and the corresponding fields are sent empty.
    const isExFactory = dcModal.delivery_terms === 'EX_FACTORY';

    // Validate mandatory fields
    if (!dcModal.lorry_no?.trim()) { toast.error('Lorry No is required'); return; }
    if (!isExFactory && !dcModal.transporter) { toast.error('Transporter is required'); return; }
    // Ex-Factory: driver identity matters because there's no
    // transporter on record. We require at least the driver's name and
    // phone — these end up on the printed DC and are what we'd contact
    // if the goods don't reach the customer.
    if (isExFactory) {
      if (!dcModal.driver_name?.trim()) { toast.error('Driver name is required for Ex-Factory'); return; }
      if (!dcModal.driver_phone?.trim()) { toast.error('Driver phone is required for Ex-Factory'); return; }
    }

    const linesToDispatch = dcModal.lines.filter(l => parseFloat(l.dispatch_qty) > 0);
    if (linesToDispatch.length === 0) { toast.error('Enter quantity for at least one product'); return; }
    // Validate quantities
    for (const l of linesToDispatch) {
      const qty = parseFloat(l.dispatch_qty);
      const pending = parseFloat(l.pending_qty);
      if (qty > pending) {
        toast.error(`${l.product_name}: Dispatch qty (${qty}) exceeds pending qty (${pending})`);
        return;
      }
    }
    // Godown is required per line — without it, Release-for-Dispatch
    // rejects the DC and the user has to come back here to fix it.
    // Catching it at create-time means the warehouse picker on the
    // detail page never has to enforce this rule alone.
    for (const l of linesToDispatch) {
      if (!l.godown) {
        toast.error(`${l.product_name}: Godown is required`);
        return;
      }
    }
    // Per-line freight rate is required only when freight applies.
    if (!isExFactory) {
      for (const l of linesToDispatch) {
        const rate = parseFloat(l.freight_rate);
        if (!l.freight_rate || isNaN(rate) || rate <= 0) {
          toast.error(`${l.product_name}: Freight Rate is required`);
          return;
        }
      }
    }
    setDcModal(prev => ({ ...prev, isCreating: true }));
    try {
      const freightTotal = isExFactory ? 0 : linesToDispatch.reduce(
        (s, l) => s + (parseFloat(l.freight_rate) || 0) * (parseFloat(l.dispatch_qty) || 0),
        0,
      );
      const payload = {
        dc_no: '', warehouse: dcModal.warehouse,
        lorry_no: dcModal.lorry_no || '',
        transporter: isExFactory ? null : (dcModal.transporter || null),
        destination: dcModal.destination || '',
        freight_type: isExFactory ? '' : (dcModal.freight_type || ''),
        freight_amount_total: freightTotal || null,
        // Driver details only flow up for Ex-Factory. For
        // transporter-backed flows the driver name/phone live on the
        // transporter master and are looked up there. Backend field
        // name is `driver_contact` (legacy — holds the phone number).
        driver_name: isExFactory ? (dcModal.driver_name || '') : '',
        driver_contact: isExFactory ? (dcModal.driver_phone || '') : '',
        dc_lines: linesToDispatch.map(l => {
          const rate = isExFactory ? 0 : (parseFloat(l.freight_rate) || 0);
          const qty = parseFloat(l.dispatch_qty) || 0;
          return {
            product: l.product, linked_so_line: l.so_line_id,
            quantity_dispatched: qty,
            uom: l.uom || 'KG',
            godown: l.godown || null,
            noa: l.noa !== '' && l.noa !== null && l.noa !== undefined ? parseInt(l.noa, 10) : null,
            freight_rate: rate,
            freight_amount: Number((rate * qty).toFixed(2)),
          };
        }),
      };
      const dcRes = await apiClient.post('/api/sales/dc/', payload);
      const newDcId = dcRes.data?.id;
      if (dcPendingAttachments.length > 0 && newDcId) {
        await uploadPendingFiles('DISPATCH_CHALLAN', newDcId, dcPendingAttachments);
      }
      toast.success('Dispatch Challan created!');
      setDcPendingAttachments([]);
      setDcModal({ open: false, soId: null, soNo: '', lines: [], isCreating: false });
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setDcModal(prev => ({ ...prev, isCreating: false }));
    }
  };

  const handleDelete = async (id, soNo) => {
    if (!(await confirm({ message: `Are you sure you want to delete Sales Order ${soNo}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/orders/${id}/`);
      toast.success(`Sales Order ${soNo} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const Link = ({ to, children }) => (
    <button onClick={(e) => { e.stopPropagation(); navigate(to); }} className="text-blue-700 hover:text-blue-900 hover:underline font-medium text-xs whitespace-nowrap">{children}</button>
  );
  const fmtDate = (v) => v ? formatDate(v) : '-';
  const fmtAmt = (v) => formatCurrency(v);
  const termLabel = (v) => ({ TO_PAY: 'To Pay', PAID: 'Paid', NET_15: 'Net 15', NET_30: 'Net 30', NET_45: 'Net 45' }[v] || v || '-');

  const columns = [
    // Order Details
    { field: 'so_no', header: 'SO Number', sortable: true, width: '150px',
      render: (v, row) => <Link to={`/sales/orders/${row.id}`}>{v}</Link> },
    { field: 'so_date', header: 'SO Date', sortable: true, width: '100px', render: (v) => fmtDate(v) },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '150px' },
    { field: 'company_name', header: 'Company', sortable: true, width: '140px',
      render: (v) => v || <span className="text-xs text-slate-400">-</span> },
    { field: 'warehouse_name', header: 'Warehouse', sortable: true, width: '100px' },
    { field: 'total_amount', header: 'Amount', sortable: true, width: '120px', render: (v) => <span className="font-semibold">{fmtAmt(v)}</span> },
    // Terms
    { field: 'freight_terms', header: 'Freight Terms', sortable: true, width: '90px', render: (v) => termLabel(v) },
    { field: 'payment_terms', header: 'Payment Terms', sortable: true, width: '90px', render: (v) => termLabel(v) },
    { field: 'currency', header: 'Currency', sortable: true, width: '70px' },
    // Shipping
    { field: 'required_ship_date', header: 'Ship Date', sortable: true, width: '100px', render: (v) => fmtDate(v) },
    { field: 'destination', header: 'Destination', sortable: true, width: '120px' },
    { field: 'remarks', header: 'Remarks', sortable: false, width: '150px' },
    // Status
    { field: 'approval_status', header: 'Status', sortable: true, width: '120px', render: (v) => <StatusBadge status={v} /> },
    // Acknowledgement category — only meaningful once the SO is at or
    // past APPROVED. Pre-approval rows show "—" so the column stays
    // readable when the user mixes statuses.
    { field: 'is_acknowledged', header: 'Acknowledgement', sortable: true, width: '150px',
      render: (v, row) => {
        const postApproval = ['APPROVED', 'PARTIALLY_DISPATCHED', 'CLOSED'].includes(row.approval_status);
        if (!postApproval) return <span className="text-xs text-slate-300">—</span>;
        return v ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 size={12} /> Acknowledged
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
            <Clock size={12} /> Pending Ack
          </span>
        );
      } },
    { field: 'attachments', header: 'Photo Attachments', sortable: false, width: '140px',
      render: (_, row) => <ListAttachments attachments={attachmentMap[row.id]} /> },
    {
      field: 'actions',
      header: 'Actions',
      sortable: false,
      width: '150px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canCreateDC && ['APPROVED', 'PARTIALLY_DISPATCHED'].includes(row.approval_status) && (
            <button onClick={(e) => { e.stopPropagation(); openDcModal(row.id, row.so_no); }}
              className="p-1.5 text-teal-600 hover:bg-teal-50 rounded transition" title="Create DC">
              <Truck size={15} />
            </button>
          )}
          {canSeeFlow && (
            <button onClick={(e) => { e.stopPropagation(); openFlow(row.id); }}
              className="p-1.5 text-purple-600 hover:bg-purple-50 rounded transition" title="Flow Dashboard">
              <GitBranch size={15} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/sales/orders/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
            title="View Details"
          >
            <Eye size={15} />
          </button>
          {/* Edit/Delete only available while the SO is still mutable —
              DRAFT or PENDING. Once it's APPROVED / PARTIALLY_DISPATCHED
              / CLOSED / REJECTED the row is committed and the action
              buttons disappear (sales-module post-approval lock). */}
          {canEdit('Sales Order') && ['DRAFT', 'PENDING'].includes(row.approval_status) && (
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/sales/orders/${row.id}/edit`); }}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded transition"
              title="Edit"
            >
              <Pencil size={15} />
            </button>
          )}
          {canDelete('Sales Order') && ['DRAFT', 'PENDING'].includes(row.approval_status) && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.so_no); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Strip columns the user's role HIDES via field permissions. keyFor maps a
  // column's field to its catalog key by dropping a trailing companion suffix
  // (warehouse_name → warehouse). Never drop the actions column or the primary
  // identifier link (so_no) — those stay regardless of field perms.
  const keyForColumn = (field) => (field || '').replace(/_(name|code|display)$/, '');
  const fieldGatedColumns = columns.filter((c) => {
    if (c.field === 'actions' || c.field === 'so_no') return true;
    return !isHidden(keyForColumn(c.field));
  });

  const { visibleColumns, mergedColumns, handleConfigApply, visibleFieldKeys } = useConfigureFields(fieldGatedColumns, 'sales_orders_fields', data);

  // Build unique warehouse / customer / company lists from loaded data
  // so each dropdown only ever offers names that have at least one row.
  const warehouseFilterOptions = [...new Set((data || []).map(i => i.warehouse_name).filter(Boolean))]
    .sort().map(w => ({ value: w, label: w }));
  const customerFilterOptions = [...new Set((data || []).map(i => i.customer_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));
  const companyFilterOptions = [...new Set((data || []).map(i => i.company_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));

  const filterOptions = [
    {
      key: 'approval_status',
      label: 'Status',
      options: [
        { value: 'DRAFT', label: 'Draft' },
        { value: 'PENDING', label: 'Pending' },
        { value: 'APPROVED', label: 'Approved' },
        { value: 'REJECTED', label: 'Rejected' },
        { value: 'PARTIALLY_DISPATCHED', label: 'Partially Dispatched' },
        { value: 'CLOSED', label: 'Closed' },
      ],
    },
    { key: 'customer_name', label: 'Customer', type: 'select', options: customerFilterOptions },
    { key: 'company_name',  label: 'Company',  type: 'select', options: companyFilterOptions },
    {
      key: 'warehouse_name',
      label: 'Warehouse',
      options: warehouseFilterOptions,
    },
  ];

  // Advanced filter column definitions
  const filterColumns = [
    { field: 'so_no', header: 'SO Number', type: 'text' },
    { field: 'so_date', header: 'SO Date', type: 'date' },
    { field: 'customer_name', header: 'Customer', type: 'text' },
    { field: 'warehouse_name', header: 'Warehouse', type: 'text' },
    { field: 'total_amount', header: 'Amount', type: 'number' },
    { field: 'freight_terms', header: 'Freight Terms', type: 'text' },
    { field: 'payment_terms', header: 'Payment Terms', type: 'text' },
    { field: 'currency', header: 'Currency', type: 'text' },
    { field: 'destination', header: 'Destination', type: 'text' },
    { field: 'required_ship_date', header: 'Ship Date', type: 'date' },
    { field: 'remarks', header: 'Remarks', type: 'text' },
    { field: 'approval_status', header: 'Status', type: 'select', filterOptions: [
      { value: 'DRAFT', label: 'Draft' }, { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' },
      { value: 'PARTIALLY_DISPATCHED', label: 'Partially Dispatched' }, { value: 'CLOSED', label: 'Closed' },
    ]},
  ];

  // Status display priority: DRAFT first, then PENDING/APPROVED/PARTIALLY_DISPATCHED, then CLOSED, then REJECTED
  const statusPriority = { DRAFT: 0, PENDING: 1, APPROVED: 2, PARTIALLY_DISPATCHED: 3, CLOSED: 4, REJECTED: 5 };

  // Post-approval SOs only — those are the ones an acknowledgement
  // status applies to. We need this both to power the chip filter and
  // to show the counts on the chips themselves.
  const postApprovalStatuses = ['APPROVED', 'PARTIALLY_DISPATCHED', 'CLOSED'];
  const pendingAckCount = (data || []).filter(i => postApprovalStatuses.includes(i.approval_status) && !i.is_acknowledged).length;
  const acknowledgedCount = (data || []).filter(i => postApprovalStatuses.includes(i.approval_status) && i.is_acknowledged).length;

  const filteredData = (() => {
    let result = (data || []).filter((item) => {
      const term = searchTerm.toLowerCase();
      const productNames = (item.product_names || []).join(' ').toLowerCase();
      const matchesSearch = !term || [
        item.so_no, item.so_date, item.customer_name, item.company_name,
        item.warehouse_name, item.total_amount, item.freight_terms,
        item.payment_terms, item.currency, item.destination,
        item.required_ship_date, item.remarks, item.approval_status,
      ].some(v => v != null && String(v).toLowerCase().includes(term)) || productNames.includes(term);
      const matchesStatus = matchesSelect(item.approval_status, activeFilters.approval_status);
      const matchesWarehouse = matchesSelect(item.warehouse_name, activeFilters.warehouse_name);
      const matchesCustomer = matchesSelect(item.customer_name, activeFilters.customer_name);
      const matchesCompany = matchesSelect(item.company_name, activeFilters.company_name);
      // Acknowledgement chip: when active, restrict to post-approval
      // SOs in the chosen ack state. Empty value = no restriction.
      const matchesAck = (() => {
        if (!ackFilter) return true;
        if (!postApprovalStatuses.includes(item.approval_status)) return false;
        return ackFilter === 'acknowledged' ? !!item.is_acknowledged : !item.is_acknowledged;
      })();
      return matchesSearch && matchesStatus && matchesWarehouse && matchesCustomer && matchesCompany && matchesAck
        && period.match(item.so_date);
    });
    // Apply advanced filters
    if (advancedRules.length > 0) {
      result = applyAdvancedFilters(result, advancedRules, advancedLogic);
    }
    // Default ordering by status priority when user hasn't explicitly sorted
    if (sortBy === 'so_date' && sortOrder === 'desc') {
      result = [...result].sort((a, b) => {
        const pa = statusPriority[a.approval_status] ?? 99;
        const pb = statusPriority[b.approval_status] ?? 99;
        if (pa !== pb) return pa - pb;
        return new Date(b.so_date || 0) - new Date(a.so_date || 0);
      });
    } else if (sortBy) {
      // Every other column: the header arrow moved but nothing reordered,
      // because DataTable does not sort internally and this only filtered.
      // Numbers compare as numbers; the rest compares as text with numeric
      // collation, which also orders ISO dates correctly. Blanks go last in
      // both directions.
      const dir = sortOrder === 'desc' ? -1 : 1;
      const blank = (v) => v === null || v === undefined || v === '';
      result = [...result].sort((a, b) => {
        const av = a[sortBy], bv = b[sortBy];
        if (blank(av) && blank(bv)) return 0;
        if (blank(av)) return 1;
        if (blank(bv)) return -1;
        const an = Number(av), bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
      });
    }
    return result;
  })();

  const handleSort = (field, order) => {
    setSortBy(field);
    setSortOrder(order);
  };

  const handleFilterChange = (filters) => {
    setActiveFilters(filters);
  };

  // Keep the address in step with the filters. replace:true so picking one is
  // not a history entry -- Back should leave the page, not crawl back through
  // every dropdown that was touched.
  // A filter change makes the page number meaningless, so reset to 1 -
  // except on the first render, where a page restored from the URL on Back
  // must survive.
  const firstPageReset = useRef(true);
  const pageResetSig = JSON.stringify([period.navProps, activeFilters, ackFilter, searchTerm, sortBy, sortOrder]);
  useEffect(() => {
    if (firstPageReset.current) { firstPageReset.current = false; return; }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageResetSig]);

  useEffect(() => {
    const pp = new URLSearchParams(searchParams);
    const put = (k, v, keep) => { if (keep) pp.set(k, v); else pp.delete(k); };
    const np = period.navProps;
    const co = pickOf(activeFilters.company_name);
    const cu = pickOf(activeFilters.customer_name);
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('company', co, !!co);
    put('customer', cu, !!cu);
    put('ack', ackFilter, !!ackFilter);
    put('q', searchTerm, !!searchTerm.trim());
    put('sort', sortBy, sortBy !== 'so_date');
    put('dir', sortOrder, sortOrder !== 'asc');
    put('page', String(page), page > 1);
    const next = pp.toString();
    if (next !== searchParams.toString()) setSearchParams(pp, { replace: true });
  }, [period.navProps, activeFilters, ackFilter, searchTerm, sortBy, sortOrder,
      page, searchParams, setSearchParams]);

  // Acknowledgement filter pills — shared between the desktop row (with
  // the "Approved SOs:" caption) and the mobile row (rendered to the
  // right of the search bar). "Pending Acknowledgement" shortens to
  // "Pending" on mobile so all three fit beside the search.
  // Approved SOs: one dropdown instead of three pills on their own row. Same
  // three choices and the same ackFilter values, so the filtering underneath is
  // untouched -- the counts just move into the option labels.
  const ackSelect = (
    <CustomSelect value={ackFilter} onChange={(e) => setAckFilter(e.target.value)} title="Approved SOs"
      className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[260px]">
      <option value="">All approved SOs ({pendingAckCount + acknowledgedCount})</option>
      <option value="pending">Pending Acknowledgement ({pendingAckCount})</option>
      <option value="acknowledged">Acknowledged ({acknowledgedCount})</option>
    </CustomSelect>
  );

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-x-2 sm:gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 sm:min-w-[15rem] flex items-center gap-1.5">
            <BackToModule />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">Sales Orders</h1>
              <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Manage all sales orders</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 shrink-0">
            {canCreate('Sales Order') && (
              <button onClick={() => navigate('/sales/orders/new')}
                className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm sm:text-base font-medium">
                <Plus size={18} /> <span className="hidden xs:inline">New </span>Sales Order
              </button>
            )}
          </div>
        </div>


        {/* Post-approval acknowledgement chips — let the team flick
            between "still owed an ack from the factory" and "factory
            has claimed it" without opening the full filter panel. */}
        {/* One filter row, the same as Sales Invoices and Dispatch Challans:
            when, which company, which customer, which acknowledgement state,
            and which columns. The "Approved SOs:" caption and its three pills
            used to own a row of their own; they are the dropdown here now. */}
        <div className="flex flex-wrap items-center gap-2">
          <PeriodNavigator allowAll {...period.navProps} />
          <CustomSelect value={pickOf(activeFilters.company_name)} title="Company"
            onChange={(e) => setActiveFilters((p) => ({ ...p, company_name: e.target.value }))}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[230px]">
            <option value="">All Companies</option>
            {companyFilterOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          <CustomSelect value={pickOf(activeFilters.customer_name)} title="Customer"
            onChange={(e) => setActiveFilters((p) => ({ ...p, customer_name: e.target.value }))}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[230px]">
            <option value="">All Customers</option>
            {customerFilterOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          {ackSelect}

          <div className="relative">
            <button type="button" onClick={() => setFieldsOpen(o => !o)}
              title="Choose columns" aria-label="Choose columns"
              aria-haspopup="true" aria-expanded={fieldsOpen}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${CTRL_H} ${fieldsOpen ? 'bg-primary-50 text-primary-700 border-primary-300' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              <Settings2 size={15} /> Fields
              <ChevronDown size={13} className={`transition-transform ${fieldsOpen ? 'rotate-180' : ''}`} />
            </button>
            {fieldsOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setFieldsOpen(false)} />
                <div className="absolute z-30 mt-1 w-60 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg py-1">
                  {mergedColumns.map((c) => {
                    const on = visibleFieldKeys.includes(c.field);
                    return (
                      <label key={c.field}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 cursor-pointer">
                        <input type="checkbox" checked={on} className="accent-primary-600"
                          onChange={() => handleConfigApply(
                            on ? visibleFieldKeys.filter((k) => k !== c.field)
                               : [...visibleFieldKeys, c.field])} />
                        <span className="truncate">{c.header || c.field}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {(period.range || pickOf(activeFilters.company_name) || pickOf(activeFilters.customer_name) || ackFilter) && (
            <>
              <span className="text-xs text-slate-500 tabular-nums">
                {filteredData.length.toLocaleString('en-IN')} of {(data || []).length.toLocaleString('en-IN')} orders
              </span>
              <button type="button" className="text-xs text-slate-500 hover:text-slate-800 underline"
                onClick={() => { period.navProps.setPeriod('all'); setAckFilter(''); setActiveFilters((p) => ({ ...p, company_name: '', customer_name: '' })); }}>
                Clear
              </button>
            </>
          )}
        </div>
        {/* Mobile: search on the left, ack pills on the right — one row.
            The shared MobileListCards search is turned off below (no
            onSearchChange) so the search input lives here instead. The
            pill strip scrolls horizontally if it can't fully fit. */}
        <div className="sm:hidden flex items-center gap-2">
          <div className="relative flex-1 min-w-[7rem]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search SO, customer…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>

        <ListState error={error} onRetry={refetch}>
        {/* Mobile-only card list (sub-sm). Shares searchTerm / filter
            state with the desktop DataTable so filtering works in both
            views. The desktop DataTable below is hidden on mobile to
            avoid the horizontal-scroll pain on a wide column count. */}
        {/* Search is rendered above (next to the ack pills), so the
            card list's own search bar is intentionally omitted here —
            no onSearchChange passed. */}
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/sales/orders/${row.id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } })}
          emptyMessage="No sales orders found"
          config={{
            title: (row) => row.so_no || `SO #${row.id}`,
            subtitle: (row) => row.customer_name,
            badge: (row) => {
              const s = row.approval_status;
              const map = {
                DRAFT:                { label: 'Draft',     cls: 'bg-slate-100 text-slate-700 border-slate-300' },
                PENDING:              { label: 'Pending',   cls: 'bg-amber-100 text-amber-800 border-amber-300' },
                APPROVED:             { label: 'Approved',  cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
                REJECTED:             { label: 'Rejected',  cls: 'bg-red-100 text-red-700 border-red-300' },
                PARTIALLY_DISPATCHED: { label: 'Partial',   cls: 'bg-blue-100 text-blue-800 border-blue-300' },
                CLOSED:               { label: 'Closed',    cls: 'bg-slate-200 text-slate-700 border-slate-300' },
              };
              return map[s] || { label: s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
            },
            fields: (row) => [
              { label: 'Date',     value: fmtDate(row.so_date) },
              { label: 'Warehouse', value: row.warehouse_name },
              { label: 'Amount',   value: row.total_amount != null ? formatCurrency(row.total_amount) : null, cls: 'text-slate-800 font-medium' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/sales/orders/${row.id}`) },
              { icon: GitBranch, label: 'Flow', cls: 'text-purple-700 hover:bg-purple-50', onClick: () => navigate(`/sales/flow?so=${row.id}`), hidden: !row.id || !canSeeFlow },
            ],
          }}
        />

        <div className="hidden sm:block bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <DataTable
            isLoading={isLoading}
            exportFileName="sales-orders"
            exportLineConfig={SO_EXPORT_LINES}
            onExport={async (rows) => {
              try { await exportServerSide('/api/sales/orders/export/', rows, 'sales-orders'); }
              catch { toast.error('Export failed'); }
            }}
            canExport={canExport('Sales Order')}
            columns={visibleColumns}
            data={filteredData}
            page={page}
            pageSize={10}
            totalRecords={filteredData.length}
            onPageChange={setPage}
            onSort={handleSort}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSearch={setSearchTerm}
            extraSearchFields={['product_names']}
            searchPlaceholder="Search by SO number, customer, warehouse or product..."
            onFilterChange={handleFilterChange}
            onRowClick={(row) => navigate(`/sales/orders/${row.id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } })}
            emptyMessage="No sales orders found"
            expandableContent={(row) => <ExpandableLines apiUrl={`/api/sales/orders/${row.id}/`} linesKey="so_lines" columns={SO_LINE_COLUMNS} />}
            expandAsModal
            expandModalTitle={(row) => `Line Items — ${row.so_no || 'Sales Order'}`}
          />
        </div>
        </ListState>
      </div>
      {FlowPopup}

      {/* Create DC Modal */}
      {dcModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[95dvh] sm:max-h-[85dvh] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Create Dispatch Challan">
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b bg-teal-50">
              <div>
                <h3 className="text-lg font-bold text-teal-900">Create Dispatch Challan</h3>
                <p className="text-xs text-teal-600 mt-0.5">SO: {dcModal.soNo} — Enter dispatch quantities</p>
              </div>
              <button onClick={() => setDcModal({ open: false, soId: null, soNo: '', lines: [], isCreating: false })} className="p-1.5 text-slate-500 hover:bg-slate-200 rounded"><X size={18} /></button>
            </div>

            {/* DC Details
                Ex-Factory delivery terms = customer collects at the gate,
                so we don't bill freight on this DC. Transporter and
                Freight Type are hidden in that case and a small notice
                replaces them. */}
            {(() => { const isExFactory = dcModal.delivery_terms === 'EX_FACTORY'; return (
            <div className="px-4 sm:px-6 py-4 border-b">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Lorry No <span className="text-red-500">*</span></label>
                  <input type="text" value={dcModal.lorry_no} onChange={(e) => setDcModal(prev => ({ ...prev, lorry_no: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-teal-500" placeholder="e.g. TN 30 A 1234" />
                </div>
                {!isExFactory && (
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Transporter <span className="text-red-500">*</span></label>
                    <CustomSelect value={dcModal.transporter} onChange={(e) => setDcModal(prev => ({ ...prev, transporter: e.target.value }))}
                      className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-teal-500">
                      <option value="">Select Transporter</option>
                      {transporterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                )}
              </div>
              {/* Godown for the whole DC + "same godown" toggle. When the
                  toggle is on, picking a godown here fills every line; each
                  line can still be overridden individually below. */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Godown</label>
                  <CustomSelect value={dcModal.godown || ''}
                    onChange={(e) => setDcModal(prev => ({
                      ...prev,
                      godown: e.target.value,
                      lines: prev.useSameGodown ? prev.lines.map(l => ({ ...l, godown: e.target.value })) : prev.lines,
                    }))}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-teal-500">
                    <option value="">Select Godown</option>
                    {godownOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
                <div className="flex items-end pb-1.5">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={dcModal.useSameGodown || false}
                      onChange={(e) => setDcModal(prev => ({
                        ...prev,
                        useSameGodown: e.target.checked,
                        lines: e.target.checked && prev.godown ? prev.lines.map(l => ({ ...l, godown: prev.godown })) : prev.lines,
                      }))}
                      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
                    <span className="text-xs text-slate-600 font-medium">Same godown for all lines</span>
                  </label>
                </div>
              </div>
              {/* Freight Type — totals are rolled up below the line table */}
              {!isExFactory && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Freight Type</label>
                    <CustomSelect value={dcModal.freight_type || ''}
                      onChange={(e) => setDcModal(prev => ({ ...prev, freight_type: e.target.value }))}
                      className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-teal-500">
                      <option value="">Select</option>
                      <option value="LOCAL">Local</option>
                      <option value="LINEHAUL">Linehaul</option>
                    </CustomSelect>
                  </div>
                </div>
              )}
              {isExFactory && (
                <>
                  <p className="mt-3 text-xs text-slate-500 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 inline-block">
                    Ex-Factory delivery — customer collects at the gate. Transporter and freight charges are not applicable.
                  </p>
                  {/* Driver details — required for Ex-Factory since
                      the customer's own vehicle/driver picks up. The
                      lorry number is captured above; this block adds
                      the human side so we can identify and contact the
                      person who actually moved the goods. */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Driver Name <span className="text-red-500">*</span></label>
                      <input
                        type="text"
                        value={dcModal.driver_name}
                        onChange={(e) => setDcModal(prev => ({ ...prev, driver_name: e.target.value }))}
                        className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-teal-500"
                        placeholder="e.g. Suresh Kumar"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">Driver Phone <span className="text-red-500">*</span></label>
                      <input
                        type="tel"
                        inputMode="tel"
                        value={dcModal.driver_phone}
                        onChange={(e) => setDcModal(prev => ({ ...prev, driver_phone: e.target.value }))}
                        className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-teal-500"
                        placeholder="e.g. 9876543210"
                        maxLength={20}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
            ); })()}

            {/* Lines Table */}
            {(() => { const isExFactory = dcModal.delivery_terms === 'EX_FACTORY'; return (
            <div className="px-4 sm:px-6 py-4">
              <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                <table className="w-full text-sm" style={{ minWidth: isExFactory ? '820px' : '1020px' }}>
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">#</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">Product</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">Godown <span className="text-red-500">*</span></th>
                      <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">SO Qty</th>
                      <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">Already Dispatched</th>
                      <th className="text-right px-3 py-2 font-semibold text-orange-600 whitespace-nowrap">Pending</th>
                      <th className="text-right px-3 py-2 font-semibold text-teal-700 whitespace-nowrap">Dispatch Now</th>
                      <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">No. of</th>
                      {!isExFactory && (
                        <>
                          <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">Freight Rate <span className="text-red-500">*</span></th>
                          <th className="text-right px-3 py-2 font-semibold text-emerald-700 whitespace-nowrap">Freight Amount</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {dcModal.lines.map((line, idx) => {
                      const pending = parseFloat(line.pending_qty) || 0;
                      const dispQty = parseFloat(line.dispatch_qty) || 0;
                      const rate = parseFloat(line.freight_rate) || 0;
                      const lineFreight = rate * dispQty;
                      // Parse packing once per render so we can show
                      // the detected pack size beside the product name
                      // — the factory can see what the bag math will
                      // use without opening devtools.
                      const pack = _parsePacking(line.product_name);
                      const computedBags = _computeBags(line.dispatch_qty, line.uom, line.product_name);
                      return (
                        <tr key={idx} className={`border-b ${pending <= 0 ? 'bg-green-50 opacity-60' : ''}`}>
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{idx + 1}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <p className="font-medium text-slate-800">{line.product_name}</p>
                            <p className="text-xs text-slate-400">
                              {line.uom}
                              {pack && (
                                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  Pack {pack.value} {pack.unit}
                                </span>
                              )}
                            </p>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {pending > 0 ? (
                              <CustomSelect
                                value={line.godown || ''}
                                onChange={(e) => setDcModal(prev => ({
                                  ...prev,
                                  lines: prev.lines.map((l, i) => i === idx ? { ...l, godown: e.target.value } : l),
                                }))}
                                disabled={!dcModal.warehouse}
                                className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
                                style={{ width: '160px' }}
                              >
                                <option value="">{dcModal.warehouse ? 'Select godown...' : '—'}</option>
                                {godownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                              </CustomSelect>
                            ) : (
                              <span className="text-slate-300 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">{Number(line.quantity_ordered).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                          <td className="px-3 py-2 text-right text-green-700 whitespace-nowrap">{Number((line.quantity_ordered || 0) - pending).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                          <td className="px-3 py-2 text-right font-semibold text-orange-600 whitespace-nowrap">{pending > 0 ? pending.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '✓ Done'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {pending > 0 ? (
                              <input type="number" step="0.001" min="0" max={pending}
                                value={line.dispatch_qty}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  // Auto-compute No. of bags from the
                                  // product name's packing size whenever
                                  // dispatch qty changes. We only
                                  // OVERWRITE noa when the computation
                                  // succeeds — never clobber a manual
                                  // override with nothing.
                                  setDcModal(prev => ({
                                    ...prev,
                                    lines: prev.lines.map((l, i) => {
                                      if (i !== idx) return l;
                                      const next = { ...l, dispatch_qty: val };
                                      const bags = _computeBags(val, l.uom, l.product_name);
                                      if (bags != null) next.noa = String(bags);
                                      return next;
                                    }),
                                  }));
                                }}
                                className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                                style={{ width: '110px' }}
                                placeholder="0" />
                            ) : (
                              <span className="text-green-500 text-xs">Fully dispatched</span>
                            )}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {pending > 0 ? (
                              <div className="flex items-center gap-1">
                                <input type="number" step="1" min="0"
                                  value={line.noa ?? ''}
                                  onChange={(e) => setDcModal(prev => ({
                                    ...prev,
                                    lines: prev.lines.map((l, i) => i === idx ? { ...l, noa: e.target.value } : l),
                                  }))}
                                  className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                                  style={{ width: '90px' }}
                                  placeholder={computedBags != null ? String(computedBags) : '0'} />
                                {computedBags != null && String(line.noa) !== String(computedBags) && (
                                  <button
                                    type="button"
                                    title={`Auto-fill from packing: ${pack?.value} ${pack?.unit} → ${computedBags} bag(s)`}
                                    onClick={() => setDcModal(prev => ({
                                      ...prev,
                                      lines: prev.lines.map((l, i) => i === idx ? { ...l, noa: String(computedBags) } : l),
                                    }))}
                                    className="text-[10px] text-indigo-600 hover:text-indigo-800 font-medium whitespace-nowrap"
                                  >
                                    use {computedBags}
                                  </button>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-300 text-xs">-</span>
                            )}
                          </td>
                          {!isExFactory && (
                            <>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {pending > 0 ? (
                                  <div className="relative" style={{ width: '120px', marginLeft: 'auto' }}>
                                    <span className="absolute left-2 top-1.5 text-slate-400 text-xs">₹</span>
                                    <input type="number" step="0.01" min="0"
                                      value={line.freight_rate ?? ''}
                                      onChange={(e) => setDcModal(prev => ({
                                        ...prev,
                                        lines: prev.lines.map((l, i) => i === idx ? { ...l, freight_rate: e.target.value } : l),
                                      }))}
                                      className="w-full border border-slate-300 rounded-lg pl-5 pr-2 py-1.5 text-sm text-right focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                                      placeholder="0.00" />
                                  </div>
                                ) : (
                                  <span className="text-slate-300 text-xs">-</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right whitespace-nowrap font-semibold text-emerald-700">
                                {pending > 0 ? formatCurrency(lineFreight) : <span className="text-slate-300 font-normal">-</span>}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Quick fill button — also pre-fills No. of bags for
                  every line whose product name carries a parseable
                  packing size. Anything that doesn't parse is left
                  alone for the user to fill manually. */}
              <div className="mt-3 flex justify-end">
                <button type="button" onClick={() => setDcModal(prev => ({
                  ...prev,
                  lines: prev.lines.map(l => {
                    const qty = String(parseFloat(l.pending_qty) || 0);
                    const bags = _computeBags(qty, l.uom, l.product_name);
                    return {
                      ...l,
                      dispatch_qty: qty,
                      ...(bags != null ? { noa: String(bags) } : {}),
                    };
                  }),
                }))} className="text-xs text-teal-600 hover:text-teal-800 font-medium">Fill all pending quantities</button>
              </div>

              {/* Roll-up totals (sum of line dispatch_qty and line freight amount).
                  The freight tile is omitted on Ex-Factory DCs since no
                  freight is being billed. */}
              <div className={`mt-4 grid gap-3 ${isExFactory ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Total Dispatch Qty</label>
                  <input type="text" value={dcModal.lines.reduce((s, l) => s + (parseFloat(l.dispatch_qty) || 0), 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} readOnly
                    className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm bg-slate-50 text-slate-600" />
                </div>
                {!isExFactory && (
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Total Freight Amount</label>
                    <input type="text" value={formatCurrency(dcModal.lines.reduce((s, l) => s + (parseFloat(l.freight_rate) || 0) * (parseFloat(l.dispatch_qty) || 0), 0))} readOnly
                      className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm bg-emerald-50 text-emerald-700 font-semibold" />
                  </div>
                )}
              </div>
            </div>
            ); })()}

            {/* Attachments */}
            <div className="px-4 sm:px-6 py-4 border-t border-slate-200">
              <FileAttachments module="DISPATCH_CHALLAN" recordId={null} deferUpload onPendingChange={setDcPendingAttachments} />
            </div>

            {/* Footer */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t bg-slate-50">
              <p className="text-xs text-slate-500">
                Dispatching: {dcModal.lines.filter(l => parseFloat(l.dispatch_qty) > 0).length} item(s) |
                Total qty: {dcModal.lines.reduce((s, l) => s + (parseFloat(l.dispatch_qty) || 0), 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
              </p>
              <div className="flex gap-2 sm:gap-3 w-full sm:w-auto">
                <button onClick={() => setDcModal({ open: false, soId: null, soNo: '', lines: [], isCreating: false })}
                  className="flex-1 sm:flex-none px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">Cancel</button>
                <button onClick={handleCreateDC} disabled={dcModal.isCreating}
                  className="flex-1 sm:flex-none px-5 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50">
                  {dcModal.isCreating ? 'Creating...' : 'Create DC'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
