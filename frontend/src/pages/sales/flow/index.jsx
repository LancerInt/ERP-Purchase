import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search, CheckCircle2, Clock, ChevronLeft, ChevronRight, FileText, Truck,
  DollarSign, X, Eye, ShoppingCart, Receipt,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import BackToModule from '../../../components/common/BackToModule';
import FlowBot from '../../../components/common/FlowBot';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatCurrency, formatDate } from '@/utils/formatters';

const fmt = (v) => v ? formatCurrency(v) : '₹0.00';
const fmtDate = (d) => d ? formatDate(d) : '-';

const STATUS_COLORS = {
  DRAFT: 'bg-slate-100 text-slate-700', CONFIRMED: 'bg-blue-100 text-blue-800',
  APPROVED: 'bg-emerald-100 text-emerald-800', REJECTED: 'bg-red-100 text-red-800',
  PENDING: 'bg-yellow-100 text-yellow-800', PARTIALLY_DISPATCHED: 'bg-amber-100 text-amber-800',
  CLOSED: 'bg-slate-200 text-slate-700', RELEASED: 'bg-blue-100 text-blue-800',
  DELIVERED: 'bg-teal-100 text-teal-800', PARTIALLY_PAID: 'bg-amber-100 text-amber-800',
  PAID: 'bg-emerald-100 text-emerald-800', CANCELLED: 'bg-red-100 text-red-800',
  CONVERTED: 'bg-emerald-100 text-emerald-800', IN_PROGRESS: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
};

