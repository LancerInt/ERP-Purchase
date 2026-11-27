import { useState, useMemo, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import ActionButtons from '../../../components/common/ActionButtons';
import exportToExcel from '../../../utils/exportExcel.js';
import {
  FileText, GitBranch, X, Loader2, CheckCircle2, Clock, ChevronRight,
  ArrowRight, AlertTriangle, Package, Truck, CreditCard, Receipt,
  ShoppingCart, ClipboardList, Star, DollarSign, BarChart3, TrendingUp,
  SkipForward, List, Paperclip, Eye, RefreshCw,
} from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import toast from 'react-hot-toast';
import { matchesSelect } from '@/components/common/FilterPanel';
import MobileListCards from '../components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';

/* ================================================================
   FLOW GRAPH CONSTANTS & HELPERS
================================================================ */

const NODE_COLORS = {
  pr:         { bg: 'bg-indigo-500',  ring: 'ring-indigo-200',  light: 'bg-indigo-50',  text: 'text-indigo-700',  border: 'border-indigo-300' },
  rfq:        { bg: 'bg-violet-500',  ring: 'ring-violet-200',  light: 'bg-violet-50',  text: 'text-violet-700',  border: 'border-violet-300' },
  quote:      { bg: 'bg-purple-500',  ring: 'ring-purple-200',  light: 'bg-purple-50',  text: 'text-purple-700',  border: 'border-purple-300' },
  evaluation: { bg: 'bg-fuchsia-500', ring: 'ring-fuchsia-200', light: 'bg-fuchsia-50', text: 'text-fuchsia-700', border: 'border-fuchsia-300' },
  po:         { bg: 'bg-blue-500',    ring: 'ring-blue-200',    light: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-300' },
  grn:        { bg: 'bg-teal-500',    ring: 'ring-teal-200',    light: 'bg-teal-50',    text: 'text-teal-700',    border: 'border-teal-300' },
  freight:    { bg: 'bg-cyan-500',    ring: 'ring-cyan-200',    light: 'bg-cyan-50',    text: 'text-cyan-700',    border: 'border-cyan-300' },
  bill:       { bg: 'bg-amber-500',   ring: 'ring-amber-200',   light: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-300' },
  payment:    { bg: 'bg-emerald-500', ring: 'ring-emerald-200', light: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-300' },
  credit:     { bg: 'bg-rose-500',    ring: 'ring-rose-200',    light: 'bg-rose-50',    text: 'text-rose-700',    border: 'border-rose-300' },
};

const NODE_ICONS = {
  pr: ClipboardList, rfq: FileText, quote: Star, evaluation: BarChart3,
  po: ShoppingCart, grn: Package, freight: Truck, bill: Receipt,
  payment: DollarSign, credit: CreditCard,
};

const NODE_LABELS = {
  pr: 'Purchase Request', rfq: 'RFQ', quote: 'Quote', evaluation: 'Evaluation',
  po: 'Purchase Order', grn: 'Receipt (GRN)', freight: 'Freight Advice',
  bill: 'Vendor Bill', payment: 'Payment', credit: 'Credit Note',
};

const STATUS_COLORS_FLOW = {
  APPROVED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  DRAFT: 'bg-slate-100 text-slate-700 border-slate-300',
  PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  // Warehouse Manager has signed off (stage 2); awaiting the Purchase
  // Coordinator's final call. Its own indigo pill + "Factory Approved" label.
  PENDING_APPROVAL: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  // Some lines routed, some held pending price — matches the blue used
  // for the "Held — awaiting price" section on the PR detail page.
  PARTIALLY_APPROVED: 'bg-blue-100 text-blue-800 border-blue-300',
  REJECTED: 'bg-red-100 text-red-800 border-red-300',
  OPEN: 'bg-blue-100 text-blue-800 border-blue-300',
  CLOSED: 'bg-slate-200 text-slate-700 border-slate-400',
  ISSUED: 'bg-blue-100 text-blue-800 border-blue-300',
  CANCELLED: 'bg-red-100 text-red-800 border-red-300',
  CHOSEN: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  PARTIAL: 'bg-amber-100 text-amber-800 border-amber-300',
  PAID: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  PARTIALLY_PAID: 'bg-amber-100 text-amber-800 border-amber-300',
  OVERDUE: 'bg-red-100 text-red-800 border-red-300',
  IN_TRANSIT: 'bg-cyan-100 text-cyan-800 border-cyan-300',
  COMPLETED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
};

const fmtCurrency = (v) => v ? `\u20B9${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '\u20B90.00';
const fmtDate = (d) => d ? formatDate(d) : '-';

// Display labels for status codes whose human name isn't just the code with
// underscores swapped for spaces. PENDING_APPROVAL = the Warehouse-Manager-
// approved stage, shown to everyone as "Factory Approved".
const STATUS_LABELS_FLOW = {
  PENDING_APPROVAL: 'Factory Approved',
};

function FlowStatusBadge({ status }) {
  const cls = STATUS_COLORS_FLOW[status] || 'bg-slate-100 text-slate-600 border-slate-200';
  const label = STATUS_LABELS_FLOW[status] || (status || '').replace(/_/g, ' ');
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>{label}</span>;
}

/* ================================================================
   FILTER FIELDS
================================================================ */

// Mirrors every field on the PR form (plus a few derived ones), so users
// can filter as precisely as they enter data. `value` must match a key on
// the list-API row — filtering is client-side via row[field.value].
const FILTER_FIELDS = [
  // Identity
  { value: 'pr_no', label: 'PR Number', type: 'text' },
  // Classification
  // Labels mirror the status badges users actually see in the table — the
  // PENDING_APPROVAL code renders as the "Pending Approval" pill (see
  // StatusBadge), so that's the label that must match it here.
  { value: 'approval_status', label: 'Status', type: 'select', options: [
    { value: 'DRAFT', label: 'Draft' }, { value: 'EDITED', label: 'Edited' },
    { value: 'PENDING', label: 'Pending' }, { value: 'PENDING_APPROVAL', label: 'Factory Approved' },
    { value: 'APPROVED', label: 'Approved' }, { value: 'PARTIALLY_APPROVED', label: 'Partially Approved' },
    { value: 'REJECTED', label: 'Rejected' },
  ]},
  { value: 'priority', label: 'Priority', type: 'select', options: [
    { value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' },
  ]},
  { value: 'requirement_type', label: 'Requirement Type', type: 'select', options: [
    { value: 'GOODS', label: 'Goods' }, { value: 'MACHINERY', label: 'Machinery' },
  ]},
  // Organisation
  { value: 'company_name', label: 'Company', type: 'text' },
  { value: 'warehouse_name', label: 'Warehouse', type: 'text' },
  { value: 'godown_name', label: 'Godown', type: 'text' },
  // People
  { value: 'requestor_role', label: 'Requestor Role', type: 'text' },
  { value: 'requested_by_name', label: 'Requested By', type: 'text' },
  { value: 'preferred_vendor_name', label: 'Preferred Vendor', type: 'text' },
  { value: 'approved_by_name', label: 'Approved By', type: 'text' },
  // Free text
  { value: 'justification', label: 'Justification', type: 'text' },
  { value: 'notes', label: 'Notes', type: 'text' },
  // Linkage
  { value: 'linked_rfq_no', label: 'Linked RFQ', type: 'text' },
  { value: 'allow_rfq_skip', label: 'RFQ Skipped', type: 'select', options: [
    { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' },
  ]},
  { value: 'has_po', label: 'PO Generated', type: 'select', options: [
    { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' },
  ]},
  // Dates
  { value: 'required_by_date', label: 'Required By', type: 'date' },
  { value: 'request_date', label: 'Created', type: 'date' },
  { value: 'approved_at', label: 'Approved On', type: 'date' },
];

// Export columns mirror the filterable fields so a user who narrows the list
// by Company / Requirement Type / etc. gets those columns in the sheet. Shared
// by both export buttons (PageHeader + DataTable) so they never drift apart.
const EXPORT_COLUMNS = [
  { key: 'pr_no', label: 'PR Number' },
  { key: 'approval_status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'requirement_type', label: 'Requirement Type' },
  { key: 'company_name', label: 'Company' },
  { key: 'warehouse_name', label: 'Warehouse' },
  { key: 'godown_name', label: 'Godown' },
  { key: 'requestor_role', label: 'Requestor Role' },
  { key: 'requested_by_name', label: 'Requested By' },
  { key: 'preferred_vendor_name', label: 'Preferred Vendor' },
  { key: 'approved_by_name', label: 'Approved By' },
  { key: 'request_date', label: 'Created' },
  { key: 'required_by_date', label: 'Required By' },
  { key: 'approved_at', label: 'Approved On' },
  { key: 'linked_rfq_no', label: 'Linked RFQ' },
  { key: 'rfq_skipped', label: 'RFQ Skipped' },
  { key: 'po_generated', label: 'PO Generated' },
  { key: 'justification', label: 'Justification' },
  { key: 'notes', label: 'Notes' },
];

/* ================================================================
   MAIN COMPONENT
================================================================ */

export default function PurchaseRequestList() {
  const navigate = useNavigate();
  const { data: rawData, isLoading, error, refetch } = useApiData('/api/purchase/requests/');
  const { canCreate, canExport, role, isAdmin, isSuperuser } = usePermissions();
  const { isHidden } = useFieldPermissions('Purchase Request');
  const RFQ_SKIP_ROLES = new Set(['admin', 'administrator', 'purchase coordinator', 'purchase manager']);
  const _roleName = (role?.role_name || role?.name || '').trim().toLowerCase();
  const canSkipRfq = isAdmin || isSuperuser || RFQ_SKIP_ROLES.has(_roleName);
  const { company: globalCompany } = useGlobalCompany();
  const data = useMemo(() => {
    if (!globalCompany || !rawData) return rawData;
    return rawData.filter(r => String(r.company || '') === String(globalCompany));
  }, [rawData, globalCompany]);
  const [searchTerm, setSearchTerm] = useState('');
  const [datePeriod, setDatePeriod] = useState('All');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  // Filters live in the URL so Back / refresh / sharing restore the filtered
  // view (and a PR opened from here returns to it on Back).
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    pr_no: '', approval_status: '', requirement_type: '', company_name: '',
    warehouse_name: '', godown_name: '', preferred_vendor_name: '', request_date: '',
  });

  // Flow modal state
  const [flowPr, setFlowPr] = useState(null); // { id, pr_no }
  const [flowData, setFlowData] = useState(null);
  const [flowLoading, setFlowLoading] = useState(false);
  const [flowError, setFlowError] = useState(null);
  const [flowSelectedNode, setFlowSelectedNode] = useState(null);

  // Line items modal state
  const [lineItemsPr, setLineItemsPr] = useState(null); // { id, pr_no, lines }
  const [lineItemsLoading, setLineItemsLoading] = useState(false);

  // Attachments per PR — fetched once when data loads
  const [attachmentsByPr, setAttachmentsByPr] = useState({});
  const [attachmentModal, setAttachmentModal] = useState(null); // { prNo, files }

  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 17;
  const thCls = "text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap";

  useEffect(() => {
    if (!rawData || rawData.length === 0) return;
    const ids = rawData.map(pr => pr.id).filter(Boolean);
    if (ids.length === 0) return;
    let alive = true;
    // ONE request for every PR on the page (record_ids=...), not one per row —
    // then group the rows by record_id. Avoids the old N+1 (N requests for N PRs).
    apiClient.get('/api/purchase/attachments/', {
      params: { module: 'PR', record_ids: ids.join(',') },
    }).then((res) => {
      if (!alive) return;
      const list = res.data?.results || res.data || [];
      const map = {};
      for (const a of list) {
        const pid = a.record_id;
        if (!pid) continue;
        (map[pid] ||= []).push(a);
      }
      setAttachmentsByPr(map);
    }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [rawData]);

  const openLineItems = useCallback(async (row) => {
    setLineItemsLoading(true);
    setLineItemsPr({ id: row.id, pr_no: row.pr_no, lines: [] });
    try {
      const res = await apiClient.get(`/api/purchase/requests/${row.id}/`);
      const lines = res.data.lines || res.data.line_items || [];
      setLineItemsPr({ id: row.id, pr_no: row.pr_no, lines });
    } catch {
      setLineItemsPr(prev => prev ? { ...prev, lines: [] } : null);
    } finally {
      setLineItemsLoading(false);
    }
  }, []);

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Are you sure you want to delete this purchase request?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/requests/${id}/`);
      toast.success('Purchase request deleted');
      refetch();
    } catch (err) {
      toast.error('Failed to delete');
    }
  };

  const openFlow = useCallback(async (row) => {
    setFlowPr({ id: row.id, pr_no: row.pr_no });
    setFlowData(null);
    setFlowError(null);
    setFlowSelectedNode(null);
    setFlowLoading(true);
    try {
      const res = await apiClient.get('/api/purchase/lifecycle-graph/', { params: { pr_id: row.id } });
      setFlowData(res.data);
    } catch (err) {
      setFlowError(err.response?.data?.error || 'Failed to load flow data');
    } finally {
      setFlowLoading(false);
    }
  }, []);

  const closeFlow = () => {
    setFlowPr(null);
    setFlowData(null);
    setFlowError(null);
    setFlowSelectedNode(null);
  };

  const handleSkipRfq = useCallback(async (row) => {
    if (!canSkipRfq) {
      toast.error('You are not authorized to skip RFQ.');
      return;
    }
    if (row.approval_status !== 'APPROVED') {
      toast.error('Only approved PRs can skip RFQ');
      return;
    }
    if (!(await confirm({ message: 'Do you want to skip RFQ and create Purchase Order directly from this Purchase Request?' }))) return;
    try {
      const res = await apiClient.post(`/api/purchase/requests/${row.id}/skip-rfq-create-po/`);
      toast.success(res.data?.message || 'PO created (RFQ Skipped)!');
      navigate('/purchase/orders');
    } catch (err) {
      const errData = err.response?.data;
      const errMsg = typeof errData === 'object'
        ? (errData.error || errData.detail || JSON.stringify(errData))
        : 'Failed to create PO';
      toast.error(errMsg);
    }
  }, [navigate, canSkipRfq]);

  const columns = [
    {
      key: 'pr_no', label: 'PR Number', sortable: true,
      render: (value, row) => (
        <div className="flex items-center gap-2">
          <span>{value}</span>
          {row.allow_rfq_skip && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-800 text-[11px] font-medium rounded-full uppercase tracking-wide"
              title="RFQ is skipped for this request — it goes straight to PO"
            >
              <SkipForward size={11} /> RFQ Skipped
            </span>
          )}
        </div>
      ),
    },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true },
    { key: 'product_names', label: 'Products', sortable: false, render: (value) => <ProductsCell names={value} /> },
    {
      key: 'approval_status', label: 'Status', sortable: true,
      render: (value) => <StatusBadge status={value || 'DRAFT'} />,
    },
    { key: 'request_date', label: 'Created', sortable: true, render: (value) => value ? formatDate(value) : '-' },
    { key: 'linked_rfq_no', label: 'Linked RFQ', render: (value, row) => value ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/rfq/${row.linked_rfq}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{value}</button>
    ) : (canCreate('RFQ') && row.approval_status === 'APPROVED' && !row.allow_rfq_skip) ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/rfq/new?pr_id=${row.id}`); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary-700 bg-primary-50 rounded hover:bg-primary-100 transition">
        + Create RFQ
      </button>
    ) : '-' },
    { key: 'skipped_line_count', label: 'RFQ Skip', sortable: false, render: (_, row) => {
      const total = row.line_count || 0;
      const skipped = row.skipped_line_count || 0;
      if (!total || !skipped) return <span className="text-slate-300 text-xs">—</span>;
      return (
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${skipped === total ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-700'}`}
          title={`${skipped} of ${total} product(s) skipped RFQ (direct PO); the rest go through RFQ`}
        >
          {skipped}/{total} skipped
        </span>
      );
    }},
    { key: 'attachments', label: '', sortable: false, render: (_, row) => {
      const files = attachmentsByPr[row.id] || [];
      if (files.length === 0) return <span className="text-slate-300 text-xs">-</span>;
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setAttachmentModal({ prNo: row.pr_no, files });
          }}
          className="relative p-1.5 text-slate-500 hover:text-primary-600 hover:bg-slate-100 rounded transition"
          title={`${files.length} attachment${files.length > 1 ? 's' : ''}`}
        >
          <Paperclip size={16} />
          <span className="absolute -top-1 -right-1 bg-primary-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">{files.length}</span>
        </button>
      );
    }},
    {
      key: 'actions', label: 'Actions', sortable: false,
      render: (value, row) => (
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <ActionButtons moduleName="Purchase Request" editPath={`/purchase/requests/${row.id}`} onDelete={() => handleDelete(row.id)} row={row} />
          <button
            onClick={() => openLineItems(row)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-700 bg-teal-50 rounded-lg hover:bg-teal-100 transition"
            title="View Line Items"
          >
            <List size={13} />
            Products
          </button>
          <button
            onClick={() => openFlow(row)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition"
            title="View Flow"
          >
            <GitBranch size={13} />
            Flow
          </button>
        </div>
      ),
    },
  ];

  // Drop any column whose underlying catalog field is HIDDEN for this
  // role. Only columns that map to a catalog key are eligible; the
  // primary identifier (pr_no), actions, and non-catalog columns
  // (request_date, linked_rfq_no, attachments) are never dropped.
  const visibleColumns = columns.filter(c => {
    const map = {
      warehouse_name: 'warehouse',
      approval_status: 'approval_status',
      priority: 'priority',
      required_by_date: 'required_by_date',
    };
    const key = map[c.key];
    if (!key) return true;
    if (c.key === 'pr_no' || c.key === 'actions') return true;
    return !isHidden(key);
  });

  // Memoized so filtering doesn't re-run on every unrelated re-render — only
  // when the data, the active filter rules, or the search term actually change.
  // Simple-mode dropdown filters — a focused subset (not every PR field):
  // PR no, Status, Requirement Type, Company, Warehouse, Godown, Vendor,
  // Created. Enum fields keep their options; the rest become multi-select
  // dropdowns from the data; Created stays a date.
  const filters = useMemo(() => {
    const KEEP = ['pr_no', 'approval_status', 'requirement_type', 'company_name',
      'warehouse_name', 'godown_name', 'preferred_vendor_name', 'request_date'];
    const distinct = (key) => [...new Set((data || []).map((r) => r[key]).filter((v) => v != null && v !== ''))]
      .sort().map((v) => ({ value: String(v), label: String(v) }));
    return FILTER_FIELDS.filter((f) => KEEP.includes(f.value)).map((f) =>
      f.type === 'select' ? { key: f.value, label: f.label, type: 'select', options: f.options }
      : f.type === 'date' ? { key: f.value, label: f.label, type: 'date' }
      : { key: f.value, label: f.label, type: 'select', options: distinct(f.value) }
    );
  }, [data]);

  const filteredData = useMemo(() => {
    let result = (data || []).filter((row) =>
      filters.every((f) => {
        const sel = filterValues[f.key];
        if (f.type === 'date') return !sel || String(row[f.key] || '').slice(0, 10) === String(sel).slice(0, 10);
        return matchesSelect(row[f.key], sel);
      })
    );
    if (datePeriod !== 'All') {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let from = null, to = null;
      if (datePeriod === 'Today') { from = today; to = today; }
      else if (datePeriod === 'Week') { from = new Date(today); from.setDate(today.getDate() - today.getDay()); to = today; }
      else if (datePeriod === 'Month') { from = new Date(today.getFullYear(), today.getMonth(), 1); to = today; }
      else if (datePeriod === 'FY') {
        const fyStart = today.getMonth() >= 3 ? new Date(today.getFullYear(), 3, 1) : new Date(today.getFullYear() - 1, 3, 1);
        from = fyStart; to = today;
      } else if (datePeriod === 'Custom') {
        if (customRange.from) from = new Date(customRange.from);
        if (customRange.to) to = new Date(customRange.to);
      }
      if (from || to) {
        result = result.filter(row => {
          if (!row.request_date) return false;
          const d = new Date(row.request_date);
          if (from && d < from) return false;
          if (to) { const end = new Date(to); end.setDate(end.getDate() + 1); if (d >= end) return false; }
          return true;
        });
      }
    }
    if (statusFilter !== 'ALL') {
      if (statusFilter === 'RFQ_SKIP') result = result.filter(row => row.allow_rfq_skip);
      else result = result.filter(row => row.approval_status === statusFilter);
    }
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  }, [data, filters, filterValues, searchTerm, datePeriod, customRange, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const pagedData = filteredData.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filteredData.length]);

  // Single export path for both the header and DataTable buttons. Dates are
  // formatted and booleans rendered as Yes/No so the sheet is readable.
  const handleExport = useCallback(() => {
    const rows = filteredData.map(r => ({
      ...r,
      requirement_type: r.requirement_type_display || r.requirement_type || '',
      request_date: r.request_date ? formatDate(r.request_date) : '',
      required_by_date: r.required_by_date ? formatDate(r.required_by_date) : '',
      approved_at: r.approved_at ? formatDate(r.approved_at) : '',
      rfq_skipped: r.allow_rfq_skip ? 'Yes' : 'No',
      po_generated: r.has_po ? 'Yes' : 'No',
    }));
    exportToExcel(rows, EXPORT_COLUMNS, 'purchase-requests');
  }, [filteredData]);

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Purchase Requests"
        subtitle="Manage purchase requests and approvals"
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'Requests (PR)' }]}
        actions={{
          ...(canCreate('Purchase Request') ? { createLink: '/purchase/requests/new', createLabel: 'New PR' } : {}),
        }}
      />
      {/* Single toolbar row: date tabs + search + status dropdown + export */}
      <div className="hidden sm:flex items-center gap-2 px-1 py-1.5">
        {['All', 'Today', 'Week', 'Month', 'FY', 'Custom'].map((p) => (
          <button
            key={p}
            onClick={() => setDatePeriod(p)}
            className={`px-3 py-1 text-[12px] font-medium rounded-md border transition ${
              datePeriod === p
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {p}
          </button>
        ))}
        {datePeriod === 'Custom' && (
          <>
            <input type="date" value={customRange.from} onChange={(e) => setCustomRange(r => ({ ...r, from: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
            <span className="text-[10px] text-slate-400">to</span>
            <input type="date" value={customRange.to} onChange={(e) => setCustomRange(r => ({ ...r, to: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
          </>
        )}
        <div className="flex-1" />
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search PRs…"
            className="h-[30px] w-[160px] text-[12px] border border-slate-200 rounded-md pl-3 pr-7 bg-white focus:ring-1 focus:ring-primary-400 focus:border-primary-400 placeholder-slate-400"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600">
              <X size={10} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-[30px] text-[12px] font-medium text-slate-700 border border-slate-200 rounded-md bg-white cursor-pointer pl-3 pr-8 leading-none appearance-none bg-no-repeat focus:ring-1 focus:ring-primary-400 focus:border-primary-400"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2360594a' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")", backgroundPosition: 'right 8px center', backgroundSize: '12px' }}
        >
          <option value="ALL">Status</option>
          <option value="DRAFT">Draft</option>
          <option value="PENDING">Pending</option>
          <option value="PENDING_APPROVAL">Pending Approval</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="RFQ_SKIP">RFQ Skip</option>
        </select>
        {canExport('Purchase Request') && (
          <button onClick={handleExport} className="h-[30px] px-3 text-[11px] font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50">
            Export
          </button>
        )}
      </div>
      <ListState error={error} onRetry={refetch}>
      {/* Mobile card list — phones get this; desktop gets the table below. */}
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search PR no, warehouse, status…"
        emptyMessage="No purchase requests found"
        config={{
          title: (row) => row.pr_no,
          subtitle: (row) => row.warehouse_name,
          // Created date shown compactly under the status pill instead of
          // as its own body row — frees a line and keeps cards short.
          meta: (row) => formatDate(row.request_date),
          badge: (row) => {
            const s = row.approval_status || 'DRAFT';
            const map = {
              DRAFT:    { label: 'Draft',    cls: 'bg-slate-100 text-slate-700 border-slate-200' },
              EDITED:   { label: 'Edited',   cls: 'bg-amber-100 text-amber-800 border-amber-300' },
              PENDING:  { label: 'Pending',  cls: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
              APPROVED: { label: 'Approved', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
              REJECTED: { label: 'Rejected', cls: 'bg-red-100 text-red-700 border-red-300' },
            };
            return map[s] || { label: s, cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Priority',  value: row.priority },
            { label: 'RFQ',       value: row.linked_rfq_no || (row.allow_rfq_skip ? 'Skip allowed' : null) },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/requests/${row.id}`) },
            { icon: List, label: 'Lines', cls: 'text-teal-700 hover:bg-teal-50', onClick: () => openLineItems(row) },
            { icon: GitBranch, label: 'Flow', cls: 'text-indigo-700 hover:bg-indigo-50', onClick: () => openFlow(row) },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/requests/${row.id}`)}
      />

      {/* Desktop: Compact Rows Table */}
      <div className="hidden sm:block">
        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
          <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className={thCls}>PR Number</th>
                <th className={thCls} style={{ width: 160 }}>Products</th>
                <th className={thCls}>Company</th>
                <th className={thCls}>Warehouse</th>
                <th className={thCls}>Vendor</th>
                <th className={thCls}>Created</th>
                <th className={thCls}>Required By</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>RFQ</th>
                <th className={thCls}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="text-center py-8"><Loader2 size={20} className="animate-spin text-primary-500 inline" /></td></tr>
              ) : pagedData.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-8 text-slate-400 text-[12px]">No purchase requests found</td></tr>
              ) : pagedData.map(row => (
                <tr
                  key={row.id}
                  onClick={() => navigate(`/purchase/requests/${row.id}`)}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-slate-800">{row.pr_no}</span>
                      {row.allow_rfq_skip && (
                        <span className="text-[8px] font-bold uppercase bg-amber-100 text-amber-700 px-1 py-[1px] rounded">Skip</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-slate-600 truncate" style={{ maxWidth: 160 }}>{row.product_names || '—'}</td>
                  <td className="px-2 py-2 text-slate-600 truncate">{row.company_name || '—'}</td>
                  <td className="px-2 py-2 text-slate-600 truncate">{row.warehouse_name || '—'}</td>
                  <td className="px-2 py-2 text-slate-600 truncate">{row.preferred_vendor_name || '—'}</td>
                  <td className="px-2 py-2 text-slate-500">{row.request_date ? formatDate(row.request_date) : '—'}</td>
                  <td className="px-2 py-2 text-slate-500">{row.required_by_date ? formatDate(row.required_by_date) : '—'}</td>
                  <td className="px-2 py-2"><StatusBadge status={row.approval_status || 'DRAFT'} /></td>
                  <td className="px-2 py-2 truncate">
                    {row.linked_rfq_no ? (
                      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/rfq/${row.linked_rfq}`); }} className="text-primary-600 hover:underline font-medium text-[11px]">{row.linked_rfq_no}</button>
                    ) : '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    {/* Fixed-width action slots so the always-present icons line
                        up in the same column on every row. The optional Skip-RFQ
                        button keeps its slot (invisible placeholder) when absent. */}
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      {canSkipRfq && row.approval_status === 'APPROVED' && !row.allow_rfq_skip ? (
                        <button onClick={() => handleSkipRfq(row)} className="p-1 text-amber-600 hover:bg-amber-50 rounded shrink-0" title="Skip RFQ">
                          <SkipForward size={14} />
                        </button>
                      ) : (
                        <span className="p-1 shrink-0" aria-hidden="true"><span className="block w-[14px] h-[14px]" /></span>
                      )}
                      <ActionButtons moduleName="Purchase Request" editPath={`/purchase/requests/${row.id}`} onDelete={() => handleDelete(row.id)} row={row} />
                      <button onClick={() => openLineItems(row)} className="p-1 text-teal-600 hover:bg-teal-50 rounded shrink-0" title="Products">
                        <List size={14} />
                      </button>
                      <button onClick={() => openFlow(row)} className="p-1 text-indigo-600 hover:bg-indigo-50 rounded shrink-0" title="Flow">
                        <GitBranch size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-1 py-2 text-[11px] text-slate-500">
          <span>{(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filteredData.length)} of {filteredData.length}</span>
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const p = totalPages <= 5 ? i + 1 : page <= 3 ? i + 1 : page >= totalPages - 2 ? totalPages - 4 + i : page - 2 + i;
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-7 h-7 rounded text-[11px] font-medium ${p === page ? 'bg-primary-600 text-white' : 'hover:bg-slate-100 text-slate-600'}`}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      </ListState>

      {/* Line Items Modal */}
      {lineItemsPr && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setLineItemsPr(null)} />
          <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[700px] max-h-[80dvh] bg-white rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Product Line Items">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-teal-50 to-white flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-teal-500 flex items-center justify-center">
                  <List size={20} className="text-white" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">Product Line Items</h2>
                  <p className="text-sm text-slate-500">{lineItemsPr.pr_no}</p>
                </div>
              </div>
              <button onClick={() => setLineItemsPr(null)} className="p-2 hover:bg-slate-100 rounded-lg transition">
                <X size={20} className="text-slate-500" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              {lineItemsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={32} className="animate-spin text-teal-500" />
                </div>
              ) : lineItemsPr.lines.length === 0 ? (
                <p className="text-center text-slate-400 py-12">No line items found.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Qty</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItemsPr.lines.map((line, i) => (
                      <tr key={line.id || i} className="border-b border-slate-100 hover:bg-primary-50/40 transition-colors">
                        <td className="px-3 py-2.5 text-slate-500">{line.line_no || i + 1}</td>
                        <td className="px-3 py-2.5 font-medium text-slate-800">{line.product_name || line.product_code || '-'}</td>
                        <td className="px-3 py-2.5 text-slate-500">{line.description_override || '-'}</td>
                        <td className="px-3 py-2.5 text-right font-medium">{line.quantity_requested}</td>
                        <td className="px-3 py-2.5 text-slate-600">{line.uom || '-'}</td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            line.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700' :
                            line.status === 'REJECTED' ? 'bg-red-100 text-red-700' :
                            'bg-slate-100 text-slate-600'
                          }`}>{line.status || 'PENDING'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* Flow Modal */}
      {flowPr && (
        <FlowModal
          prNo={flowPr.pr_no}
          data={flowData}
          loading={flowLoading}
          error={flowError}
          selectedNode={flowSelectedNode}
          onNodeClick={(node) => setFlowSelectedNode(prev => prev?.id === node.id ? null : node)}
          onClose={closeFlow}
        />
      )}

      {/* Attachments Modal */}
      {attachmentModal && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setAttachmentModal(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[80dvh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Attachments"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2 text-slate-800 font-semibold">
                <Paperclip size={16} className="text-primary-600" />
                <span>Attachments — {attachmentModal.prNo}</span>
              </div>
              <button
                onClick={() => setAttachmentModal(null)}
                className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-2">
              {attachmentModal.files.map(f => {
                const sizeKB = f.file_size ? (Number(f.file_size) / 1024).toFixed(1) : null;
                return (
                  <div key={f.id} className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:bg-slate-50">
                    <div className="w-9 h-9 rounded bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <FileText size={16} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate" title={f.file_name}>{f.file_name}</p>
                      <p className="text-xs text-slate-500">
                        Purchase Request{f.file_type ? ` • ${f.file_type}` : ''}{sizeKB ? ` • ${sizeKB} KB` : ''}
                      </p>
                    </div>
                    <a
                      href={f.file}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 bg-primary-600 text-white text-xs font-medium rounded hover:bg-primary-700"
                    >
                      View
                    </a>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}

/* ================================================================
   FLOW MODAL
================================================================ */

function FlowModal({ prNo, data, loading, error, selectedNode, onNodeClick, onClose }) {
  const nodes = data?.nodes || [];
  const edges = data?.edges || [];
  const STAGE_ORDER = { pr: 0, rfq: 1, quote: 2, evaluation: 3, po: 4, grn: 5, freight: 6, bill: 7, payment: 8, credit: 9 };
  const timeline = useMemo(() => {
    const raw = data?.timeline || [];
    return [...raw].sort((a, b) => {
      const dateDiff = new Date(a.date) - new Date(b.date);
      if (dateDiff !== 0) return dateDiff;
      return (STAGE_ORDER[a.type] ?? 99) - (STAGE_ORDER[b.type] ?? 99);
    });
  }, [data?.timeline]);
  const funnel = data?.funnel || [];
  const kpis = data?.kpis || {};

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-4 md:inset-8 lg:inset-12 bg-white rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Purchase Flow">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-indigo-50 to-white flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-500 flex items-center justify-center">
              <GitBranch size={20} className="text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Purchase Flow</h2>
              <p className="text-sm text-slate-500">{prNo}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-2 hover:bg-slate-100 rounded-lg transition">
            <X size={20} className="text-slate-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 sm:space-y-6">
          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 size={40} className="animate-spin text-primary-500 mb-3" />
              <p className="text-slate-500 text-sm">Building lifecycle graph...</p>
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-5 text-center">
              <AlertTriangle size={24} className="text-red-500 mx-auto mb-2" />
              <p className="text-red-700 font-medium">{error}</p>
            </div>
          )}

          {/* Content */}
          {data && !loading && (
            <>
              {/* KPI Row */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <KpiCard icon={ClipboardList} label="PR Status" value={(data.pr?.status || '').replace(/_/g, ' ')} color="primary" />
                <KpiCard icon={Package} label="Documents" value={nodes.length} color="blue" />
                <KpiCard icon={ShoppingCart} label="Ordered Value" value={fmtCurrency(kpis.total_ordered_value)} color="teal" />
                <KpiCard icon={TrendingUp} label="Received Qty" value={kpis.total_received_qty} color="emerald" />
                <KpiCard icon={Receipt} label="Total Billed" value={fmtCurrency(kpis.total_billed)} color="amber" />
                <KpiCard icon={DollarSign} label="Total Paid" value={fmtCurrency(kpis.total_paid)} color="emerald" />
              </div>

              {/* Status Funnel */}
              {funnel.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                  <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-4">Lifecycle Progress</h3>
                  <div className="flex items-center gap-1 overflow-x-auto pb-2">
                    {funnel.map((step, i) => (
                      <div key={step.stage} className="flex items-center flex-shrink-0">
                        <div className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                          step.done ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-50 text-slate-500 border-slate-200'
                        }`}>
                          {step.done ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Clock size={14} className="text-slate-400" />}
                          {step.stage}
                        </div>
                        {i < funnel.length - 1 && <ChevronRight size={16} className="text-slate-300 mx-0.5 flex-shrink-0" />}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Flow Graph */}
              <FlowGraph nodes={nodes} edges={edges} onNodeClick={onNodeClick} selectedNodeId={selectedNode?.id} />

              {/* Timeline */}
              {timeline.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
                  <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-4">Timeline</h3>
                  <div className="relative pl-6 space-y-0">
                    <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-slate-200" />
                    {timeline.map((ev, i) => {
                      const colors = NODE_COLORS[ev.type] || NODE_COLORS.pr;
                      return (
                        <div key={i} className="relative flex items-start gap-3 py-2">
                          <div className={`absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white ${colors.bg} shadow-sm z-10`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-slate-800">{ev.label}</span>
                              <FlowStatusBadge status={ev.status} />
                            </div>
                            <p className="text-xs text-slate-400 mt-0.5">
                              {fmtDate(ev.date)}
                              {ev.actor ? <span className="text-slate-500"> · by <span className="font-medium text-slate-600">{ev.actor}</span></span> : null}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Empty - no data loaded yet */}
          {!data && !loading && !error && (
            <div className="text-center py-16 text-slate-400">
              <GitBranch size={48} className="mx-auto mb-3 opacity-30" />
              <p>No flow data available</p>
            </div>
          )}
        </div>

        {/* Node Detail Panel (inside modal) */}
        {selectedNode && (
          <NodeDetailPanel node={selectedNode} onClose={() => onNodeClick(selectedNode)} />
        )}
      </div>
    </>
  );
}

/* ================================================================
   FLOW GRAPH
================================================================ */

function FlowGraph({ nodes, edges, onNodeClick, selectedNodeId }) {
  const layerOrder = ['pr', 'rfq', 'quote', 'evaluation', 'po', 'grn', 'freight', 'bill', 'payment', 'credit'];
  const layers = useMemo(() => {
    const map = {};
    layerOrder.forEach(t => { map[t] = []; });
    nodes.forEach(n => { if (map[n.type]) map[n.type].push(n); });
    return layerOrder.filter(t => map[t].length > 0).map(t => ({ type: t, nodes: map[t] }));
  }, [nodes]);

  if (nodes.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 shadow-sm overflow-x-auto">
      <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-5">Purchase Flow Graph</h3>
      <div className="flex items-start gap-3 min-w-max pb-4">
        {layers.map((layer, li) => (
          <div key={layer.type} className="flex flex-col items-center gap-2 flex-shrink-0">
            <div className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${NODE_COLORS[layer.type]?.light} ${NODE_COLORS[layer.type]?.text}`}>
              {NODE_LABELS[layer.type]}
            </div>
            <div className="flex flex-col gap-2">
              {layer.nodes.map((node) => {
                const colors = NODE_COLORS[node.type];
                const Icon = NODE_ICONS[node.type] || FileText;
                const isSelected = selectedNodeId === node.id;
                const hasOutgoing = edges.some(e => e.from === node.id);

                return (
                  <div key={node.id} className="flex items-center gap-2">
                    <button
                      onClick={() => onNodeClick(node)}
                      className={`relative flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 transition-all duration-200 cursor-pointer min-w-[140px] max-w-[200px] ${
                        isSelected
                          ? `${colors.border} ${colors.light} ring-2 ${colors.ring} shadow-lg scale-105`
                          : `border-slate-200 bg-white hover:shadow-md`
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg ${colors.bg} flex items-center justify-center flex-shrink-0`}>
                        <Icon size={16} className="text-white" />
                      </div>
                      <div className="text-left min-w-0">
                        <p className="text-xs font-bold text-slate-800 truncate">{node.label}</p>
                        <FlowStatusBadge status={node.status} />
                      </div>
                    </button>
                    {hasOutgoing && li < layers.length - 1 && (
                      <ArrowRight size={16} className="text-slate-300 flex-shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap gap-4">
        {layers.map(l => {
          const c = NODE_COLORS[l.type];
          return (
            <div key={l.type} className="flex items-center gap-1.5 text-xs text-slate-500">
              <div className={`w-3 h-3 rounded-sm ${c.bg}`} />
              <span>{NODE_LABELS[l.type]} ({l.nodes.length})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ================================================================
   KPI CARD
================================================================ */

function KpiCard({ icon: Icon, label, value, color = 'primary' }) {
  const colors = {
    primary: 'from-primary-500 to-primary-600',
    emerald: 'from-emerald-500 to-emerald-600',
    amber: 'from-amber-500 to-amber-600',
    blue: 'from-blue-500 to-blue-600',
    teal: 'from-teal-500 to-teal-600',
  };
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className={`flex-shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br ${colors[color]} flex items-center justify-center`}>
          <Icon size={18} className="text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</p>
          <p className="text-sm font-bold text-slate-800 truncate">{value}</p>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   NODE DETAIL PANEL
================================================================ */

function NodeDetailPanel({ node, onClose }) {
  const colors = NODE_COLORS[node.type] || NODE_COLORS.pr;
  const Icon = NODE_ICONS[node.type] || FileText;
  const d = node.data || {};

  return (
    <div className="absolute inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl border-l z-10 overflow-y-auto">
      <div className={`${colors.bg} text-white p-5`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Icon size={24} />
            <div>
              <p className="text-xs uppercase opacity-80">{NODE_LABELS[node.type]}</p>
              <p className="text-lg font-bold">{node.label}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1 rounded-lg hover:bg-white/20 transition"><X size={20} /></button>
        </div>
        <div className="mt-2"><FlowStatusBadge status={node.status} /></div>
        {node.date && <p className="text-xs opacity-75 mt-1">{fmtDate(node.date)}</p>}
      </div>

      <div className="p-5 space-y-4">
        {node.type === 'pr' && (
          <>
            <DetailRow label="Warehouse" value={d.warehouse} />
            <DetailRow label="Priority" value={d.priority} />
            <DetailRow label="Requested By" value={d.requested_by} />
            <DetailRow label="Approved By" value={d.approved_by} />
            <DetailRow label="Required By" value={fmtDate(d.required_by)} />
            {d.items?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Line Items</p>
                <table className="w-full text-xs">
                  <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40"><th className="px-2 py-1 text-left">Product</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1">UOM</th></tr></thead>
                  <tbody>{d.items.map((it, i) => (
                    <tr key={i} className="border-t"><td className="px-2 py-1">{it.product}</td><td className="px-2 py-1 text-right">{it.qty}</td><td className="px-2 py-1">{it.uom}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        )}

        {node.type === 'quote' && (
          <>
            <DetailRow label="Vendor" value={d.vendor} />
            <DetailRow label="Total Value" value={fmtCurrency(d.total)} />
            <DetailRow label="Payment Terms" value={d.payment_terms} />
            <DetailRow label="Lead Time" value={d.lead_time ? `${d.lead_time} days` : '-'} />
            <DetailRow label="Selected" value={d.chosen ? 'Yes' : 'No'} />
          </>
        )}

        {node.type === 'po' && (
          <>
            <DetailRow label="Vendor" value={d.vendor} />
            <DetailRow label="Warehouse" value={d.warehouse} />
            <DetailRow label="Total Value" value={fmtCurrency(d.total_value)} />
            <DetailRow label="Payment Terms" value={d.payment_terms} />
            <DetailRow label="Expected Delivery" value={fmtDate(d.expected_delivery)} />
          </>
        )}

        {node.type === 'grn' && (
          <>
            <DetailRow label="Vendor" value={d.vendor} />
            <DetailRow label="Warehouse" value={d.warehouse} />
            <DetailRow label="Total Received" value={d.total_received} />
            <DetailRow label="QC Status" value={d.qc_status} />
          </>
        )}

        {node.type === 'freight' && (
          <>
            <DetailRow label="Transporter" value={d.transporter} />
            <DetailRow label="Amount" value={fmtCurrency(d.amount)} />
            <DetailRow label="Freight Terms" value={d.freight_terms} />
          </>
        )}

        {node.type === 'bill' && (
          <>
            <DetailRow label="Vendor" value={d.vendor} />
            <DetailRow label="Invoice No" value={d.invoice_no} />
            <DetailRow label="Total Amount" value={fmtCurrency(d.total)} />
            <DetailRow label="Amount Paid" value={fmtCurrency(d.paid)} />
            <DetailRow label="Due Date" value={fmtDate(d.due_date)} />
          </>
        )}

        {node.type === 'payment' && (
          <>
            <DetailRow label="Amount" value={fmtCurrency(d.amount)} />
            <DetailRow label="Mode" value={(d.mode || '').replace(/_/g, ' ')} />
            <DetailRow label="Reference" value={d.reference} />
          </>
        )}

        {node.type === 'credit' && (
          <>
            <DetailRow label="Type" value={d.type} />
            <DetailRow label="Amount" value={fmtCurrency(d.amount)} />
            <DetailRow label="Reason" value={d.reason} />
          </>
        )}

        {node.type === 'evaluation' && (
          <>
            <DetailRow label="Recommended Vendor" value={d.recommended_vendor} />
            <DetailRow label="Justification" value={d.justification} />
          </>
        )}

        {node.type === 'rfq' && (
          <>
            <DetailRow label="Mode" value={d.mode} />
            <DetailRow label="Quotes Received" value={`${d.quote_count} / ${d.expected_quotes}`} />
          </>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  if (!value || value === '-') return null;
  return (
    <div className="flex justify-between text-sm py-1 border-b border-slate-50">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800 text-right max-w-[60%] break-words">{value}</span>
    </div>
  );
}
