import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Search,
  Loader2,
  CheckCircle2,
  XCircle,
  Star,
  FileText,
  Download,
  AlertTriangle,
  ChevronRight,
  Truck,
  CreditCard,
  Package,
  Pencil,
  List,
  BarChart3,
  Trash2,
  RefreshCw,
  Send,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { Eye } from 'lucide-react';
import apiClient, { getErrorMessage } from '../../../utils/api.js';
import { formatCurrency, formatDate, formatNumber } from '../../../utils/formatters.js';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import { confirm } from '@/components/common/confirm';

const FILTER_FIELDS = [
  { value: 'evaluation_id', label: 'Evaluation ID', type: 'text' },
  { value: 'rfq_no', label: 'RFQ', type: 'text' },
  { value: 'evaluation_date', label: 'Evaluation Date', type: 'date' },
  { value: 'evaluated_by_name', label: 'Evaluated By', type: 'text' },
  { value: 'recommended_vendor_name', label: 'Recommended Vendor', type: 'text' },
  { value: 'approval_status', label: 'Approval Status', type: 'select', options: [
    { value: 'Pending', label: 'Pending' }, { value: 'Approved', label: 'Approved' }, { value: 'Rejected', label: 'Rejected' },
  ]},
];

export default function QuoteEvaluationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { canCreate, canExport } = usePermissions();

  // Tab state - default to dashboard
  const [activeTab, setActiveTab] = useState('dashboard');
  // Lifted so the Evaluation List's Filters button can sit on the same
  // row as the tab switcher (saves a row, esp. on mobile).
  const [showListFilters, setShowListFilters] = useState(false);

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Quote Evaluations"
        subtitle={activeTab === 'list' ? 'View and manage all evaluations' : 'Compare vendor quotes and select the best offer'}
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'Evaluations' }]}
        actions={{
          ...(canCreate('Quote Evaluation')
            ? { createLink: '/purchase/evaluations/new', createLabel: 'New Evaluation' }
            : {}),
        }}
      />

      {/* Tab Switcher — on the Evaluation List tab the Filters button
          sits on this same row (right) instead of a separate row below. */}
      <div className="flex items-center justify-between gap-2 mb-4 sm:mb-6">
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md text-sm font-medium transition ${
              activeTab === 'dashboard'
                ? 'bg-white text-primary-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            <BarChart3 size={16} />
            Quote Evaluation
          </button>
          <button
            onClick={() => setActiveTab('list')}
            className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md text-sm font-medium transition ${
              activeTab === 'list'
                ? 'bg-white text-primary-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            <List size={16} />
            Evaluation List
          </button>
        </div>
        {activeTab === 'list' && (
          <button
            onClick={() => setShowListFilters((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition shrink-0"
          >
            <Search size={14} /> Filters
          </button>
        )}
      </div>

      {activeTab === 'list'
        ? <EvaluationListTab showFilters={showListFilters} setShowFilters={setShowListFilters} />
        : <EvaluationDashboardTab />}
    </MainLayout>
  );
}

/* ===== EVALUATION LIST TAB ===== */
function EvaluationListTab({ showFilters, setShowFilters }) {
  const navigate = useNavigate();
  // canExport belongs here, not to the parent page: this is the component
  // that renders the DataTable holding the Export button.
  const { canEdit, canDelete, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Quote Evaluation');
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/evaluations/');

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.evaluation_id}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/evaluations/${row.id}/`);
      toast.success(`${row.evaluation_id} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };
  const [searchTerm, setSearchTerm] = useState('');
  const filter = useUnifiedFilter(FILTER_FIELDS);

  const columns = [
    { key: 'evaluation_id', label: 'Evaluation ID', sortable: true },
    { key: 'linked_pr_numbers', label: 'PR No', sortable: false,
      render: (value, row) => {
        if (!value || !Array.isArray(value) || value.length === 0) return '-';
        const prIds = Array.isArray(row.linked_pr_ids) ? row.linked_pr_ids : [];
        return value.map((prNo, i) => (
          <span key={i}>{i > 0 && ', '}{prIds[i] ? (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{prNo}</button>
          ) : prNo}</span>
        ));
      },
    },
    { key: 'product_names', label: 'Products', sortable: false, render: (value) => <ProductsCell names={value} /> },
    { key: 'rfq', label: 'RFQ', sortable: true,
      render: (value, row) => {
        const display = row.rfq_no || (typeof value === 'string' && value.length > 20 ? value.substring(0, 8) + '...' : value || '-');
        return row.rfq ? (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/rfq/${row.rfq}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{display}</button>
        ) : display;
      },
    },
    {
      key: 'evaluation_date', label: 'Evaluation Date', sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    { key: 'evaluated_by', label: 'Evaluated By', sortable: true,
      render: (value, row) => row.evaluated_by_name || '-',
    },
    { key: 'recommended_vendor_name', label: 'Recommended Vendor', sortable: true },
    {
      key: 'approval_status', label: 'Status',
      render: (value, row) => <StatusBadge status={row.approval_status_display || value} />,
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Quote Evaluation') && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/evaluations/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {canDelete('Quote Evaluation') && (
            <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const CATALOG_KEYS = ['evaluation_id', 'rfq', 'recommended_vendor', 'best_quote_flag', 'justification_notes', 'approval_status'];
  const NEVER_HIDE = ['actions', 'evaluation_id'];
  const visibleColumns = columns.filter((col) => {
    if (NEVER_HIDE.includes(col.key)) return true;
    let derivedKey = col.key;
    for (const suffix of ['_name', '_code', '_display']) {
      if (derivedKey.endsWith(suffix)) {
        const stripped = derivedKey.slice(0, -suffix.length);
        if (CATALOG_KEYS.includes(stripped)) { derivedKey = stripped; break; }
      }
    }
    return !isHidden(derivedKey);
  });

  const filteredData = (() => {
    let result = filter.filterData(data || []);
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  })();

  return (
    <>
      <UnifiedFilterPanel filterFields={FILTER_FIELDS} filter={filter} showFilters={showFilters} onClose={() => setShowFilters(false)} />
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search evaluation, RFQ…"
        emptyMessage="No quote evaluations found"
        config={{
          title: (row) => row.rfq_no || row.id,
          subtitle: (row) => row.recommended_vendor_name || row.evaluated_by_name,
          badge: (row) => {
            const s = row.approval_status_display || row.approval_status;
            return { label: s || '-', cls: s === 'APPROVED' ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-700 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Date',     value: formatDate(row.evaluation_date) },
            { label: 'By',       value: row.evaluated_by_name },
            { label: 'PRs',      value: (row.linked_pr_numbers || []).join(', ') || null },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/evaluations/${row.id}`) },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/evaluations/${row.id}`)}
      />
      <div className="hidden sm:block">
        <DataTable persistKey="purchase-evaluations" exportFileName="quote-evaluations" canExport={canExport('Quote Evaluation')} columns={visibleColumns} data={filteredData} isLoading={isLoading} onRowClick={(row) => navigate(`/purchase/evaluations/${row.id}`)} />
      </div>
      </ListState>
    </>
  );
}

/* ===== EVALUATION DASHBOARD TAB ===== */
function EvaluationDashboardTab() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { canCreate } = usePermissions();

  // PR selection — fetch fresh (no cache) so deleted POs reflect immediately
  const [prRaw, setPrRaw] = useState([]);
  const [prLoading, setPrLoading] = useState(false);
  const [rfqRaw, setRfqRaw] = useState([]);
  const fetchPrAndRfqLists = useCallback(() => {
    setPrLoading(true);
    return Promise.all([
      apiClient.get('/api/purchase/requests/', { params: { page_size: 500 } }),
      apiClient.get('/api/purchase/rfq/', { params: { page_size: 500 } }),
    ]).then(([prRes, rfqRes]) => {
      setPrRaw(prRes.data?.results || prRes.data || []);
      setRfqRaw(rfqRes.data?.results || rfqRes.data || []);
    }).catch(() => { setPrRaw([]); setRfqRaw([]); })
      .finally(() => setPrLoading(false));
  }, []);
  useEffect(() => { fetchPrAndRfqLists(); }, [fetchPrAndRfqLists]);
  const prIdFromUrl = searchParams.get('pr_id');
  const rfqIdFromUrl = searchParams.get('rfq_id');
  // `has_po` always wins. Previously the URL `?pr_id=` clause overrode
  // the has-PO check, so a PR you just evaluated + converted to a PO
  // stayed in the dropdown if it happened to be the URL PR. Now any PR
  // with an active PO is dropped regardless of URL, and the URL-prefill
  // only relaxes the APPROVED + linked-RFQ gate (handy when the
  // operator wants to inspect an evaluation row that doesn't quite fit
  // the default eligibility — but never if the PR is already done).
  const prOptions = prRaw
    // Keep a PR until EVERY product is converted (independent evaluation) —
    // a partially-converted PR must stay so the rest can be evaluated.
    .filter(p => !p.fully_converted && (
      (p.approval_status === 'APPROVED' && p.linked_rfq) || p.id === prIdFromUrl
    ))
    .map(p => ({
      value: p.id,
      label: `${p.pr_no} | ${p.warehouse_name || ''} | ${p.approval_status}${p.linked_rfq_no ? ' | RFQ: ' + p.linked_rfq_no : ''}`,
    }));
  const rfqOptions = rfqRaw.map(r => ({
    value: r.id,
    label: `${r.rfq_no} | ${r.rfq_status || ''}`,
  }));
  const [selectedPrId, setSelectedPrId] = useState('');
  const [directRfqId, setDirectRfqId] = useState('');

  // Auto-select from query params
  useEffect(() => {
    if (prIdFromUrl && prRaw.length > 0 && !selectedPrId) {
      setSelectedPrId(prIdFromUrl);
    }
  }, [prIdFromUrl, prRaw]);

  useEffect(() => {
    if (rfqIdFromUrl && !directRfqId) {
      setDirectRfqId(rfqIdFromUrl);
    }
  }, [rfqIdFromUrl]);

  // Dashboard data
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Evaluation state — per-product award: { productId: winning quote_line_id }.
  // Each product can go to a different vendor; PO generation clubs by vendor.
  const [productAwards, setProductAwards] = useState({});
  const [vendorNotes, setVendorNotes] = useState({});
  const [autoGeneratePO, setAutoGeneratePO] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [createdPO, setCreatedPO] = useState(null);
  const [createdPOs, setCreatedPOs] = useState([]);

  // Load dashboard data
  const loadDashboard = async () => {
    const params = {};
    if (selectedPrId) {
      params.pr_id = selectedPrId;
    } else if (directRfqId) {
      params.rfq_id = directRfqId;
    } else {
      toast.error('Please select a Purchase Request or RFQ');
      return;
    }
    setLoading(true);
    setError(null);
    setDashboardData(null);
    setProductAwards({});
    setVendorNotes({});
    setCreatedPO(null);
    setCreatedPOs([]);

    try {
      const res = await apiClient.get('/api/purchase/evaluation-dashboard/', { params });
      const pr = res.data?.pr || res.data?.purchase_request;
      // A skip-RFQ request goes straight to a PO — there's no RFQ/quote to
      // evaluate, so block the evaluation view with a clear message.
      if (pr?.allow_rfq_skip) {
        toast.error(`RFQ was skipped for ${pr.pr_no || 'this request'} — no evaluation can be made.`);
        setDashboardData(null);
        setError('RFQ was skipped for this request — evaluation is not applicable.');
        return;
      }
      setDashboardData(res.data);
      // POs already created for this PR — so the "Send" actions show even
      // after a reload (not just right after submitting in this session).
      setCreatedPOs(res.data?.pos || []);
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Extract data from response
  const prSummary = dashboardData?.pr || dashboardData?.purchase_request || null;
  const vendors = dashboardData?.vendors || dashboardData?.quotes || [];
  const prItems = dashboardData?.items || dashboardData?.pr_items || prSummary?.items || [];

  // Build comparison data
  const comparisonData = useMemo(() => {
    const rfqs = dashboardData?.rfqs || [];
    const apiComparison = dashboardData?.comparison || null;

    let allQuotes = [];
    rfqs.forEach((rfq) => {
      (rfq.quotes || []).forEach((q) => {
        allQuotes.push({ ...q, rfq_no: rfq.rfq_no });
      });
    });

    if (allQuotes.length === 0 && vendors && vendors.length > 0) {
      allQuotes = vendors;
    }

    if (allQuotes.length === 0) return { products: [], vendorList: [] };

    const vendorList = allQuotes.map((v) => ({
      id: v.id || v.vendor_id || v.quote_id,
      vendorId: v.vendor_id || v.id,
      vendorName: v.vendor_name || v.vendor?.name || v.vendor || 'Unknown',
      quoteNo: v.quote_id || v.quote_no || v.quote_number || v.rfq_no || '',
      quoteUuid: v.id,
      deliveryDays: v.lead_time_days || v.delivery_days || v.delivery_period || v.lead_time || null,
      paymentTerms: v.payment_terms || v.terms || '',
      totalValue: v.total_cost || v.total_value || v.total || v.grand_total || 0,
      gstPercent: v.gst_percent || v.gst || v.tax_percent || 0,
      lines: v.lines || v.items || v.quote_lines || [],
    }));

    let products = [];

    if (apiComparison && apiComparison.products && apiComparison.products.length > 0) {
      products = apiComparison.products.map((p) => {
        const prod = {
          id: p.product_code || p.product_name,
          name: p.product_name,
          uom: p.uom || '',
          requestedQty: p.requested_qty,
          lowestPrice: 0,
          lowestTotal: 0,
          converted: !!p.converted,
          convertedPoNo: p.converted_po_no || '',
          convertedVendor: p.converted_vendor || '',
        };

        let lowestPrice = Infinity;
        let lowestTotal = Infinity;
        (p.vendor_prices || []).forEach((vp) => {
          const price = parseFloat(vp.unit_price || 0);
          const total = parseFloat(vp.total || 0);
          if (price > 0 && price < lowestPrice) lowestPrice = price;
          if (total > 0 && total < lowestTotal) lowestTotal = total;
        });
        prod.lowestPrice = lowestPrice === Infinity ? 0 : lowestPrice;
        prod.lowestTotal = lowestTotal === Infinity ? 0 : lowestTotal;

        (p.vendor_prices || []).forEach((vp) => {
          // Strict match by quote UUID / quote number only — matching by vendor
          // name/id breaks when multiple quotes come from the same vendor.
          const vendor = vendorList.find(
            (v) => (vp.quote_uuid && String(v.quoteUuid) === String(vp.quote_uuid)) ||
                   (vp.quote_id && String(v.quoteNo) === String(vp.quote_id))
          );
          if (vendor) {
            const existingLine = vendor.lines.find(
              (l) => (l.product_code === p.product_code || l.product_name === p.product_name)
            );
            if (!existingLine) {
              vendor.lines.push({
                product_code: p.product_code,
                product_name: p.product_name,
                product_id: p.product_code || p.product_name,
                unit_price: vp.unit_price,
                quantity: vp.quantity,
                qty: vp.quantity,
                gst: vp.gst,
                total: vp.total,
                delivery_days: vp.delivery_days,
                payment_terms: vp.payment_terms,
                has_line_detail: vp.has_line_detail,
                quote_line_id: vp.quote_line_id,
                quoted: vp.quoted,
              });
            } else {
              // Augment pre-existing quote line with comparison fields (quote
              // lines use quantity_offered, not quantity — merge so rendering works).
              if (existingLine.unit_price == null) existingLine.unit_price = vp.unit_price;
              if (existingLine.quantity == null) existingLine.quantity = vp.quantity;
              if (existingLine.qty == null) existingLine.qty = vp.quantity;
              if (existingLine.gst == null) existingLine.gst = vp.gst;
              if (existingLine.total == null) existingLine.total = vp.total;
              if (existingLine.delivery_days == null) existingLine.delivery_days = vp.delivery_days;
              if (!existingLine.payment_terms) existingLine.payment_terms = vp.payment_terms;
              if (existingLine.quote_line_id == null) existingLine.quote_line_id = vp.quote_line_id;
              if (existingLine.quoted == null) existingLine.quoted = vp.quoted;
            }
          }
        });

        return prod;
      });
    } else {
      const productMap = {};
      vendorList.forEach((vendor) => {
        vendor.lines.forEach((line) => {
          const productKey = line.product_id || line.product || line.item_id || line.pr_line_id || line.product_name;
          if (!productMap[productKey]) {
            productMap[productKey] = {
              id: productKey,
              name: line.product_name || line.product?.name || line.item_name || line.description || 'Unknown Product',
              uom: line.uom || line.unit || '',
            };
          }
        });
      });

      prItems.forEach((item) => {
        const key = item.product_id || item.product || item.id;
        if (!productMap[key]) {
          productMap[key] = {
            id: key,
            name: item.product_name || item.product?.name || item.description || 'Unknown',
            uom: item.uom || item.unit || '',
            requestedQty: item.quantity || item.qty || 0,
          };
        } else {
          productMap[key].requestedQty = item.quantity || item.qty || 0;
        }
      });

      products = Object.values(productMap);

      products.forEach((product) => {
        let lowestPrice = Infinity;
        let lowestTotal = Infinity;
        vendorList.forEach((vendor) => {
          const line = vendor.lines.find(
            (l) => (l.product_id || l.product || l.item_id || l.pr_line_id || l.product_name) === product.id
          );
          if (line) {
            const price = parseFloat(line.unit_price || line.price || 0);
            const total = parseFloat(line.total || line.line_total || line.amount || 0);
            if (price > 0 && price < lowestPrice) lowestPrice = price;
            if (total > 0 && total < lowestTotal) lowestTotal = total;
          }
        });
        product.lowestPrice = lowestPrice === Infinity ? 0 : lowestPrice;
        product.lowestTotal = lowestTotal === Infinity ? 0 : lowestTotal;
      });
    }

    let bestTotalValue = Infinity;
    vendorList.forEach((v) => {
      const total = parseFloat(v.totalValue || 0);
      if (total > 0 && total < bestTotalValue) bestTotalValue = total;
    });

    return { products, vendorList, bestTotalValue };
  }, [dashboardData, vendors, prItems]);

  // Per-product award helpers.
  const awardsCount = Object.values(productAwards).filter(Boolean).length;
  // PO plan: group the current awards by vendor (one PO per vendor).
  const poPlan = useMemo(() => {
    const products = dashboardData?.comparison?.products || [];
    const byVendor = {};
    products.forEach((p) => {
      const qlId = productAwards[p.product_code || p.product_name];
      if (!qlId) return;
      const vp = (p.vendor_prices || []).find((x) => String(x.quote_line_id) === String(qlId));
      if (!vp) return;
      byVendor[vp.vendor_name] = byVendor[vp.vendor_name] || [];
      byVendor[vp.vendor_name].push(p.product_name);
    });
    return byVendor;
  }, [dashboardData, productAwards]);

  // A PO was already generated for this PR once any quote on it has been
  // chosen (chosen_flag). The backend rejects a second submit with
  // "already accepted in a prior evaluation" — surface that up front by
  // disabling the submit button instead of letting the click fail.
  const alreadyEvaluated = useMemo(() => {
    const fromRfqs = (dashboardData?.rfqs || []).flatMap((r) => r.quotes || []);
    const pool = fromRfqs.length ? fromRfqs : (dashboardData?.vendors || dashboardData?.quotes || []);
    return pool.some((q) => q?.chosen_flag);
  }, [dashboardData]);

  // Per-product award: pick the winning vendor for ONE product (by its quote
  // line). Clicking the same winner again clears it; OTHER products are left
  // untouched — so 3 products can be awarded to 3 different vendors.
  // Convert ONE product to a PO independently — award just this product's
  // winning vendor and generate its PO, leaving the rest of the evaluation
  // open. The backend is idempotent (a product already on a PO is skipped).
  const [convertingId, setConvertingId] = useState(null);
  const convertProduct = async (product) => {
    const qlId = productAwards[product.id];
    if (!qlId) { toast.error('Approve a vendor for this product first.'); return; }
    const prId = dashboardData?.pr?.id || selectedPrId;
    if (!prId) { toast.error('No Purchase Request context.'); return; }
    // Confirm before converting an offer whose quantity differs from the
    // PR's requested quantity — the PO is created for the OFFERED qty.
    const qtyMismatches = collectQtyMismatches([qlId]);
    if (qtyMismatches.length > 0) {
      const ok = await confirm({
        message: `Vendor quantity differs from the requested quantity:\n${qtyMismatches.join('\n')}\nThe PO will be created for the vendor's offered quantity. Continue?`,
        confirmLabel: 'Continue',
      });
      if (!ok) return;
    }
    setConvertingId(product.id);
    try {
      const res = await apiClient.post('/api/purchase/evaluation-dashboard/submit/', {
        pr_id: prId, generate_po: true, awards: [qlId],
      });
      const po = res.data?.pos?.[0];
      toast.success(po ? `${product.name} → ${po.po_no} created.` : 'Converted to PO.');
      await loadDashboard();  // reflect converted status, keep the rest open
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to convert to PO.');
    } finally {
      setConvertingId(null);
    }
  };

  const awardProduct = (productId, quoteLineId) => {
    if (!quoteLineId) return;
    setProductAwards((prev) => {
      if (String(prev[productId]) === String(quoteLineId)) {
        const next = { ...prev };
        delete next[productId];
        return next;
      }
      return { ...prev, [productId]: quoteLineId };
    });
  };

  const handleNotesChange = (vendorId, text) => {
    setVendorNotes((prev) => ({ ...prev, [String(vendorId)]: text }));
  };

  // Submit evaluation. The "Save Draft" path was removed — the backend
  // submit endpoint never actually persisted drafts (it always required
  // at least one ACCEPTED quote and either generated a PO or didn't),
  // so a Save Draft click would have 400'd anyway. The Evaluation is now
  // a single-step Submit action.
  const handleSubmit = async () => {
    const awards = Object.values(productAwards).filter(Boolean);
    if (awards.length === 0) {
      toast.error('Award at least one product to a vendor before submitting.');
      return;
    }

    // Confirm before awarding any line whose offered quantity differs from
    // the PR's requested quantity — POs are created for the OFFERED qty.
    const qtyMismatches = collectQtyMismatches(awards);
    if (qtyMismatches.length > 0) {
      const ok = await confirm({
        message: `Vendor quantity differs from the requested quantity:\n${qtyMismatches.join('\n')}\nThe PO will be created for the vendor's offered quantity. Continue?`,
        confirmLabel: 'Continue',
      });
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      const payload = {
        pr_id: selectedPrId,
        generate_po: autoGeneratePO,
        awards, // winning quote-line ids, one per product
      };
      const res = await apiClient.post('/api/purchase/evaluation-dashboard/submit/', payload);
      toast.success(res.data?.message || 'Evaluation submitted.');
      setCreatedPOs(res.data?.pos || []);
      // Refetch the PR list so the just-evaluated PR drops out of the dropdown.
      fetchPrAndRfqLists();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Helper to get line data for a vendor + product combo
  const getVendorLine = (vendor, productId) => {
    return vendor.lines.find(
      (l) =>
        (l.product_id || l.product || l.item_id || l.pr_line_id || l.product_name) === productId ||
        l.product_code === productId ||
        l.product_name === productId
    );
  };

  // Trim trailing zeros on quantities (250, 12.5 — never 250.00).
  const fmtQty = (v) => formatNumber(v, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  // Given the quote-line ids being awarded, collect a bullet line for every
  // one whose offered quantity differs from the PR's requested quantity —
  // used to confirm before generating a PO for the vendor's quantity.
  const collectQtyMismatches = (awardIds) => {
    const idSet = new Set((awardIds || []).map(String));
    const out = [];
    comparisonData.products.forEach((product) => {
      const reqQty = parseFloat(product.requestedQty);
      if (!Number.isFinite(reqQty) || reqQty <= 0) return;
      comparisonData.vendorList.forEach((vendor) => {
        const line = getVendorLine(vendor, product.id);
        if (!line?.quote_line_id || !idSet.has(String(line.quote_line_id))) return;
        const offered = parseFloat(line.quantity || line.qty || line.quantity_offered || 0);
        if (!Number.isFinite(offered) || offered <= 0 || offered === reqQty) return;
        out.push(`• ${product.name}: offered ${fmtQty(offered)} vs requested ${fmtQty(reqQty)}${product.uom ? ` ${product.uom}` : ''}`);
      });
    });
    return out;
  };

  return (
    <>
      {/* PR / RFQ Selection */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 sm:items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Select Purchase Request
            </label>
            <CustomSelect
              value={selectedPrId}
              onChange={(e) => { setSelectedPrId(e.target.value); }}
              className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white"
              disabled={prLoading}
            >
              <option value="">
                {prLoading ? 'Loading...' : '-- Select Purchase Request --'}
              </option>
              {prOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </CustomSelect>
          </div>
          <button
            onClick={loadDashboard}
            disabled={!selectedPrId || loading}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 sm:px-6 py-2.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            Load
          </button>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={32} className="animate-spin text-primary-600" />
          <span className="ml-3 text-slate-500">Loading evaluation data...</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 sm:p-6 mb-4 sm:mb-6 text-center">
          <AlertTriangle size={32} className="mx-auto mb-2 text-red-400" />
          <p className="text-red-700 font-medium">{error}</p>
          <button onClick={loadDashboard} className="mt-3 text-sm text-red-600 underline hover:text-red-800">
            Try Again
          </button>
        </div>
      )}

      {/* Dashboard content */}
      {dashboardData && !loading && (
        <>
          {/* PR Summary */}
          {prSummary && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-800 mb-3 flex items-center gap-2">
                <FileText size={20} className="text-primary-600" />
                PR Summary
              </h2>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-semibold text-slate-900">
                  {prSummary.pr_no || prSummary.pr_number || '-'}
                </span>
                <span className="text-slate-400">|</span>
                <span className="text-slate-600">{prSummary.warehouse_name || prSummary.warehouse || ''}</span>
                <span className="text-slate-400">|</span>
                <StatusBadge status={prSummary.approval_status || prSummary.status || 'APPROVED'} />
                {prSummary.priority && (
                  <>
                    <span className="text-slate-400">|</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                      prSummary.priority === 'HIGH' || prSummary.priority === 'URGENT'
                        ? 'bg-red-100 text-red-700'
                        : prSummary.priority === 'MEDIUM'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}>
                      {prSummary.priority}
                    </span>
                  </>
                )}
                <span className="text-slate-400">|</span>
                <span className="text-slate-600">
                  {formatDate(prSummary.created_at || prSummary.date || prSummary.pr_date)}
                </span>
              </div>
              {prItems.length > 0 && (
                <div className="mt-3 text-sm text-slate-600">
                  <span className="font-medium">Items: </span>
                  {prItems.map((item) => `${item.product_name || item.description || 'Item'} (${item.quantity || item.qty || 0} ${item.uom || item.unit || ''})`).join(', ')}
                </div>
              )}
            </div>
          )}

          {/* No quotes */}
          {comparisonData.vendorList.length === 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-8 mb-4 sm:mb-6 text-center">
              <AlertTriangle size={40} className="mx-auto mb-3 text-yellow-500" />
              <h3 className="text-lg font-semibold text-yellow-800 mb-1">No Quotes Found</h3>
              <p className="text-yellow-700 text-sm">
                No vendor quotes have been received for this Purchase Request yet. Please create RFQs and collect quotes first.
              </p>
              <button onClick={() => navigate('/purchase/rfq/new')} className="mt-4 px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-700 transition">
                Create RFQ
              </button>
            </div>
          )}

          {/* Vendor Comparison Table */}
          {comparisonData.vendorList.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 mb-4 sm:mb-6 shadow-sm">
              <div className="p-4 sm:p-6 border-b border-slate-200">
                <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                  <Package size={20} className="text-primary-600" />
                  Vendor Comparison Table
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  {comparisonData.vendorList.length} vendor(s) &middot; {comparisonData.products.length} product(s)
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200">
                      <th className="sticky left-0 z-10 bg-slate-50 text-left px-4 sm:px-6 py-4 font-semibold text-slate-700 min-w-[200px] border-r border-slate-200">
                        Product
                      </th>
                      {comparisonData.vendorList.map((vendor) => (
                        <th key={vendor.id} className="text-center px-4 sm:px-6 py-4 min-w-[200px]">
                          <div className="font-semibold text-slate-800">{vendor.vendorName}</div>
                          {vendor.quoteNo && <div className="text-xs text-slate-500 mt-1">{vendor.quoteNo}</div>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonData.products.map((product) => {
                      // The LONGEST NET payment term among vendors for this
                      // product is the most favourable (more credit) → flag it
                      // green + star, like the best price.
                      const parseNetDays = (t) => {
                        const s = String(t || '');
                        const m = s.match(/(\d+)/);
                        return m ? parseInt(m[1], 10) : (/cash/i.test(s) ? 0 : -1);
                      };
                      const maxNet = Math.max(-1, ...comparisonData.vendorList.map((v) => {
                        const l = getVendorLine(v, product.id);
                        return l ? parseNetDays(l.payment_terms || '') : -1;
                      }));
                      return (
                      <>
                        {/* Product header row */}
                        <tr key={`header-${product.id}`} className="bg-slate-100 border-b border-slate-200">
                          <td className="sticky left-0 z-10 bg-slate-100 px-4 sm:px-6 py-3 font-semibold text-slate-800 border-r border-slate-200">
                            <div>
                              {product.name}
                              {product.requestedQty && (
                                <span className="ml-2 text-xs text-slate-500 font-normal">(Req: {product.requestedQty} {product.uom})</span>
                              )}
                            </div>
                            {product.converted ? (
                              <span
                                className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded"
                                title={`Converted${product.convertedVendor ? ` · ${product.convertedVendor}` : ''} · ${product.convertedPoNo}`}
                              >
                                <CheckCircle2 size={12} /> {product.convertedPoNo}
                              </span>
                            ) : (productAwards[product.id] && canCreate('Quote Evaluation')) ? (
                              <button
                                type="button"
                                onClick={() => convertProduct(product)}
                                disabled={convertingId === product.id}
                                className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 bg-primary-600 text-white rounded-lg text-[11px] font-medium hover:bg-primary-700 disabled:opacity-50 whitespace-nowrap"
                              >
                                {convertingId === product.id ? <Loader2 size={12} className="animate-spin" /> : <Package size={12} />} Convert to PO
                              </button>
                            ) : null}
                          </td>
                          {comparisonData.vendorList.map((vendor) => (
                            <td key={`${product.id}-${vendor.id}-header`} className="text-center px-4 sm:px-6 py-3 bg-slate-100" />
                          ))}
                        </tr>

                        {/* Detail rows */}
                        {['unit_price', 'quantity', 'gst', 'total', 'delivery', 'payment'].map((field) => (
                          <tr key={`${product.id}-${field}`} className="border-b border-slate-100 hover:bg-primary-50/40 transition-colors">
                            <td className="sticky left-0 z-10 bg-white px-4 sm:px-6 py-2.5 text-slate-600 pl-10 border-r border-slate-200">
                              {field === 'unit_price' && 'Unit Price'}
                              {field === 'quantity' && 'Quantity'}
                              {field === 'gst' && 'GST'}
                              {field === 'total' && 'Total'}
                              {field === 'delivery' && 'Delivery'}
                              {field === 'payment' && 'Payment Terms'}
                            </td>
                            {comparisonData.vendorList.map((vendor) => {
                              const line = getVendorLine(vendor, product.id);
                              const isAwarded = line?.quote_line_id && String(productAwards[product.id]) === String(line.quote_line_id);
                              const cellBg = isAwarded ? 'bg-green-50/60' : '';

                              if (!line) {
                                return <td key={`${product.id}-${vendor.id}-${field}`} className={`text-center px-4 sm:px-6 py-2.5 text-slate-400 ${cellBg}`}>--</td>;
                              }

                              const unitPrice = parseFloat(line.unit_price || line.price || 0);
                              const qty = parseFloat(line.quantity || line.qty || line.quantity_offered || 0);
                              const gst = parseFloat(line.gst_percent || line.gst || line.tax_percent || vendor.gstPercent || 0);
                              const total = parseFloat(line.total || line.line_total || line.amount || unitPrice * qty || 0);
                              // Delivery + payment are per-quoted-line only — no fallback to the
                              // vendor's quote-level value, so an unquoted product stays blank.
                              const delivery = line.delivery_days || line.delivery || null;
                              const payment = line.payment_terms || '';

                              const isBestPrice = field === 'unit_price' && unitPrice > 0 && unitPrice <= product.lowestPrice;
                              const isBestTotal = field === 'total' && total > 0 && total <= product.lowestTotal;
                              const isBestPayment = field === 'payment' && maxNet > 0 && parseNetDays(payment) === maxNet;
                              // Offered vs requested quantity mismatch — amber Short/Over badge
                              // next to the offered quantity so it's visible at a glance.
                              const reqQty = parseFloat(product.requestedQty);
                              const qtyMismatch =
                                field === 'quantity' && qty > 0 &&
                                Number.isFinite(reqQty) && reqQty > 0 && qty !== reqQty;

                              let cellContent = '--';
                              if (field === 'unit_price') cellContent = unitPrice > 0 ? formatCurrency(unitPrice) : '--';
                              else if (field === 'quantity') cellContent = qty > 0 ? `${formatNumber(qty, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${product.uom}` : '--';
                              else if (field === 'gst') cellContent = gst > 0 ? `${gst}%` : '--';
                              else if (field === 'total') cellContent = total > 0 ? formatCurrency(total) : '--';
                              else if (field === 'delivery') cellContent = delivery ? `${delivery} days` : '--';
                              else if (field === 'payment') cellContent = payment || '--';

                              return (
                                <td key={`${product.id}-${vendor.id}-${field}`} className={`text-center px-4 sm:px-6 py-2.5 ${cellBg}`}>
                                  <span className={`inline-flex items-center gap-1 ${isBestPrice || isBestTotal || isBestPayment ? 'text-green-700 font-semibold' : 'text-slate-700'}`}>
                                    {cellContent}
                                    {(isBestPrice || isBestTotal || isBestPayment) && <Star size={14} className="text-amber-500 fill-amber-500" />}
                                    {qtyMismatch && (
                                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                                        {`${qty < reqQty ? 'Short' : 'Over'} ${fmtQty(Math.abs(reqQty - qty))}${product.uom ? ` ${product.uom}` : ''}`}
                                      </span>
                                    )}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}

                        {/* Award row — pick the winning vendor for THIS product.
                            Per-product: awarding here never touches other products. */}
                        <tr key={`award-${product.id}`} className="border-b-2 border-slate-200 bg-slate-50/40">
                          <td className="sticky left-0 z-10 bg-slate-50 px-4 sm:px-6 py-3 pl-10 font-medium text-slate-700 border-r border-slate-200">Approve</td>
                          {comparisonData.vendorList.map((vendor) => {
                            const line = getVendorLine(vendor, product.id);
                            const qlId = line?.quote_line_id;
                            const canAward = qlId && line?.quoted;
                            const isAwarded = qlId && String(productAwards[product.id]) === String(qlId);
                            return (
                              <td key={`award-${product.id}-${vendor.id}`} className={`text-center px-4 sm:px-6 py-3 ${isAwarded ? 'bg-green-50' : ''}`}>
                                {product.converted ? (
                                  <span className="text-slate-300">{product.convertedVendor === vendor.vendorName ? '✓ PO' : '--'}</span>
                                ) : canAward && canCreate('Quote Evaluation') ? (
                                  <button
                                    onClick={() => awardProduct(product.id, qlId)}
                                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                                      isAwarded ? 'bg-green-600 text-white shadow ring-2 ring-green-300' : 'bg-green-50 text-green-700 border border-green-300 hover:bg-green-100'
                                    }`}
                                  >
                                    <CheckCircle2 size={15} /> {isAwarded ? 'Approved' : 'Approve'}
                                  </button>
                                ) : (
                                  <span className="text-slate-300">--</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      </>
                      );
                    })}

                    {/* Grand Total Row */}
                    <tr className="bg-slate-50 border-t-2 border-slate-300 font-semibold">
                      <td className="sticky left-0 z-10 bg-slate-50 px-4 sm:px-6 py-4 text-slate-800 border-r border-slate-200">TOTAL VALUE</td>
                      {comparisonData.vendorList.map((vendor) => {
                        const total = parseFloat(vendor.totalValue || 0);
                        const isBest = total > 0 && comparisonData.bestTotalValue && total <= comparisonData.bestTotalValue;
                        return (
                          <td key={`total-${vendor.id}`} className="text-center px-4 sm:px-6 py-4">
                            <span className={`inline-flex items-center gap-1 ${isBest ? 'text-green-700' : 'text-slate-800'}`}>
                              {total > 0 ? formatCurrency(total) : '--'}
                              {isBest && <Star size={14} className="text-amber-500 fill-amber-500" />}
                            </span>
                          </td>
                        );
                      })}
                    </tr>

                    {/* Winner is chosen per-product via the Award row in each product group above. */}

                    {/* Notes Row */}
                    <tr className="border-t border-slate-200">
                      <td className="sticky left-0 z-10 bg-white px-4 sm:px-6 py-4 font-semibold text-slate-800 border-r border-slate-200">Notes</td>
                      {comparisonData.vendorList.map((vendor) => {
                        const vendorId = String(vendor.id);
                        return (
                          <td key={`notes-${vendor.id}`} className="px-4 py-4">
                            <textarea
                              value={vendorNotes[vendorId] || ''}
                              onChange={(e) => handleNotesChange(vendor.id, e.target.value)}
                              placeholder="Add evaluation notes..."
                              rows={2}
                              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none"
                            />
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}


          {/* Award Summary */}
          {comparisonData.vendorList.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <CheckCircle2 size={20} className="text-primary-600" />
                Approval Summary
              </h2>

              {awardsCount === 0 ? (
                <p className="text-slate-500 text-sm">No product approved yet. Use the <span className="font-medium">Approve</span> button in a product row to pick its winning vendor, then <span className="font-medium">Convert to PO</span> on that product.</p>
              ) : (
                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                    PO plan — {Object.keys(poPlan).length} PO(s) across {awardsCount} approved product(s). Use <span className="font-medium normal-case">Convert to PO</span> on each product to create it.
                  </p>
                  <ul className="space-y-1 text-sm text-slate-700">
                    {Object.entries(poPlan).map(([vendor, prods]) => (
                      <li key={vendor}><span className="font-medium">{vendor}</span> ← {prods.join(', ')}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* POs Created — one per awarded vendor */}
          {createdPOs.length > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <CheckCircle2 size={24} className="text-green-600" />
                <h2 className="text-lg font-semibold text-green-800">{createdPOs.length} Purchase Order(s) Created</h2>
              </div>
              <div className="space-y-2">
                {createdPOs.map((po) => (
                  <div key={po.id} className="flex items-center justify-between gap-3 bg-white rounded-lg border border-green-200 px-3 py-2">
                    <div className="text-sm">
                      <span className="font-semibold text-slate-800">{po.po_no}</span>
                      <span className="text-slate-500"> · {po.vendor_name} · {formatCurrency(po.total_amount)}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => navigate(`/purchase/orders/${po.id}`)} className="flex items-center gap-1 px-2.5 py-1.5 border border-green-300 text-green-700 rounded-lg text-xs font-medium hover:bg-green-100 transition">
                        <Eye size={13} /> View
                      </button>
                      <button onClick={() => navigate(`/purchase/orders/${po.id}/send-email`)} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 transition">
                        <Send size={14} /> Send
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-green-700 text-xs mt-3">Open each PO to review and send it to its vendor.</p>
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!dashboardData && !loading && !error && (
        <div className="bg-white rounded-xl border border-slate-200 p-16 text-center shadow-sm">
          <Search size={48} className="mx-auto mb-4 text-slate-300" />
          <h3 className="text-lg font-semibold text-slate-700 mb-2">Select a Purchase Request to Begin</h3>
          <p className="text-slate-500 text-sm max-w-md mx-auto">
            Choose a Purchase Request from the dropdown above and click "Load" to view and compare vendor quotes side-by-side.
          </p>
        </div>
      )}
    </>
  );
}