const Badge = ({ status }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || 'bg-slate-100 text-slate-600'}`}>
    {(status || '').replace(/_/g, ' ')}
  </span>
);

const STEP_CONFIG = [
  { key: 'cpo', label: 'Customer PO', icon: FileText, color: 'bg-indigo-500', light: 'bg-indigo-50', text: 'text-indigo-700', path: '/sales/customer-po' },
  { key: 'so', label: 'Sales Order', icon: ShoppingCart, color: 'bg-blue-500', light: 'bg-blue-50', text: 'text-blue-700', path: '/sales/orders' },
  { key: 'dc', label: 'Dispatch Challan', icon: Truck, color: 'bg-teal-500', light: 'bg-teal-50', text: 'text-teal-700', path: '/sales/dc' },
  { key: 'outward_freight', label: 'Outward Freight', icon: Truck, color: 'bg-emerald-500', light: 'bg-emerald-50', text: 'text-emerald-700', path: '/sales/freight' },
  { key: 'freight_payment', label: 'Freight Payments', icon: DollarSign, color: 'bg-green-500', light: 'bg-green-50', text: 'text-green-700', path: '/freight/payments' },
  { key: 'invoice', label: 'Invoice', icon: Receipt, color: 'bg-orange-500', light: 'bg-orange-50', text: 'text-orange-700', path: '/sales/invoices' },
  { key: 'receivable', label: 'Receivable', icon: DollarSign, color: 'bg-amber-500', light: 'bg-amber-50', text: 'text-amber-700', path: '/sales/receivables' },
];

export default function SalesFlowDashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Cross-module nav gates — each timeline node links into another
  // sales module. Hide the node's click-through (keep the text)
  // when the user lacks view permission for that destination.
  const { canView } = usePermissions();
  const canSeeSO = canView('Sales Order');
  const canSeeCPO = canView('Customer PO');
  const canSeeDC = canView('Dispatch Challan');
  const canSeeInvoice = canView('Sales Invoice');
  const canSeeReceivable = canView('Receivable');
  const [searchType, setSearchType] = useState('so'); // 'so' | 'cpo' | 'dc'
  const [recordSearch, setRecordSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [allRecords, setAllRecords] = useState([]);
  const [flowData, setFlowData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [expandedItem, setExpandedItem] = useState(null);
  const [itemDetail, setItemDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  const loadItemDetail = async (item) => {
    if (expandedItem === item.id) { setExpandedItem(null); setItemDetail(null); return; }
    setExpandedItem(item.id);
    setDetailLoading(true);
    try { const res = await apiClient.get(item.apiUrl); setItemDetail(res.data); }
    catch { setItemDetail(null); }
    finally { setDetailLoading(false); }
  };

  // Load all searchable records
  useEffect(() => {
    Promise.all([
      apiClient.get('/api/sales/customer-po/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/orders/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/dc/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/freight/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/freight-payments/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/invoices/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/receivables/', { params: { page_size: 500 } }),
    ]).then(([cpoRes, soRes, dcRes, ofRes, fpRes, invRes, recRes]) => {
      const records = [];
      // SOs
      (soRes.data?.results || soRes.data || []).forEach(s => {
        records.push({ id: s.id, refNo: s.so_no, type: 'so', label: `${s.so_no} - ${s.customer_name || ''}`, soId: s.id });
      });
      // CPOs — only if linked to SO
      (cpoRes.data?.results || cpoRes.data || []).forEach(p => {
        const soId = p.linked_sos?.[0]?.id || p.linked_sales_order;
        if (soId) records.push({ id: p.id, refNo: p.upload_id, type: 'cpo', label: `${p.upload_id} - ${p.customer_name || ''}`, soId });
      });
      // DCs — only if linked to SO
      (dcRes.data?.results || dcRes.data || []).forEach(d => {
        if (d.linked_so_id) records.push({ id: d.id, refNo: d.dc_no, type: 'dc', label: `${d.dc_no} - ${d.warehouse_name || ''}`, soId: d.linked_so_id });
      });
      // Outward Freight — find SO via linked DCs (dc_ids from FreightDCLink)
      const dcToSo = {};
      (dcRes.data?.results || dcRes.data || []).forEach(d => { if (d.linked_so_id) dcToSo[d.id] = d.linked_so_id; });
      (ofRes.data?.results || ofRes.data || []).forEach(of => {
        const soId = Array.isArray(of.dc_ids) ? of.dc_ids.map(id => dcToSo[id]).find(Boolean) : null;
        if (soId) records.push({ id: of.id, refNo: of.advice_no, type: 'of', label: `${of.advice_no} - ${of.customer_name || ''}`, soId });
      });
      // Freight Payments — find SO via outward freight
      const ofToSo = {};
      records.filter(r => r.type === 'of').forEach(r => { ofToSo[r.id] = r.soId; });
      (fpRes.data?.results || fpRes.data || []).forEach(fp => {
        const soId = ofToSo[fp.freight] || ofToSo[fp.freight_id];
        if (soId) records.push({ id: fp.id, refNo: fp.advice_no, type: 'fp', label: `${fp.advice_no} - ${fmt(fp.amount_paid)}`, soId });
      });
      // Invoices — linked via DC or SO
      (invRes.data?.results || invRes.data || []).forEach(inv => {
        const soId = inv.so_reference || (inv.dc_reference && dcToSo[inv.dc_reference]);
        if (soId) records.push({ id: inv.id, refNo: inv.invoice_no, type: 'inv', label: `${inv.invoice_no} - ${inv.customer_name || ''}`, soId });
      });
      // Receivables — linked via invoice
      const invToSo = {};
      records.filter(r => r.type === 'inv').forEach(r => { invToSo[r.id] = r.soId; });
      (recRes.data?.results || recRes.data || []).forEach(r => {
        const soId = invToSo[r.invoice_reference];
        if (soId) records.push({ id: r.id, refNo: r.invoice_no, type: 'rec', label: `${r.invoice_no} - ${r.customer_name || ''}`, soId });
      });
      setAllRecords(records);
    }).catch(() => {});
  }, []);

  // Load flow when SO selected — full chain: CPO → SO → DC → Freight Detail → Outward Freight → Payments → Invoice → Receivable
  const loadFlow = async (soId) => {
    if (!soId) return;
    setIsLoading(true);
    setFlowData(null);
    setSelectedNode(null);
    setExpandedItem(null);
    setItemDetail(null);
    try {
      const soRes = await apiClient.get(`/api/sales/orders/${soId}/`);
      const so = soRes.data;

      // Fetch linked DCs
      const dcRes = await apiClient.get(`/api/sales/orders/${soId}/linked-dcs/`);
      const dcs = dcRes.data || [];
      const dcIds = dcs.map(d => d.id);

      // Fetch linked CPOs (full objects with id, upload_id, po_number)
      const cpos = (so.customer_po_numbers || []).map(c => (
        typeof c === 'string' ? { id: c, upload_id: c } : c
      ));

      // Fetch Outward Freights linked to these DCs (via FreightDCLink dc_ids)
      let outwardFreights = [];
      const ofRes = await apiClient.get('/api/sales/freight/', { params: { page_size: 500 } });
      const allOFs = ofRes.data?.results || ofRes.data || [];
      outwardFreights = allOFs.filter(of =>
        Array.isArray(of.dc_ids) && of.dc_ids.some(id => dcIds.includes(id))
      );

      // Fetch Freight Payments linked to these Outward Freights
      let freightPayments = [];
      const fpRes = await apiClient.get('/api/sales/freight-payments/', { params: { page_size: 500 } });
      const allFPs = fpRes.data?.results || fpRes.data || [];
      const ofIds = outwardFreights.map(of => of.id);
      freightPayments = allFPs.filter(fp => ofIds.includes(fp.freight) || ofIds.includes(fp.freight_id));

      // Fetch Invoices linked to these DCs or SO
      let invoices = [];
      const invRes = await apiClient.get('/api/sales/invoices/', { params: { page_size: 500 } });
      const allInvs = invRes.data?.results || invRes.data || [];
      invoices = allInvs.filter(inv =>
        (inv.dc_reference && dcIds.includes(inv.dc_reference)) ||
        (inv.so_reference && inv.so_reference === soId)
      );
      const invIds = invoices.map(inv => inv.id);

      // Fetch Receivables linked to these Invoices
      let receivables = [];
      if (invIds.length > 0) {
        const recRes = await apiClient.get('/api/sales/receivables/', { params: { page_size: 500 } });
        const allRecs = recRes.data?.results || recRes.data || [];
        receivables = allRecs.filter(r => invIds.includes(r.invoice_reference));
      }

      setFlowData({ so, dcs, cpos, outwardFreights, freightPayments, invoices, receivables });
    } catch { setFlowData(null); }
    finally { setIsLoading(false); }
  };

  const handleRecordSelect = (value) => {
    if (!value) return;
    const record = allRecords.find(r => r.id === value);
    const soId = record?.soId || value;
    if (soId) { setSearchParams({ so_id: soId }); loadFlow(soId); }
  };

  // Auto-load if URL has so_id
  useEffect(() => {
    const soId = searchParams.get('so_id');
    if (soId) loadFlow(soId);
  }, []);

  const so = flowData?.so;
  const dcs = flowData?.dcs || [];
  const cpos = flowData?.cpos || [];
  const outwardFreights = flowData?.outwardFreights || [];
  const freightPayments = flowData?.freightPayments || [];
  const invoices = flowData?.invoices || [];
  const receivables = flowData?.receivables || [];

  // Build steps with completion status
  const steps = [
    { ...STEP_CONFIG[0], done: cpos.length > 0, count: cpos.length, items: cpos.map(c => ({ id: c.id || c.upload_id, label: c.upload_id, status: 'CONFIRMED', type: 'cpo', apiUrl: c.id ? `/api/sales/customer-po/${c.id}/` : `/api/sales/customer-po/?upload_id=${c.upload_id}` })) },
    { ...STEP_CONFIG[1], done: !!so, count: 1, items: so ? [{ id: so.id, label: so.so_no, status: so.approval_status, type: 'so', apiUrl: `/api/sales/orders/${so.id}/` }] : [] },
    { ...STEP_CONFIG[2], done: dcs.length > 0, count: dcs.length, items: dcs.map(d => ({ id: d.id, label: d.dc_no, status: d.status, date: d.dispatch_date, type: 'dc', apiUrl: `/api/sales/dc/${d.id}/` })) },
    { ...STEP_CONFIG[3], done: outwardFreights.length > 0, count: outwardFreights.length, items: outwardFreights.map(of => ({ id: of.id, label: of.advice_no, status: of.status, type: 'outward_freight', apiUrl: `/api/sales/freight/${of.id}/` })) },
    { ...STEP_CONFIG[4], done: freightPayments.length > 0, count: freightPayments.length, items: freightPayments.map(fp => ({ id: fp.id, label: `${fp.advice_no} - ${fmt(fp.amount_paid)}`, status: 'PAID', date: fp.payment_date, type: 'freight_payment', apiUrl: `/api/sales/freight-payments/${fp.id}/` })) },
    { ...STEP_CONFIG[5], done: invoices.length > 0, count: invoices.length, items: invoices.map(inv => ({ id: inv.id, label: inv.invoice_no, status: inv.status, date: inv.invoice_date, type: 'invoice', apiUrl: `/api/sales/invoices/${inv.id}/` })) },
    { ...STEP_CONFIG[6], done: receivables.length > 0, count: receivables.length, items: receivables.map(r => ({ id: r.id, label: `${r.invoice_no} - ${fmt(r.amount)}`, status: r.payment_status, type: 'receivable', apiUrl: `/api/sales/receivables/${r.id}/` })) },
  ];

  return (
    <MainLayout>
      {/* `min-w-0` on the inner column lets every child (lifecycle
          strip, timeline rows, etc.) shrink to fit the viewport so
          horizontal scroll stays trapped inside the card that owns
          it — instead of pushing the whole page sideways on phones. */}
      <div className="space-y-3 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
        <div className="flex items-center gap-1.5">
          <BackToModule />
          <div className="min-w-0">
            <h1 className="text-xl sm:text-3xl font-bold text-slate-900">Sales Flow Dashboard</h1>
            <p className="text-slate-600 mt-1 text-xs sm:text-base">Track the complete lifecycle: Customer PO → SO → DC → Freight → Receivable</p>
          </div>
        </div>

        {/* Search — on mobile the chips wrap onto multiple rows so
            all 7 entry points stay visible without horizontal
            scrolling. Short labels (3-4 letter abbreviations) keep
            the wrap tight; the full names show on tablet+ widths. */}
        <div className="space-y-2 sm:space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
            {/* "Search by:" caption hidden on mobile to save the row —
                the pills are self-explanatory and the dropdown sits
                right below. */}
            <span className="hidden sm:inline text-xs sm:text-sm font-medium text-slate-600 flex-shrink-0">Search by:</span>
            {/* Compact pills spread across the full width on mobile so
                the row lines up with the search box below (first pill at
                the start, last at the end). On desktop they sit next to
                the caption at their natural size. */}
            <div className="flex items-center justify-between sm:justify-start flex-wrap gap-1 sm:gap-2 w-full sm:w-auto">
              {[
                { value: 'so',  label: 'Sales Order',      short: 'SO' },
                { value: 'cpo', label: 'Customer PO',      short: 'CPO' },
                { value: 'dc',  label: 'Dispatch Challan', short: 'DC' },
                { value: 'of',  label: 'Outward Freight',  short: 'Freight' },
                { value: 'fp',  label: 'Freight Payments', short: 'Pmts' },
                { value: 'inv', label: 'Invoice',          short: 'Invoice' },
                { value: 'rec', label: 'Receivable',       short: 'Recv' },
              ].map(opt => (
                <label key={opt.value} className={`flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 sm:px-3 sm:py-1.5 rounded sm:rounded-lg border cursor-pointer transition text-[11px] sm:text-sm whitespace-nowrap flex-shrink-0 ${
                  searchType === opt.value ? 'bg-blue-50 border-blue-400 text-blue-700 font-medium' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                  <input type="radio" name="searchType" value={opt.value} checked={searchType === opt.value}
                    onChange={(e) => { setSearchType(e.target.value); setRecordSearch(''); }} className="sr-only" />
                  {/* Mobile shows the short label, sm+ shows the full label */}
                  <span className="sm:hidden">{opt.short}</span>
                  <span className="hidden sm:inline">{opt.label}</span>
                  <span className="text-[9px] sm:text-xs bg-slate-100 text-slate-500 px-1 py-0 sm:px-1.5 sm:py-0.5 rounded-full">{allRecords.filter(r => r.type === opt.value).length}</span>
                </label>
              ))}
            </div>
          </div>
          {/* Custom suggestion dropdown — replaces the native <datalist>
              (which renders an unstyleable dark OS popup). Themed to match
              the rest of the app: white card, primary-tinted hover. */}
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={recordSearch}
                onChange={(e) => { setRecordSearch(e.target.value); setShowSuggestions(true); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
                placeholder={({ so: 'Search Sales Order...', cpo: 'Search Customer PO...', dc: 'Search Dispatch Challan...', of: 'Search Outward Freight...', fp: 'Search Freight Payment...', inv: 'Search Invoice...', rec: 'Search Receivable...' })[searchType] || 'Search...'}
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              {showSuggestions && (() => {
                const q = recordSearch.trim().toLowerCase();
                const matches = allRecords
                  .filter(r => r.type === searchType && (!q || r.label.toLowerCase().includes(q)))
                  .slice(0, 50);
                if (matches.length === 0) return null;
                return (
                  <ul className="absolute z-30 left-0 right-0 mt-1 max-h-72 overflow-y-auto ios-scroll overscroll-y-contain bg-white border border-slate-200 rounded-lg shadow-lg py-1">
                    {matches.map(r => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            // mousedown (not click) so it fires before the
                            // input's onBlur closes the list.
                            e.preventDefault();
                            setRecordSearch(r.label);
                            setShowSuggestions(false);
                            handleRecordSelect(r.id);
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-primary-50 hover:text-primary-700 transition flex items-center gap-2"
                        >
                          <Search size={12} className="text-slate-300 shrink-0" />
                          <span className="truncate">{r.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </div>
        </div>

        {isLoading && <div className="text-center py-12 text-slate-500">Loading flow...</div>}

        {flowData && (
          <>
            {/* Flow Steps — branched layout. Trunk (CPO → SO → DC)
                splits into two parallel rails after Dispatch Challan:
                  • Billing rail:    Invoice → Receivable
                  • Logistics rail:  Outward Freight → Freight Payments
                Both rails are owned by the sales team but track
                independent workflows once a DC is issued, so we render
                them as siblings rather than a single straight chain. */}
            <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-6 shadow-sm">
              <h3 className="text-xs sm:text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2 sm:mb-4">Lifecycle Progress</h3>
              {(() => {
                // steps order: [cpo, so, dc, outward_freight, freight_payment, invoice, receivable]
                const trunkSteps    = [steps[0], steps[1], steps[2]];
                const billingRail   = [steps[5], steps[6]];           // Invoice → Receivable
                const logisticsRail = [steps[3], steps[4]];           // Outward Freight → Freight Payments

                const renderStep = (step) => {
                  const Icon = step.icon;
                  return (
                    <button
                      key={step.key}
                      onClick={() => setSelectedNode(step)}
                      className={`flex items-center gap-1.5 sm:gap-2 px-2.5 py-2 sm:px-4 sm:py-3 rounded-lg text-xs sm:text-sm font-medium border transition-all cursor-pointer hover:shadow-md flex-shrink-0 ${
                        step.done
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                          : 'bg-slate-50 text-slate-500 border-slate-200'
                      }`}
                    >
                      {step.done ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Clock size={16} className="text-slate-400" />}
                      <Icon size={16} />
                      <span className="whitespace-nowrap">{step.label}</span>
                      {step.count > 0 && <span className="ml-1 px-1.5 py-0.5 bg-white rounded-full text-xs font-bold">{step.count}</span>}
                    </button>
                  );
                };

                const renderChain = (chain) =>
                  chain.map((step, i) => (
                    <div key={step.key} className="flex items-center flex-shrink-0">
                      {renderStep(step)}
                      {i < chain.length - 1 && <ChevronRight size={18} className="text-slate-300 mx-1 flex-shrink-0" />}
                    </div>
                  ));

                // Mobile-friendly card row — full width, no horizontal
                // scroll, status icon + label + count in a single line.
                const renderMobileStep = (step) => {
                  const Icon = step.icon;
                  return (
                    <button
                      key={step.key}
                      onClick={() => setSelectedNode(step)}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-all text-left ${
                        step.done
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                          : 'bg-slate-50 text-slate-500 border-slate-200'
                      }`}
                    >
                      {step.done ? <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" /> : <Clock size={14} className="text-slate-400 flex-shrink-0" />}
                      <Icon size={14} className="flex-shrink-0" />
                      <span className="truncate flex-1">{step.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${step.count > 0 ? 'bg-white font-bold' : 'bg-slate-100 text-slate-400'}`}>{step.count}</span>
                    </button>
                  );
                };

                return (
                  <>
                    {/* Mobile — vertical 7-row list, no horizontal
                        scroll. Trunk steps (CPO/SO/DC) are full-width
                        so the chain reads top-to-bottom. The two
                        post-DC rails (Billing + Logistics) share a
                        two-column row so they still read as parallel
                        branches without forcing the user to scroll. */}
                    <div className="sm:hidden space-y-2">
                      {trunkSteps.map(renderMobileStep)}
                      <div className="pl-3 border-l-2 border-slate-200 space-y-2">
                        <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium pt-1">Billing rail</p>
                        {billingRail.map(renderMobileStep)}
                        <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium pt-1">Logistics rail</p>
                        {logisticsRail.map(renderMobileStep)}
                      </div>
                    </div>

                    {/* Tablet & desktop — the branched tree layout. */}
                    <div className="hidden sm:block overflow-x-auto pb-2">
                      <div className="flex items-center gap-1 min-w-fit">
                        {/* Trunk: CPO → SO → DC */}
                        {renderChain(trunkSteps)}

                        {/* Y-split connector — drawn with SVG so the
                            two stubs land precisely on the centers of
                            the two rails to the right. */}
                        <div className="flex-shrink-0 px-1" aria-hidden="true">
                          <svg width="36" height="120" viewBox="0 0 36 120" className="text-slate-300">
                            {/* Stub from trunk into the junction */}
                            <line x1="0"  y1="60" x2="18" y2="60" stroke="currentColor" strokeWidth="2" />
                            {/* Vertical spine between the two rails */}
                            <line x1="18" y1="30" x2="18" y2="90" stroke="currentColor" strokeWidth="2" />
                            {/* Top stub → billing rail (Invoice) */}
                            <line x1="18" y1="30" x2="36" y2="30" stroke="currentColor" strokeWidth="2" />
                            {/* Bottom stub → logistics rail (Outward Freight) */}
                            <line x1="18" y1="90" x2="36" y2="90" stroke="currentColor" strokeWidth="2" />
                          </svg>
                        </div>

                        {/* Two rails stacked vertically */}
                        <div className="flex flex-col gap-3 flex-shrink-0">
                          <div className="flex items-center gap-1">{renderChain(billingRail)}</div>
                          <div className="flex items-center gap-1">{renderChain(logisticsRail)}</div>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* SO Summary — the two "narrative" cards (SO + Customer)
                stay full-width on mobile, then the five count tiles
                pack 4-per-row on phones so the whole strip fits in
                two compact rows instead of stacking. */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 sm:gap-3">
              <div className="bg-white rounded-lg border border-slate-200 p-2 sm:p-3 col-span-2 md:col-span-1 min-w-0">
                <p className="text-[10px] text-slate-500 uppercase">Sales Order</p>
                {canSeeSO ? (
                  <button onClick={() => navigate(`/sales/orders/${so.id}`)} className="text-sm font-bold text-blue-700 hover:underline">{so.so_no}</button>
                ) : (
                  <span className="text-sm font-bold text-slate-700">{so.so_no}</span>
                )}
                <div className="mt-1"><Badge status={so.approval_status} /></div>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 p-2 sm:p-3 col-span-2 md:col-span-1 min-w-0">
                <p className="text-[10px] text-slate-500 uppercase">Customer</p>
                <p className="text-sm font-bold text-slate-900 truncate">{so.customer_name}</p>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 p-2 sm:p-3 min-w-0">
                <p className="text-[10px] text-slate-500 uppercase">SO Total</p>
                <p className="text-sm font-bold text-slate-900 truncate">{fmt(so.total_amount)}</p>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 p-2 sm:p-3 min-w-0">
                <p className="text-[10px] text-slate-500 uppercase">DCs</p>
                <p className="text-sm font-bold text-slate-900">{dcs.length}</p>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 p-2 sm:p-3 min-w-0">
                <p className="text-[10px] text-slate-500 uppercase">Outward Freight</p>
                <p className="text-sm font-bold text-slate-900">{outwardFreights.length}</p>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 p-2 sm:p-3 min-w-0">
                <p className="text-[10px] text-slate-500 uppercase">Invoices</p>
                <p className="text-sm font-bold text-slate-900">{invoices.length}</p>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 p-2 sm:p-3 col-span-2 md:col-span-1 min-w-0">
                <p className="text-[10px] text-slate-500 uppercase">Receivables</p>
                <p className="text-sm font-bold text-slate-900">{receivables.length}</p>
              </div>
            </div>

            {/* Timeline */}
            <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-6">
              <h3 className="text-xs sm:text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2 sm:mb-4">Flow Timeline</h3>
              <div className="relative pl-6 space-y-0">
                <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-slate-200" />
                {/* CPOs */}
                {cpos.map((c, i) => (
                  <div key={`cpo-${i}`} className="relative flex items-start gap-3 py-2">
                    <div className="absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white bg-indigo-500 shadow-sm z-10" />
                    <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      {c.id && canSeeCPO ? (
                        <button onClick={() => navigate(`/sales/customer-po/${c.id}`)} className="text-sm font-medium text-indigo-700 hover:underline">Customer PO: {c.upload_id}</button>
                      ) : (
                        <span className="text-sm font-medium text-slate-800">Customer PO: {c.upload_id}</span>
                      )}
                      <Badge status="CONFIRMED" />
                    </div>
                  </div>
                ))}
                {/* SO */}
                <div className="relative flex items-start gap-3 py-2">
                  <div className="absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white bg-blue-500 shadow-sm z-10" />
                  <div className="flex-1 flex items-center gap-2">
                    {canSeeSO ? (
                      <button onClick={() => navigate(`/sales/orders/${so.id}`)} className="text-sm font-medium text-blue-700 hover:underline">SO: {so.so_no}</button>
                    ) : (
                      <span className="text-sm font-medium text-slate-800">SO: {so.so_no}</span>
                    )}
                    <Badge status={so.approval_status} />
                    <span className="text-xs text-slate-400">{fmtDate(so.so_date)}</span>
                  </div>
                </div>
                {/* DCs */}
                {dcs.map((d, i) => (
                  <div key={`dc-${i}`} className="relative flex items-start gap-3 py-2">
                    <div className="absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white bg-teal-500 shadow-sm z-10" />
                    <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      {canSeeDC ? (
                        <button onClick={() => navigate(`/sales/dc/${d.id}`)} className="text-sm font-medium text-teal-700 hover:underline">DC: {d.dc_no}</button>
                      ) : (
                        <span className="text-sm font-medium text-slate-800">DC: {d.dc_no}</span>
                      )}
                      <Badge status={d.status} />
                      <span className="text-xs text-slate-400">{fmtDate(d.dispatch_date)}</span>
                    </div>
                  </div>
                ))}
                {/* Outward Freights */}
                {outwardFreights.map((of, i) => (
                  <div key={`of-${i}`} className="relative flex items-start gap-3 py-2">
                    <div className="absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white bg-emerald-500 shadow-sm z-10" />
                    <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      <button onClick={() => navigate(`/sales/freight/${of.id}`)} className="text-sm font-medium text-emerald-700 hover:underline">Outward: {of.advice_no}</button>
                      <Badge status={of.status} />
                      <span className="text-xs text-slate-400">Payable: {fmt(of.payable_amount)} | Paid: {fmt(of.total_paid)}</span>
                    </div>
                  </div>
                ))}
                {/* Freight Payments */}
                {freightPayments.map((fp, i) => (
                  <div key={`fp-${i}`} className="relative flex items-start gap-3 py-2">
                    <div className="absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white bg-green-500 shadow-sm z-10" />
                    <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      <button onClick={() => navigate(`/freight/payments`)} className="text-sm font-medium text-green-700 hover:underline">Payment: {fp.advice_no}</button>
                      <span className="text-xs font-medium text-green-700">{fmt(fp.amount_paid)}</span>
                      <span className="text-xs text-slate-400">{fmtDate(fp.payment_date)}</span>
                    </div>
                  </div>
                ))}
                {/* Invoices */}
                {invoices.map((inv, i) => (
                  <div key={`inv-${i}`} className="relative flex items-start gap-3 py-2">
                    <div className="absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white bg-orange-500 shadow-sm z-10" />
                    <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      {canSeeInvoice ? (
                        <button onClick={() => navigate(`/sales/invoices/${inv.id}`)} className="text-sm font-medium text-orange-700 hover:underline">Invoice: {inv.invoice_no}</button>
                      ) : (
                        <span className="text-sm font-medium text-slate-800">Invoice: {inv.invoice_no}</span>
                      )}
                      <Badge status={inv.status} />
                      <span className="text-xs text-slate-400">{fmt(inv.grand_total)} | {fmtDate(inv.invoice_date)}</span>
                    </div>
                  </div>
                ))}
                {/* Receivables */}
                {receivables.map((r, i) => (
                  <div key={`rec-${i}`} className="relative flex items-start gap-3 py-2">
                    <div className="absolute left-[-13px] top-3 w-3 h-3 rounded-full border-2 border-white bg-amber-500 shadow-sm z-10" />
                    <div className="flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      {canSeeReceivable ? (
                        <button onClick={() => navigate(`/sales/receivables/${r.id}`)} className="text-sm font-medium text-amber-700 hover:underline">Receivable: {r.invoice_no}</button>
                      ) : (
                        <span className="text-sm font-medium text-slate-800">Receivable: {r.invoice_no}</span>
                      )}
                      <Badge status={r.payment_status} />
                      <span className="text-xs text-slate-400">Amount: {fmt(r.amount)} | Paid: {fmt(r.amount_paid)} | Balance: {fmt(r.balance)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {!flowData && !isLoading && (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <ShoppingCart size={48} className="mx-auto text-slate-300 mb-4" />
            <p className="text-slate-500 text-lg">Select a Sales Order to view its complete flow</p>
            <p className="text-slate-400 text-sm mt-1">Customer PO → Sales Order → Dispatch Challan → Freight → Receivable</p>
          </div>
        )}

        {/* Node Detail Side Panel */}
        {selectedNode && selectedNode.items.length > 0 && (
          <div className="fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl border-l z-50 overflow-y-auto">
            <div className={`${selectedNode.color} text-white p-5`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {(() => { const Icon = selectedNode.icon; return <Icon size={24} />; })()}
                  <div>
                    <p className="text-xs uppercase opacity-80">{selectedNode.label}</p>
                    <p className="text-lg font-bold">{selectedNode.count} Record(s)</p>
                  </div>
                </div>
                <button onClick={() => setSelectedNode(null)} className="p-1 rounded-lg hover:bg-white/20"><X size={20} /></button>
              </div>
            </div>
            <div className="p-4 space-y-3">
              {selectedNode.items.map((item, i) => (
                <div key={i} className="border border-slate-200 rounded-lg overflow-hidden">
                  {/* Item header - click to expand */}
                  <button onClick={() => loadItemDetail(item)}
                    className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition text-left">
                    <div>
                      <p className="font-semibold text-slate-800">{item.label}</p>
                      {item.date && <p className="text-xs text-slate-400 mt-0.5">{fmtDate(item.date)}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge status={item.status} />
                      <button onClick={(e) => { e.stopPropagation(); navigate(`${selectedNode.path}/${item.id}`); setSelectedNode(null); }}
                        className="p-1.5 text-blue-600 hover:bg-blue-100 rounded" title="Go to page"><Eye size={14} /></button>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {expandedItem === item.id && (
                    <div className="border-t bg-slate-50 p-4">
                      {detailLoading ? (
                        <p className="text-center text-slate-400 py-3 text-xs">Loading details...</p>
                      ) : itemDetail ? (
                        <div className="space-y-2 text-xs">
                          {/* SO Detail */}
                          {item.type === 'so' && (
                            <>
                              <div className="grid grid-cols-2 gap-2">
                                <div><span className="text-slate-500">Company:</span> <span className="font-medium">{itemDetail.company_name}</span></div>
                                <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{itemDetail.customer_name}</span></div>
                                <div><span className="text-slate-500">Warehouse:</span> <span className="font-medium">{itemDetail.warehouse_name}</span></div>
                                <div><span className="text-slate-500">Date:</span> <span className="font-medium">{fmtDate(itemDetail.so_date)}</span></div>
                                <div><span className="text-slate-500">Destination:</span> <span className="font-medium">{itemDetail.destination || '-'}</span></div>
                                <div><span className="text-slate-500">Total:</span> <span className="font-bold">{fmt(itemDetail.total_amount)}</span></div>
                              </div>
                              {itemDetail.so_lines?.length > 0 && (
                                <div className="mt-2">
                                  <p className="font-semibold text-slate-600 mb-1">Product Lines ({itemDetail.so_lines.length})</p>
                                  <table className="w-full text-xs border-collapse">
                                    <thead><tr className="bg-white"><th className="px-2 py-1 text-left border-b">Product</th><th className="px-2 py-1 text-right border-b">Qty</th><th className="px-2 py-1 border-b">UOM</th><th className="px-2 py-1 text-right border-b">Price</th><th className="px-2 py-1 text-right border-b">Total</th><th className="px-2 py-1 text-right border-b text-orange-600">Pending</th></tr></thead>
                                    <tbody>{itemDetail.so_lines.map((l, j) => (
                                      <tr key={j} className="border-b border-slate-100"><td className="px-2 py-1 font-medium">{l.product_name}</td><td className="px-2 py-1 text-right">{fmtQty(l.quantity_ordered)}</td><td className="px-2 py-1">{l.uom}</td><td className="px-2 py-1 text-right">{fmt(l.unit_price)}</td><td className="px-2 py-1 text-right font-medium">{fmt(l.line_total)}</td><td className="px-2 py-1 text-right text-orange-600">{fmtQty(l.pending_qty)}</td></tr>
                                    ))}</tbody>
                                  </table>
                                </div>
                              )}
                            </>
                          )}

                          {/* DC Detail */}
                          {item.type === 'dc' && (
                            <>
                              <div className="grid grid-cols-2 gap-2">
                                <div><span className="text-slate-500">Warehouse:</span> <span className="font-medium">{itemDetail.warehouse_name}</span></div>
                                <div><span className="text-slate-500">Date:</span> <span className="font-medium">{fmtDate(itemDetail.dispatch_date)}</span></div>
                                <div><span className="text-slate-500">Invoice:</span> <span className="font-medium">{itemDetail.invoice_no || '-'}</span></div>
                                <div><span className="text-slate-500">Lorry:</span> <span className="font-medium">{itemDetail.lorry_no || '-'}</span></div>
                                <div><span className="text-slate-500">Linked SO:</span> <span className="font-medium">{itemDetail.linked_so_no || '-'}</span></div>
                                <div><span className="text-slate-500">Total Qty:</span> <span className="font-bold">{fmtQty(itemDetail.total_dispatch_qty)}</span></div>
                              </div>
                              {itemDetail.dc_lines?.length > 0 && (
                                <div className="mt-2">
                                  <p className="font-semibold text-slate-600 mb-1">Dispatch Items ({itemDetail.dc_lines.length})</p>
                                  <table className="w-full text-xs border-collapse">
                                    <thead><tr className="bg-white"><th className="px-2 py-1 text-left border-b">Product</th><th className="px-2 py-1 text-right border-b">Dispatched</th><th className="px-2 py-1 border-b">UOM</th><th className="px-2 py-1 text-right border-b text-orange-600">Pending</th></tr></thead>
                                    <tbody>{itemDetail.dc_lines.map((l, j) => (
                                      <tr key={j} className="border-b border-slate-100"><td className="px-2 py-1 font-medium">{l.product_name}</td><td className="px-2 py-1 text-right">{fmtQty(l.quantity_dispatched)}</td><td className="px-2 py-1">{l.uom}</td><td className="px-2 py-1 text-right text-orange-600">{fmtQty(l.pending_qty)}</td></tr>
                                    ))}</tbody>
                                  </table>
                                </div>
                              )}
                            </>
                          )}

                          {/* CPO Detail — supports both list ({results: [...]}) and direct ({...}) responses */}
                          {item.type === 'cpo' && (() => {
                            const d = itemDetail?.results ? itemDetail.results[0] : itemDetail;
                            if (!d) return null;
                            return (
                              <>
                                <div className="grid grid-cols-2 gap-2">
                                  <div><span className="text-slate-500">PO No:</span> <span className="font-medium">{d.upload_id}</span></div>
                                  <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{d.customer_name}</span></div>
                                  <div><span className="text-slate-500">Company:</span> <span className="font-medium">{d.company_name}</span></div>
                                  <div><span className="text-slate-500">Warehouse:</span> <span className="font-medium">{d.warehouse_name || '-'}</span></div>
                                  <div><span className="text-slate-500">Date:</span> <span className="font-medium">{fmtDate(d.po_date)}</span></div>
                                  <div><span className="text-slate-500">Status:</span> <Badge status={d.status} /></div>
                                  {d.po_number && <div><span className="text-slate-500">Customer PO #:</span> <span className="font-medium">{d.po_number}</span></div>}
                                  {d.destination && <div><span className="text-slate-500">Destination:</span> <span className="font-medium">{d.destination}</span></div>}
                                </div>
                                {d.parsed_lines?.length > 0 && (
                                  <div className="mt-2">
                                    <p className="font-semibold text-slate-600 mb-1">PO Lines ({d.parsed_lines.length})</p>
                                    <table className="w-full text-xs border-collapse">
                                      <thead><tr className="bg-white"><th className="px-2 py-1 text-left border-b">Product</th><th className="px-2 py-1 text-right border-b">Qty</th><th className="px-2 py-1 border-b">UOM</th><th className="px-2 py-1 text-right border-b">Rate</th><th className="px-2 py-1 text-right border-b">Total</th></tr></thead>
                                      <tbody>{d.parsed_lines.map((l, j) => (
                                        <tr key={j} className="border-b border-slate-100"><td className="px-2 py-1 font-medium">{l.product_name || l.product_description}</td><td className="px-2 py-1 text-right">{fmtQty(l.quantity)}</td><td className="px-2 py-1">{l.uom}</td><td className="px-2 py-1 text-right">{fmt(l.price)}</td><td className="px-2 py-1 text-right font-medium">{fmt(l.line_total)}</td></tr>
                                      ))}</tbody>
                                    </table>
                                  </div>
                                )}
                              </>
                            );
                          })()}

                          {/* Freight Detail */}
                          {item.type === 'freight_detail' && itemDetail && (
                            <div className="grid grid-cols-2 gap-2">
                              <div><span className="text-slate-500">Freight No:</span> <span className="font-medium">{itemDetail.freight_no}</span></div>
                              <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{itemDetail.customer_name_display || '-'}</span></div>
                              <div><span className="text-slate-500">Lorry:</span> <span className="font-medium">{itemDetail.lorry_no || '-'}</span></div>
                              <div><span className="text-slate-500">Destination:</span> <span className="font-medium">{itemDetail.destination || '-'}</span></div>
                              <div><span className="text-slate-500">Total Freight:</span> <span className="font-bold">{fmt(itemDetail.total_freight)}</span></div>
                              <div><span className="text-slate-500">Paid:</span> <span className="font-medium text-green-700">{fmt(itemDetail.freight_paid)}</span></div>
                            </div>
                          )}

                          {/* Outward Freight */}
                          {item.type === 'outward_freight' && itemDetail && (
                            <div className="grid grid-cols-2 gap-2">
                              <div><span className="text-slate-500">Advice No:</span> <span className="font-medium">{itemDetail.advice_no}</span></div>
                              <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{itemDetail.customer_name || '-'}</span></div>
                              <div><span className="text-slate-500">Lorry:</span> <span className="font-medium">{itemDetail.lorry_no || '-'}</span></div>
                              <div><span className="text-slate-500">Payable:</span> <span className="font-bold">{fmt(itemDetail.payable_amount)}</span></div>
                              <div><span className="text-slate-500">Paid:</span> <span className="font-medium text-green-700">{fmt(itemDetail.total_paid)}</span></div>
                              <div><span className="text-slate-500">Balance:</span> <span className="font-medium text-orange-600">{fmt(itemDetail.balance)}</span></div>
                            </div>
                          )}

                          {/* Freight Payment */}
                          {item.type === 'freight_payment' && itemDetail && (
                            <div className="grid grid-cols-2 gap-2">
                              <div><span className="text-slate-500">Freight:</span> <span className="font-medium">{itemDetail.advice_no || '-'}</span></div>
                              <div><span className="text-slate-500">Amount:</span> <span className="font-bold text-green-700">{fmt(itemDetail.amount_paid)}</span></div>
                              <div><span className="text-slate-500">Mode:</span> <span className="font-medium">{itemDetail.payment_mode}</span></div>
                              <div><span className="text-slate-500">Date:</span> <span className="font-medium">{fmtDate(itemDetail.payment_date)}</span></div>
                              <div><span className="text-slate-500">Reference:</span> <span className="font-medium">{itemDetail.reference_no || '-'}</span></div>
                            </div>
                          )}

                          {/* Invoice */}
                          {item.type === 'invoice' && itemDetail && (
                            <div className="grid grid-cols-2 gap-2">
                              <div><span className="text-slate-500">Invoice No:</span> <span className="font-medium">{itemDetail.invoice_no}</span></div>
                              <div><span className="text-slate-500">Date:</span> <span className="font-medium">{fmtDate(itemDetail.invoice_date)}</span></div>
                              <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{itemDetail.customer_name || '-'}</span></div>
                              <div><span className="text-slate-500">Grand Total:</span> <span className="font-bold">{fmt(itemDetail.grand_total)}</span></div>
                              <div><span className="text-slate-500">Subtotal:</span> <span className="font-medium">{fmt(itemDetail.subtotal)}</span></div>
                              <div><span className="text-slate-500">Tax:</span> <span className="font-medium">{fmt((Number(itemDetail.cgst_total) || 0) + (Number(itemDetail.sgst_total) || 0) + (Number(itemDetail.igst_total) || 0))}</span></div>
                            </div>
                          )}

                          {/* Receivable */}
                          {item.type === 'receivable' && itemDetail && (
                            <div className="grid grid-cols-2 gap-2">
                              <div><span className="text-slate-500">Invoice:</span> <span className="font-medium">{itemDetail.invoice_no || '-'}</span></div>
                              <div><span className="text-slate-500">Customer:</span> <span className="font-medium">{itemDetail.customer_name || '-'}</span></div>
                              <div><span className="text-slate-500">Amount:</span> <span className="font-bold">{fmt(itemDetail.amount)}</span></div>
                              <div><span className="text-slate-500">Received:</span> <span className="font-medium text-green-700">{fmt(itemDetail.amount_paid)}</span></div>
                              <div><span className="text-slate-500">Balance:</span> <span className="font-medium text-orange-600">{fmt(itemDetail.balance)}</span></div>
                              <div><span className="text-slate-500">Due Date:</span> <span className="font-medium">{fmtDate(itemDetail.due_date)}</span></div>
                            </div>
                          )}

                          {/* Navigate button */}
                          <button onClick={() => { navigate(`${selectedNode.path}/${item.id}`); setSelectedNode(null); }}
                            className="w-full mt-2 flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700">
                            <Eye size={12} /> View Full Details
                          </button>
                        </div>
                      ) : (
                        <p className="text-center text-slate-400 py-3 text-xs">Could not load details</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* Flow Bot — appears when an SO is loaded */}
      {flowData?.so && <FlowBot soId={flowData.so.id} soNo={flowData.so.so_no} />}
    </MainLayout>
  );
}
