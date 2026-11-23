import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient, { getErrorMessage } from '../../../utils/api.js';
import { formatCurrency, formatDate, formatNumber } from '../../../utils/formatters.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';

export default function QuoteEvaluationDashboard() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();

  // PR selection
  const { raw: prRaw, isLoading: prLoading } = useLookup('/api/purchase/requests/');
  // Only show APPROVED PRs that have linked RFQs and no PO yet (not yet evaluated)
  const prOptions = prRaw
    .filter(p => p.approval_status === 'APPROVED' && p.linked_rfq && !p.has_po)
    .map(p => ({
      value: p.id,
      label: `${p.pr_no} | ${p.warehouse_name || ''} | ${p.approval_status}${p.linked_rfq_no ? ' | RFQ: ' + p.linked_rfq_no : ''}`,
    }));
  const [selectedPrId, setSelectedPrId] = useState('');

  // Dashboard data
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Evaluation state
  const [vendorDecisions, setVendorDecisions] = useState({}); // { vendorId: 'accept' | 'reject' }
  const [vendorNotes, setVendorNotes] = useState({}); // { vendorId: 'note text' }
  const [autoGeneratePO, setAutoGeneratePO] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [createdPO, setCreatedPO] = useState(null);
  // Per-product award: { productKey: winning quoteLineId }. Each product can
  // go to a different vendor; PO generation clubs by vendor.
  const [productAwards, setProductAwards] = useState({});
  const [createdPOs, setCreatedPOs] = useState([]);

  // Load dashboard data
  const loadDashboard = async () => {
    if (!selectedPrId) {
      toast.error('Please select a Purchase Request');
      return;
    }
    setLoading(true);
    setError(null);
    setDashboardData(null);
    setVendorDecisions({});
    setVendorNotes({});
    setCreatedPO(null);
    setProductAwards({});
    setCreatedPOs([]);

    try {
      const res = await apiClient.get('/api/purchase/evaluation-dashboard/', {
        params: { pr_id: selectedPrId },
      });
      setDashboardData(res.data);
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
  const comparisonFromApi = dashboardData?.comparison || null;
  // Evaluation is locked until every invited vendor's quote is recorded.
  const locked = !!dashboardData?.locked;
  const lockedReason = dashboardData?.locked_reason || 'Record all vendor quotes before evaluating.';

  // Build comparison data: group quote lines by product
  const comparisonData = useMemo(() => {
    // If we have RFQ-based data from the dashboard API, use it
    const rfqs = dashboardData?.rfqs || [];
    const apiComparison = dashboardData?.comparison || null;

    // Collect all quotes from RFQs (new API format)
    let allQuotes = [];
    rfqs.forEach((rfq) => {
      (rfq.quotes || []).forEach((q) => {
        allQuotes.push({ ...q, rfq_no: rfq.rfq_no });
      });
    });

    // Also support legacy format where vendors are top-level
    if (allQuotes.length === 0 && vendors && vendors.length > 0) {
      allQuotes = vendors;
    }

    if (allQuotes.length === 0) return { products: [], vendorList: [] };

    // Collect unique vendors from quotes
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

    // Build products from API comparison if available, else from quote lines / PR items
    let products = [];

    if (apiComparison && apiComparison.products && apiComparison.products.length > 0) {
      // Use comparison data from the backend (handles fallback for missing quote lines)
      products = apiComparison.products.map((p) => {
        const prod = {
          id: p.product_code || p.product_name,
          name: p.product_name,
          uom: p.uom || '',
          requestedQty: p.requested_qty,
          lowestPrice: 0,
          lowestTotal: 0,
        };

        // Compute lowest from vendor_prices
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

        // Attach vendor_prices to each vendor's lines so the table rendering works
        (p.vendor_prices || []).forEach((vp) => {
          const vendor = vendorList.find(
            (v) => v.vendorName === vp.vendor_name || String(v.vendorId) === String(vp.vendor_id)
          );
          if (vendor) {
            // Add a synthetic line for this product if not already present
            const existingLine = vendor.lines.find(
              (l) =>
                (l.product_code === p.product_code || l.product_name === p.product_name)
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
              });
            }
          }
        });

        return prod;
      });
    } else {
      // Legacy: build from quote lines directly
      const productMap = {};
      vendorList.forEach((vendor) => {
        vendor.lines.forEach((line) => {
          const productKey =
            line.product_id || line.product || line.item_id || line.pr_line_id || line.product_name;
          if (!productMap[productKey]) {
            productMap[productKey] = {
              id: productKey,
              name:
                line.product_name ||
                line.product?.name ||
                line.item_name ||
                line.description ||
                'Unknown Product',
              uom: line.uom || line.unit || '',
            };
          }
        });
      });

      // Also include PR items if available
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

      // For each product, find the best (lowest) unit price across vendors
      products.forEach((product) => {
        let lowestPrice = Infinity;
        let lowestTotal = Infinity;
        vendorList.forEach((vendor) => {
          const line = vendor.lines.find(
            (l) =>
              (l.product_id || l.product || l.item_id || l.pr_line_id || l.product_name) ===
              product.id
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

    // Find best overall total
    let bestTotalValue = Infinity;
    vendorList.forEach((v) => {
      const total = parseFloat(v.totalValue || 0);
      if (total > 0 && total < bestTotalValue) bestTotalValue = total;
    });

    return { products, vendorList, bestTotalValue };
  }, [dashboardData, vendors, prItems]);

  // Per-product award data straight from the backend comparison (each vendor
  // cell carries quote_line_id + a `quoted` flag).
  const apiProducts = dashboardData?.comparison?.products || [];
  const poPlan = useMemo(() => {
    const byVendor = {};
    (dashboardData?.comparison?.products || []).forEach((p) => {
      const qlId = productAwards[p.product_code || p.product_name];
      if (!qlId) return;
      const vp = (p.vendor_prices || []).find((x) => String(x.quote_line_id) === String(qlId));
      if (!vp) return;
      byVendor[vp.vendor_name] = byVendor[vp.vendor_name] || [];
      byVendor[vp.vendor_name].push(p.product_name);
    });
    return byVendor;
  }, [dashboardData, productAwards]);
  const awardsCount = Object.values(productAwards).filter(Boolean).length;

  // Get accepted vendor
  const acceptedVendorId = Object.keys(vendorDecisions).find(
    (k) => vendorDecisions[k] === 'accept'
  );
  const acceptedVendor = comparisonData.vendorList.find(
    (v) => String(v.id) === String(acceptedVendorId)
  );

  // Handle accept/reject — standard tender pattern.
  //   • Click Accept on a vendor → that vendor wins, every OTHER vendor
  //     auto-flips to Reject (you can only accept one).
  //   • Click Reject on a vendor → just that vendor is rejected, others
  //     are untouched (you can still pick a winner from the rest).
  //   • Click the same button again → toggles that vendor's decision off;
  //     other vendors keep whatever state they were left in (the user
  //     can re-Accept any of them, which will re-fan-out the rejects).
  const handleDecision = (vendorId, decision) => {
    if (locked) { toast.error(lockedReason); return; }
    const vid = String(vendorId);
    setVendorDecisions((prev) => {
      if (prev[vid] === decision) {
        const next = { ...prev };
        next[vid] = '';
        return next;
      }
      if (decision === 'accept') {
        const next = {};
        (comparisonData.vendorList || []).forEach((v) => {
          const k = String(v.id);
          next[k] = k === vid ? 'accept' : 'reject';
        });
        return next;
      }
      const next = { ...prev };
      next[vid] = 'reject';
      return next;
    });
  };

  // Handle notes change
  const handleNotesChange = (vendorId, text) => {
    setVendorNotes((prev) => ({ ...prev, [String(vendorId)]: text }));
  };

  // Submit evaluation
  // Single-step Submit. The "Save Draft" path was removed — the backend
  // submit endpoint never persisted drafts (it always required at least
  // one ACCEPTED quote), so Save Draft would 400 anyway.
  const handleSubmit = async () => {
    if (locked) {
      toast.error(lockedReason);
      return;
    }
    const awards = Object.values(productAwards).filter(Boolean);
    if (awards.length === 0) {
      toast.error('Award at least one product to a vendor before submitting.');
      return;
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
      // Invalidate the cached PR list so the just-evaluated PR drops out of
      // the dropdown on next render.
      clearLookupCache('/api/purchase/requests/');
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

  return (
    <MainLayout
      breadcrumbs={[
        { label: 'Purchase', href: '/purchase/requests' },
        { label: 'Evaluations', href: '/purchase/evaluations' },
        { label: 'Quote Evaluation Dashboard' },
      ]}
    >
      <PageHeader
        title="Quote Evaluation Dashboard"
        subtitle="Compare vendor quotes and select the best offer"
        breadcrumbs={[
          { label: 'Purchase', href: '/purchase/requests' },
          { label: 'Evaluations', href: '/purchase/evaluations' },
          { label: 'Dashboard' },
        ]}
      />

      {/* PR Selection */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
        <div className="flex flex-col sm:flex-row gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Select Purchase Request
            </label>
            <CustomSelect
              value={selectedPrId}
              onChange={(e) => setSelectedPrId(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white"
              disabled={prLoading}
            >
              <option value="">
                {prLoading ? 'Loading Purchase Requests...' : '-- Select Purchase Request --'}
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
            className="flex items-center gap-2 px-4 sm:px-6 py-2.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
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
          <button
            onClick={loadDashboard}
            className="mt-3 text-sm text-red-600 underline hover:text-red-800"
          >
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
                <span className="text-slate-600">
                  {prSummary.warehouse_name || prSummary.warehouse || ''}
                </span>
                <span className="text-slate-400">|</span>
                <StatusBadge status={prSummary.status || 'DRAFT'} />
                {prSummary.priority && (
                  <>
                    <span className="text-slate-400">|</span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        prSummary.priority === 'HIGH' || prSummary.priority === 'URGENT'
                          ? 'bg-red-100 text-red-700'
                          : prSummary.priority === 'MEDIUM'
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
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
                  {prItems
                    .map(
                      (item) =>
                        `${item.product_name || item.description || 'Item'} (${
                          item.quantity || item.qty || 0
                        } ${item.uom || item.unit || ''})`
                    )
                    .join(', ')}
                </div>
              )}
            </div>
          )}

          {locked && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 mb-4 sm:mb-6 flex items-start gap-3">
              <AlertTriangle size={20} className="text-amber-500 shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-semibold">Evaluation locked</p>
                <p>{lockedReason}</p>
              </div>
            </div>
          )}

          {/* No quotes */}
          {comparisonData.vendorList.length === 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-8 mb-4 sm:mb-6 text-center">
              <AlertTriangle size={40} className="mx-auto mb-3 text-yellow-500" />
              <h3 className="text-lg font-semibold text-yellow-800 mb-1">No Quotes Found</h3>
              <p className="text-yellow-700 text-sm">
                No vendor quotes have been received for this Purchase Request yet. Please create RFQs
                and collect quotes first.
              </p>
              <button
                onClick={() => navigate('/purchase/rfq/new')}
                className="mt-4 px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-700 transition"
              >
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
                  {comparisonData.vendorList.length} vendor(s) &middot;{' '}
                  {comparisonData.products.length} product(s)
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200">
                      <th className="sticky left-0 z-10 bg-slate-50 text-left px-4 sm:px-6 py-4 font-semibold text-slate-700 min-w-[200px] border-r border-slate-200">
                        Product
                      </th>
                      {comparisonData.vendorList.map((vendor) => {
                        const vendorId = String(vendor.id);
                        const decision = vendorDecisions[vendorId];
                        return (
                          <th
                            key={vendor.id}
                            className={`text-center px-4 sm:px-6 py-4 min-w-[200px] transition-colors ${
                              decision === 'accept'
                                ? 'bg-green-50 border-t-4 border-t-green-500'
                                : decision === 'reject'
                                ? 'bg-red-50 border-t-4 border-t-red-400 opacity-70'
                                : ''
                            }`}
                          >
                            <div className="font-semibold text-slate-800">{vendor.vendorName}</div>
                            {vendor.quoteNo && (
                              <div className="text-xs text-slate-500 mt-1">{vendor.quoteNo}</div>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonData.products.map((product, pIdx) => (
                      <>
                        {/* Product header row */}
                        <tr
                          key={`header-${product.id}`}
                          className="bg-slate-100 border-b border-slate-200"
                        >
                          <td className="sticky left-0 z-10 bg-slate-100 px-4 sm:px-6 py-3 font-semibold text-slate-800 border-r border-slate-200">
                            {product.name}
                            {product.requestedQty && (
                              <span className="ml-2 text-xs text-slate-500 font-normal">
                                (Req: {product.requestedQty} {product.uom})
                              </span>
                            )}
                          </td>
                          {comparisonData.vendorList.map((vendor) => {
                            const decision = vendorDecisions[String(vendor.id)];
                            return (
                              <td
                                key={`${product.id}-${vendor.id}-header`}
                                className={`text-center px-4 sm:px-6 py-3 ${
                                  decision === 'accept'
                                    ? 'bg-green-50/50'
                                    : decision === 'reject'
                                    ? 'bg-red-50/30 opacity-70'
                                    : 'bg-slate-100'
                                }`}
                              />
                            );
                          })}
                        </tr>

                        {/* Detail rows */}
                        {['unit_price', 'quantity', 'gst', 'total', 'delivery', 'payment'].map(
                          (field) => (
                            <tr
                              key={`${product.id}-${field}`}
                              className="border-b border-slate-100 hover:bg-slate-50/50"
                            >
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
                                const decision = vendorDecisions[String(vendor.id)];
                                const cellBg =
                                  decision === 'accept'
                                    ? 'bg-green-50/50'
                                    : decision === 'reject'
                                    ? 'bg-red-50/30 opacity-70'
                                    : '';

                                if (!line) {
                                  return (
                                    <td
                                      key={`${product.id}-${vendor.id}-${field}`}
                                      className={`text-center px-4 sm:px-6 py-2.5 text-slate-400 ${cellBg}`}
                                    >
                                      --
                                    </td>
                                  );
                                }

                                const unitPrice = parseFloat(line.unit_price || line.price || 0);
                                const qty = parseFloat(line.quantity || line.qty || 0);
                                const gst = parseFloat(
                                  line.gst_percent || line.gst || line.tax_percent || vendor.gstPercent || 0
                                );
                                const total = parseFloat(
                                  line.total || line.line_total || line.amount || unitPrice * qty || 0
                                );
                                const delivery =
                                  line.delivery_days ||
                                  line.delivery ||
                                  vendor.deliveryDays ||
                                  null;
                                const payment =
                                  line.payment_terms || vendor.paymentTerms || '';

                                const isBestPrice =
                                  field === 'unit_price' &&
                                  unitPrice > 0 &&
                                  unitPrice <= product.lowestPrice;
                                const isBestTotal =
                                  field === 'total' &&
                                  total > 0 &&
                                  total <= product.lowestTotal;

                                let cellContent = '--';
                                if (field === 'unit_price') {
                                  cellContent = unitPrice > 0 ? formatCurrency(unitPrice) : '--';
                                } else if (field === 'quantity') {
                                  cellContent = qty > 0 ? `${formatNumber(qty, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${product.uom}` : '--';
                                } else if (field === 'gst') {
                                  cellContent = gst > 0 ? `${gst}%` : '--';
                                } else if (field === 'total') {
                                  cellContent = total > 0 ? formatCurrency(total) : '--';
                                } else if (field === 'delivery') {
                                  cellContent = delivery
                                    ? `${delivery} days`
                                    : '--';
                                } else if (field === 'payment') {
                                  cellContent = payment || '--';
                                }

                                return (
                                  <td
                                    key={`${product.id}-${vendor.id}-${field}`}
                                    className={`text-center px-4 sm:px-6 py-2.5 ${cellBg}`}
                                  >
                                    <span
                                      className={`inline-flex items-center gap-1 ${
                                        isBestPrice || isBestTotal
                                          ? 'text-green-700 font-semibold'
                                          : 'text-slate-700'
                                      }`}
                                    >
                                      {cellContent}
                                      {(isBestPrice || isBestTotal) && (
                                        <Star
                                          size={14}
                                          className="text-amber-500 fill-amber-500"
                                        />
                                      )}
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          )
                        )}
                      </>
                    ))}

                    {/* Grand Total Row */}
                    <tr className="bg-slate-50 border-t-2 border-slate-300 font-semibold">
                      <td className="sticky left-0 z-10 bg-slate-50 px-4 sm:px-6 py-4 text-slate-800 border-r border-slate-200">
                        TOTAL VALUE
                      </td>
                      {comparisonData.vendorList.map((vendor) => {
                        const total = parseFloat(vendor.totalValue || 0);
                        const isBest =
                          total > 0 &&
                          comparisonData.bestTotalValue &&
                          total <= comparisonData.bestTotalValue;
                        const decision = vendorDecisions[String(vendor.id)];
                        return (
                          <td
                            key={`total-${vendor.id}`}
                            className={`text-center px-4 sm:px-6 py-4 ${
                              decision === 'accept'
                                ? 'bg-green-50'
                                : decision === 'reject'
                                ? 'bg-red-50/30 opacity-70'
                                : ''
                            }`}
                          >
                            <span
                              className={`inline-flex items-center gap-1 ${
                                isBest ? 'text-green-700' : 'text-slate-800'
                              }`}
                            >
                              {total > 0 ? formatCurrency(total) : '--'}
                              {isBest && (
                                <Star size={14} className="text-amber-500 fill-amber-500" />
                              )}
                            </span>
                          </td>
                        );
                      })}
                    </tr>

                    {/* Winner is chosen per-product in the Award panel below. */}

                    {/* Notes Row */}
                    <tr className="border-t border-slate-200">
                      <td className="sticky left-0 z-10 bg-white px-4 sm:px-6 py-4 font-semibold text-slate-800 border-r border-slate-200">
                        Notes
                      </td>
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

          {/* Detailed Quote Responses */}
          {comparisonData.vendorList.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
              <h3 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <FileText size={20} className="text-primary-600" />
                Detailed Quote Responses
              </h3>
              <div className="space-y-3 sm:space-y-6">
                {comparisonData.vendorList.map((vendor) => {
                  const decision = vendorDecisions[String(vendor.id)];
                  return (
                    <div key={vendor.id} className={`border rounded-lg overflow-hidden ${decision === 'accept' ? 'border-emerald-300 bg-emerald-50/30' : decision === 'reject' ? 'border-red-200 bg-red-50/20' : 'border-slate-200'}`}>
                      <div className="bg-slate-50 px-4 py-3 flex items-center justify-between border-b">
                        <div>
                          <span className="font-semibold text-slate-800">{vendor.vendorName}</span>
                          <span className="ml-2 text-xs text-slate-500">Quote: {vendor.quoteNo}</span>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-slate-600">
                          {vendor.deliveryDays && <span className="flex items-center gap-1"><Truck size={14} /> {vendor.deliveryDays} days</span>}
                          {vendor.paymentTerms && <span className="flex items-center gap-1"><CreditCard size={14} /> {vendor.paymentTerms.replace(/_/g, ' ')}</span>}
                          <span className="font-semibold text-primary-700">{formatCurrency(vendor.totalValue)}</span>
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                              <th className="text-left px-4 py-2 font-medium text-slate-600">#</th>
                              <th className="text-left px-4 py-2 font-medium text-slate-600">Product</th>
                              <th className="text-right px-4 py-2 font-medium text-slate-600">Qty</th>
                              <th className="text-left px-4 py-2 font-medium text-slate-600">UOM</th>
                              <th className="text-right px-4 py-2 font-medium text-slate-600">Unit Price</th>
                              <th className="text-right px-4 py-2 font-medium text-slate-600">GST %</th>
                              <th className="text-right px-4 py-2 font-medium text-slate-600">Discount %</th>
                              <th className="text-right px-4 py-2 font-medium text-slate-600">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {vendor.lines.map((line, idx) => (
                              <tr key={idx} className="border-t border-slate-100">
                                <td className="px-4 py-2 text-slate-500">{idx + 1}</td>
                                <td className="px-4 py-2 font-medium text-slate-800">{line.product_name || line.product_code || '-'}</td>
                                <td className="px-4 py-2 text-right">{formatNumber(line.quantity_offered || line.quantity || line.qty || 0)}</td>
                                <td className="px-4 py-2">{line.uom || '-'}</td>
                                <td className="px-4 py-2 text-right">{formatCurrency(line.unit_price || line.price || 0)}</td>
                                <td className="px-4 py-2 text-right">{line.gst || line.gst_percentage || 0}%</td>
                                <td className="px-4 py-2 text-right">{line.discount || 0}%</td>
                                <td className="px-4 py-2 text-right font-medium">{formatCurrency(line.total || line.line_total || 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Evaluation Summary */}
          {comparisonData.vendorList.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <CheckCircle2 size={20} className="text-primary-600" />
                Award Winner Per Product
              </h2>

              <div className="space-y-2.5">
                {apiProducts.length === 0 && (
                  <p className="text-slate-500 text-sm">No products to award.</p>
                )}
                {apiProducts.map((p) => {
                  const key = p.product_code || p.product_name;
                  const quoted = (p.vendor_prices || []).filter((vp) => vp.quoted && vp.quote_line_id);
                  return (
                    <div key={key} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
                      <span className="sm:w-64 shrink-0 text-sm font-medium text-slate-700">
                        {p.product_name}
                        <span className="text-slate-400 font-normal"> · req {formatNumber(p.requested_qty, { maximumFractionDigits: 2 })} {p.uom}</span>
                      </span>
                      {quoted.length === 0 ? (
                        <span className="text-sm text-slate-400">No vendor quoted this product</span>
                      ) : (
                        <CustomSelect
                          value={productAwards[key] || ''}
                          onChange={(e) => setProductAwards((prev) => ({ ...prev, [key]: e.target.value }))}
                          disabled={locked}
                          className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm disabled:bg-slate-100"
                        >
                          <option value="">— Not awarded —</option>
                          {quoted.map((vp) => (
                            <option key={vp.quote_line_id} value={vp.quote_line_id}>
                              {vp.vendor_name} — {formatCurrency(vp.unit_price)}/unit · total {formatCurrency(vp.total)}
                            </option>
                          ))}
                        </CustomSelect>
                      )}
                    </div>
                  );
                })}
              </div>

              {Object.keys(poPlan).length > 0 && (
                <div className="mt-4 rounded-lg bg-slate-50 border border-slate-200 p-3">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                    PO plan — {Object.keys(poPlan).length} PO(s) will be created
                  </p>
                  <ul className="space-y-1 text-sm text-slate-700">
                    {Object.entries(poPlan).map(([vendor, prods]) => (
                      <li key={vendor}>
                        <span className="font-medium">{vendor}</span> ← {prods.join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Auto-generate PO checkbox */}
              <div className="mt-5 pt-5 border-t border-slate-200">
                <label className="inline-flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoGeneratePO}
                    onChange={(e) => setAutoGeneratePO(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span className="text-sm text-slate-700 font-medium">
                    Auto-generate Purchase Order
                  </span>
                </label>
              </div>

              {/* Action buttons */}
              <div className="mt-5 flex items-center gap-3">
                {canCreate('Quote Evaluation') && (
                  <button
                    onClick={handleSubmit}
                    disabled={locked || submitting || awardsCount === 0}
                    className="flex items-center gap-2 px-4 sm:px-6 py-2.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitting ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <CheckCircle2 size={16} />
                    )}
                    {awardsCount > 0 ? `Award ${awardsCount} product(s)` : 'Submit Evaluation'}
                    {autoGeneratePO ? ' & Generate PO(s)' : ''}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* POs Created (after submission) — one per awarded vendor */}
          {createdPOs.length > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 sm:p-6 mb-4 sm:mb-6 shadow-sm">
              <div className="flex items-center gap-3 mb-3">
                <CheckCircle2 size={24} className="text-green-600" />
                <h2 className="text-lg font-semibold text-green-800">
                  {createdPOs.length} Purchase Order(s) Created
                </h2>
              </div>
              <div className="space-y-2">
                {createdPOs.map((po) => (
                  <div key={po.id} className="flex items-center justify-between gap-3 bg-white rounded-lg border border-green-200 px-3 py-2">
                    <div className="text-sm">
                      <span className="font-semibold text-slate-800">{po.po_no}</span>
                      <span className="text-slate-500"> · {po.vendor_name} · {formatCurrency(po.total_amount)}</span>
                    </div>
                    <button
                      onClick={() => navigate(`/purchase/orders/${po.id}`)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 transition shrink-0"
                    >
                      <ChevronRight size={14} />
                      View &amp; Send
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-green-700 text-xs mt-3">Open each PO to review and send it to its vendor.</p>
            </div>
          )}
        </>
      )}

      {/* Empty state when no PR loaded */}
      {!dashboardData && !loading && !error && (
        <div className="bg-white rounded-xl border border-slate-200 p-16 text-center shadow-sm">
          <Search size={48} className="mx-auto mb-4 text-slate-300" />
          <h3 className="text-lg font-semibold text-slate-700 mb-2">
            Select a Purchase Request to Begin
          </h3>
          <p className="text-slate-500 text-sm max-w-md mx-auto">
            Choose a Purchase Request from the dropdown above and click "Load" to view and compare
            vendor quotes side-by-side.
          </p>
        </div>
      )}
    </MainLayout>
  );
}
