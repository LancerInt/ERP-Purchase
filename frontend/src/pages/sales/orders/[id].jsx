import { confirm } from '@/components/common/confirm';
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft, CheckCircle, XCircle, Edit3, Trash2, FileText, Download, ExternalLink, Truck,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments from '../components/FileAttachments';
import ActivityLog from '@/components/common/ActivityLog';
import { parseAddress } from '../../../components/common/AddressField';
import ConsigneeBilling from '../../../components/common/ConsigneeBilling';
import StockCheckSection from './StockCheckSection';
import { formatCurrency, formatDate as formatDateUtil } from '@/utils/formatters';

function AddressBlock({ value }) {
  const a = parseAddress(value);
  if (!a.raw_address && !a.state && !a.district && !a.pincode) {
    return <span className="text-slate-400">-</span>;
  }
  return (
    <div className="leading-snug">
      {a.raw_address && <div className="text-slate-800">{a.raw_address}</div>}
      <div className="text-slate-700">
        {[a.district, a.state].filter(Boolean).join(', ')}
        {a.pincode ? ` - ${a.pincode}` : ''}
      </div>
      {a.country && <div className="text-slate-500 text-xs">{a.country}</div>}
    </div>
  );
}

export default function SalesOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const backTo = location.state?.backTo || '/sales/orders';
  const { canEdit, canDelete, canApprove, canReject, canPrint, canCreateDc } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Order');
  const { isHidden: isLineHidden } = useFieldPermissions('Sales Order Line');

  const [so, setSO] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [linkedDCs, setLinkedDCs] = useState([]);
  // Bubbled up from StockCheckSection — true when every line on the
  // factory matrix shows Remaining = 0 (finished_goods_qty meets the
  // SO's quantity_ordered). Gates the "Create Dispatch Challan" button
  // in the page header alongside the SO-level pending-dispatch check.
  const [allFinished, setAllFinished] = useState(false);

  useEffect(() => { fetchSO(); fetchLinkedDCs(); }, [id]);

  const fetchSO = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/sales/orders/${id}/`);
      setSO(res.data);
    } catch (err) {
      if (err.response?.status !== 404) toast.error('Failed to load Sales Order');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchLinkedDCs = async () => {
    try {
      const res = await apiClient.get(`/api/sales/orders/${id}/linked-dcs/`);
      setLinkedDCs(res.data || []);
    } catch {
      setLinkedDCs([]);
    }
  };

  const handleDownloadPDF = async () => {
    setIsDownloading(true);
    try {
      const res = await apiClient.get(`/api/sales/orders/${id}/download-pdf/`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${so.so_no}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success('PDF downloaded');
    } catch {
      toast.error('Failed to download PDF');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Are you sure you want to delete Sales Order ${so.so_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/orders/${id}/`);
      toast.success(`Sales Order ${so.so_no} deleted`);
      navigate('/sales/orders');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const handleApprove = async () => {
    if (!(await confirm({ message: 'Approve this Sales Order? A Dispatch Challan will be auto-created.' }))) return;
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/sales/orders/${id}/approve/`);
      const dcNo = res.data?.dc_no;
      toast.success(dcNo ? `Approved! DC ${dcNo} created.` : 'Approved!', { duration: 5000 });
      fetchSO();
      fetchLinkedDCs();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to approve');
    } finally {
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    if (!(await confirm({ message: 'Reject this Sales Order?', isDangerous: true, confirmLabel: 'Reject' }))) return;
    setIsRejecting(true);
    try {
      await apiClient.post(`/api/sales/orders/${id}/reject/`);
      toast.success('Sales Order rejected');
      fetchSO();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to reject');
    } finally {
      setIsRejecting(false);
    }
  };

  const formatDate = (d) => {
    if (!d) return '-';
    return formatDateUtil(d);
  };

  const fmt = (v) => {
    const n = Number(v);
    if (isNaN(n)) return '-';
    return formatCurrency(n);
  };

  const fmtQty = (v) => {
    const n = Number(v);
    if (isNaN(n)) return '-';
    return n.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  };

  const termLabel = (val) => {
    const map = {
      'TO_PAY': 'To Pay', 'PAID': 'Paid', 'MIXED': 'Mixed',
      'NET_15': 'Net 15', 'NET_30': 'Net 30', 'NET_45': 'Net 45', 'CUSTOM': 'Custom',
      'INR': 'INR (₹)', 'USD': 'USD ($)',
    };
    return map[val] || val || '-';
  };

  const categoryLabel = (val) => {
    const map = {
      'RAW_MATERIAL': 'Raw Material', 'PACKING_MATERIAL': 'Packing Material',
      'FINISHED_GOOD': 'Finished Good', 'SEMI_FINISHED': 'Semi Finished',
      'TRADED_PRODUCTS': 'Traded Products', 'CAPITAL_GOOD': 'Capital Good',
      'MACHINE_SPARES': 'Machine Spares', 'CONSUMABLES': 'Consumables',
    };
    return map[val] || val || '-';
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="space-y-4 max-w-6xl">
          {[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}
        </div>
      </MainLayout>
    );
  }

  if (!so) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <FileText className="mx-auto text-slate-300 mb-4" size={48} />
          <p className="text-slate-600 text-lg">Sales Order not found</p>
          <button onClick={() => navigate(backTo, { replace: true })} className="mt-4 px-4 py-2 text-blue-600 hover:text-blue-800">
            Back to Sales Orders
          </button>
        </div>
      </MainLayout>
    );
  }

  const status = so.approval_status || 'DRAFT';
  const isDraft = status === 'DRAFT';
  const isPending = status === 'PENDING';
  const lines = so.so_lines || [];
  const hasEditPerm = canEdit('Sales Order');
  const hasDeletePerm = canDelete('Sales Order');
  // Button-level gates. canPrint controls the "Download PDF" header
  // button; the green "Create Dispatch Challan" CTA is gated on the
  // dedicated `can_create_dc` flag on the Sales Order row. Admins tick
  // it via Button Permissions tab → Sales Order row → Create DC
  // column. Backend `CreateDispatchChallanPermission` accepts this
  // flag as authorization for the DC create endpoint, so one tick
  // covers both UI visibility and the actual save.
  const hasPrintPerm = canPrint('Sales Order');
  const hasCreateDCPerm = canCreateDc('Sales Order');

  const subtotal = lines.reduce((s, l) => {
    const qty = Number(l.quantity_ordered) || 0;
    const price = Number(l.unit_price) || 0;
    const disc = Number(l.discount) || 0;
    return s + (qty * price - disc);
  }, 0);

  const totalTax = lines.reduce((s, l) => {
    const qty = Number(l.quantity_ordered) || 0;
    const price = Number(l.unit_price) || 0;
    const disc = Number(l.discount) || 0;
    const gst = Number(l.gst) || 0;
    const afterDisc = qty * price - disc;
    return s + (afterDisc * gst / 100);
  }, 0);

  const grandTotal = subtotal + totalTax;
  const totalQty = lines.reduce((s, l) => s + (Number(l.quantity_ordered) || 0), 0);
  const totalPending = lines.reduce((s, l) => s + (Number(l.pending_qty) || 0), 0);

  // Field-permission visibility. The backend FieldPermissionMixin strips
  // HIDDEN fields from line responses entirely — the key is just absent
  // from the JSON. We detect that here and hide the corresponding
  // columns / summary rows instead of letting them render as "₹0.00",
  // which is what the Number(...) || 0 fallback used to do.
  // A field is visible if any line still carries the key. (All lines
  // are serialized with the same permissions, so checking one is
  // enough; folding across lines is just defensive.)
  const lineHasField = (key) => lines.some((l) => l && Object.prototype.hasOwnProperty.call(l, key));
  const showUnitPrice = lineHasField('unit_price') && !isLineHidden('unit_price');
  const showDiscount  = lineHasField('discount')   && !isLineHidden('discount');
  const showGst       = lineHasField('gst')        && !isLineHidden('gst');
  // Field-permission gates for the remaining catalog-backed line columns.
  const showLineProduct = !isLineHidden('product');
  const showLineQty     = !isLineHidden('quantity_ordered');
  const showLineUom     = !isLineHidden('uom');
  const showLineDelivery = !isLineHidden('delivery_schedule_date');
  const showLineRemarks  = !isLineHidden('remarks');
  // Total / financial summary are derived from price + discount + gst,
  // so they only make sense when all three are visible. Hide them too
  // if any input field is stripped — showing a "Grand Total" computed
  // from masked values would silently leak the hidden information.
  const showLineTotal = showUnitPrice && showDiscount && showGst;
  const showFinancialSummary = showLineTotal;
  const showPending = lineHasField('pending_qty');

  const InfoField = ({ label, children }) => (
    <div>
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
      <p className="text-slate-900 font-semibold mt-1">{children}</p>
    </div>
  );

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/orders'))} className="p-1 text-slate-500 hover:text-slate-700" title="Back">
                <ArrowLeft size={20} />
              </button>
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 break-all">{so.so_no}</h1>
            </div>
            <div className="flex items-center gap-3 ml-8">
              <StatusBadge status={status} />
              <p className="text-slate-500 text-xs sm:text-sm whitespace-nowrap">Created on {formatDate(so.so_date || so.created_at)}</p>
              <div className="flex items-center gap-2 ml-auto">
                {(so.customer_po_numbers || []).map((cpo, i) => {
                  const isObj = cpo && typeof cpo === 'object';
                  const label = isObj ? cpo.upload_id : cpo;
                  const cpoId = isObj ? cpo.id : null;
                  return cpoId ? (
                    <button key={i} onClick={() => navigate(`/sales/customer-po/${cpoId}`)} className="text-blue-700 hover:underline text-xs sm:text-sm font-semibold whitespace-nowrap max-w-[120px] truncate">{label}</button>
                  ) : (
                    <span key={i} className="text-slate-600 text-xs sm:text-sm font-semibold whitespace-nowrap">{label}</span>
                  );
                })}
                {hasPrintPerm && (
                  <button onClick={handleDownloadPDF} disabled={isDownloading} title="Download PDF" aria-label="Download PDF" className="p-1.5 border border-blue-300 rounded-lg text-blue-700 hover:bg-blue-50 disabled:opacity-50 shrink-0">
                    <Download size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 flex-wrap ml-8 sm:ml-0">
            {/* Create Dispatch Challan — header-level entry point.
                Only rendered when:
                  • the factory matrix says every line is finished
                    (allFinished, bubbled from StockCheckSection), AND
                  • the SO still has pending qty to ship (totalPending
                    > 0 — once fully dispatched the button disappears).
                Bounces to /sales/orders?dc=<id> where the list page's
                deep-link effect opens the create-DC modal with this
                SO pre-loaded. */}
            {hasCreateDCPerm && allFinished && totalPending > 0 && (
              <button
                type="button"
                onClick={() => navigate(`/sales/orders?dc=${id}`)}
                title="Create Dispatch Challan"
                aria-label="Create Dispatch Challan"
                className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-xs sm:text-sm font-semibold"
              >
                <Truck size={16} /> Create Dispatch Challan
              </button>
            )}
            {/* Download PDF moved into the status row as an icon. */}
            {hasEditPerm && (isDraft || isPending) && (
              <button onClick={() => navigate(`/sales/orders/${id}/edit`)} title="Edit" aria-label="Edit" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-medium">
                <Edit3 size={16} /> Edit
              </button>
            )}
            {hasDeletePerm && (isDraft || isPending) && (
              <button onClick={handleDelete} title="Delete" aria-label="Delete" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 text-xs sm:text-sm font-medium">
                <Trash2 size={16} /> Delete
              </button>
            )}
            {(isDraft || isPending) && canApprove('Sales Order') && (
              <button onClick={handleApprove} disabled={isApproving} title="Approve" aria-label="Approve" className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-xs sm:text-sm font-medium disabled:opacity-50">
                <CheckCircle size={16} /> {isApproving ? 'Approving...' : 'Approve'}
              </button>
            )}
            {(isDraft || isPending) && canReject('Sales Order') && (
              <button onClick={handleReject} disabled={isRejecting} title="Reject" aria-label="Reject" className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-xs sm:text-sm font-medium disabled:opacity-50">
                <XCircle size={16} /> {isRejecting ? 'Rejecting...' : 'Reject'}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-4 sm:space-y-6">

            {/* Factory Stock Check — matrix-style stock vs. requirement
                report for every SO line. Factory persons fill the
                NEED / AVAILABLE columns; REQUIREMENT and the shortfall
                list compute live. Owns its own state + endpoints (see
                StockCheckSection.jsx + stock_check_views.py). */}
            <StockCheckSection
              soId={so.id}
              soNo={so.so_no}
              soStatus={so.approval_status || ''}
              onAllFinishedChange={setAllFinished}
            />

            {/* Order Details */}
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Order Details</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2.5 sm:gap-5">
                {!isHidden('so_no') && <InfoField label="SO Number">{so.so_no}</InfoField>}
                {!isHidden('company') && <InfoField label="Company">{so.company_name || '-'}</InfoField>}
                {!isHidden('customer') && <InfoField label="Customer">{so.customer_name || '-'}</InfoField>}
                {!isHidden('warehouse') && <InfoField label="Warehouse">{so.warehouse_name || '-'}</InfoField>}
                {!isHidden('so_date') && <InfoField label="SO Date">{formatDate(so.so_date)}</InfoField>}
                {!isHidden('freight_terms') && <InfoField label="Freight Terms">{termLabel(so.freight_terms)}</InfoField>}
                {!isHidden('payment_terms') && <InfoField label="Payment Terms">{termLabel(so.payment_terms)}</InfoField>}
                {!isHidden('currency') && <InfoField label="Currency">{termLabel(so.currency)}</InfoField>}
              </div>
            </div>

            {/* Shipping & Reference */}
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Shipping & Reference</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2.5 sm:gap-5">
                {!isHidden('delivery_terms') && <InfoField label="Delivery Terms">{termLabel(so.delivery_terms)}</InfoField>}
                {!isHidden('required_ship_date') && <InfoField label="Required Ship Date">{formatDate(so.required_ship_date)}</InfoField>}
                {!isHidden('delivery_due_date') && <InfoField label="Delivery Due Date">{formatDate(so.delivery_due_date)}</InfoField>}
                {!isHidden('payment_due_date') && Object.prototype.hasOwnProperty.call(so, 'payment_due_date') && (
                  <InfoField label="Payment Due Date">{formatDate(so.payment_due_date)}</InfoField>
                )}
                {!isHidden('destination') && <InfoField label="Destination">{so.destination || '-'}</InfoField>}
                {!isHidden('dispatched_through') && <InfoField label="Dispatched Through">{termLabel(so.dispatched_through)}</InfoField>}
              </div>
            </div>

            {/* Consignee & Billing */}
            <ConsigneeBilling
              consignee={{
                name: so.consignee_name, gstin: so.consignee_gstin, address: so.consignee_address,
                hidden: { name: isHidden('consignee_name'), gstin: isHidden('consignee_gstin'), address: isHidden('consignee_address') },
              }}
              billing={{
                name: so.billing_name || so.company_name, gstin: so.billing_gstin, address: so.billing_address,
                hidden: { gstin: isHidden('billing_gstin'), address: isHidden('billing_address') },
              }}
            />

            {/* Additional Information */}
            {((so.special_instructions && !isHidden('special_instructions')) || (so.remarks && !isHidden('remarks'))) && (
              <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
                <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Additional Information</h2>
                <div className="grid grid-cols-2 md:grid-cols-2 gap-5">
                  {!isHidden('special_instructions') && (
                    <InfoField label="Special Instructions">
                      <span className="font-normal text-sm">{so.special_instructions || '-'}</span>
                    </InfoField>
                  )}
                  {!isHidden('remarks') && (
                    <InfoField label="Remarks">
                      <span className="font-normal text-sm">{so.remarks || '-'}</span>
                    </InfoField>
                  )}
                </div>
              </div>
            )}

            {/* Product Lines */}
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">
                Product Lines ({lines.length})
              </h2>
              {lines.length === 0 ? (
                <p className="text-slate-500 text-center py-4 sm:py-6">No line items</p>
              ) : (
                <>
                  {/* Mobile-only line cards. The 12-column desktop table
                      below scrolls horizontally on a phone, which makes
                      reading any single line nearly impossible. Cards
                      show the same fields stacked, one line per card. */}
                  <div className="sm:hidden space-y-3">
                    {lines.map((line, idx) => {
                      const qty = Number(line.quantity_ordered) || 0;
                      const price = Number(line.unit_price) || 0;
                      const disc = Number(line.discount) || 0;
                      const gst = Number(line.gst) || 0;
                      const afterDisc = qty * price - disc;
                      const lineTotal = afterDisc + (afterDisc * gst / 100);
                      const pending = Number(line.pending_qty) || 0;
                      return (
                        <div key={line.id || idx} className="border border-slate-200 rounded-lg overflow-hidden">
                          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs text-slate-400">Line #{line.line_no || idx + 1}</p>
                              {showLineProduct && <p className="text-sm font-semibold text-slate-800 break-words">{line.product_name || '-'}</p>}
                              {showLineProduct && line.product_sku && <p className="text-[11px] text-slate-500 mt-0.5">{line.product_sku}</p>}
                            </div>
                            {showLineTotal && (
                              <p className="shrink-0 text-base font-bold text-slate-900 whitespace-nowrap">{fmt(lineTotal)}</p>
                            )}
                          </div>
                          <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                            {line.product_category && (
                              <div className="col-span-2">
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Category</span>
                                <p className="text-slate-700">{categoryLabel(line.product_category)}</p>
                              </div>
                            )}
                            {showLineQty && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Qty</span>
                                <p className="text-slate-800 font-medium">{fmtQty(qty)} {showLineUom ? (line.uom || '') : ''}</p>
                              </div>
                            )}
                            {showUnitPrice && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Unit Price</span>
                                <p className="text-slate-700">{fmt(price)}</p>
                              </div>
                            )}
                            {showDiscount && disc > 0 && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Discount</span>
                                <p className="text-red-600">{fmt(disc)}</p>
                              </div>
                            )}
                            {showGst && gst > 0 && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">GST</span>
                                <p className="text-slate-700">{gst}%</p>
                              </div>
                            )}
                            {showPending && pending > 0 && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Pending</span>
                                <p className="text-orange-600 font-medium">{fmtQty(pending)}</p>
                              </div>
                            )}
                            {showLineDelivery && line.delivery_schedule_date && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Delivery</span>
                                <p className="text-slate-700">{formatDate(line.delivery_schedule_date)}</p>
                              </div>
                            )}
                            {showLineRemarks && line.remarks && (
                              <div className="col-span-2">
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Remarks</span>
                                <p className="text-slate-700">{line.remarks}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-slate-500">Total Qty</span><span className="font-medium text-slate-800">{fmtQty(totalQty)}</span></div>
                      {showFinancialSummary && (
                        <>
                          <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-medium text-slate-800">{fmt(subtotal)}</span></div>
                          <div className="flex justify-between"><span className="text-slate-500">Total GST</span><span className="font-medium text-slate-700">{fmt(totalTax)}</span></div>
                        </>
                      )}
                      {showPending && (
                        <div className="flex justify-between"><span className="text-slate-500">Pending Dispatch</span><span className="font-medium text-orange-600">{fmtQty(totalPending)}</span></div>
                      )}
                      {showFinancialSummary && (
                        <div className="flex justify-between pt-2 mt-1 border-t border-slate-300">
                          <span className="text-slate-700 font-semibold">Grand Total</span>
                          <span className="text-base font-bold text-slate-900">{fmt(grandTotal)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Desktop table — hidden on mobile, original markup. */}
                  <div className="hidden sm:block overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                  <table className="w-full text-xs sm:text-sm">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">#</th>
                        <th className="text-left py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Category</th>
                        {showLineProduct && <th className="text-left py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Product</th>}
                        {showLineQty && <th className="text-right py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Qty</th>}
                        {showLineUom && <th className="text-left py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">UOM</th>}
                        {showUnitPrice && <th className="text-right py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Unit Price</th>}
                        {showDiscount && <th className="text-right py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Discount</th>}
                        {showGst && <th className="text-right py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">GST %</th>}
                        {showLineTotal && <th className="text-right py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Total</th>}
                        {showPending && <th className="text-right py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Pending Dispatch</th>}
                        {showLineDelivery && <th className="text-left py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Delivery Date</th>}
                        {showLineRemarks && <th className="text-left py-2 px-2 sm:px-3 text-xs font-medium text-slate-500 uppercase whitespace-nowrap">Remarks</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {lines.map((line, idx) => {
                        const qty = Number(line.quantity_ordered) || 0;
                        const price = Number(line.unit_price) || 0;
                        const disc = Number(line.discount) || 0;
                        const gst = Number(line.gst) || 0;
                        const afterDisc = qty * price - disc;
                        const lineTotal = afterDisc + (afterDisc * gst / 100);
                        const pending = Number(line.pending_qty) || 0;
                        return (
                          <tr key={line.id || idx} className="hover:bg-primary-50/40 transition-colors">
                            <td className="py-3 px-3 text-slate-500">{line.line_no || idx + 1}</td>
                            <td className="py-3 px-3 text-slate-600 text-xs whitespace-nowrap">{categoryLabel(line.product_category)}</td>
                            {showLineProduct && (
                              <td className="py-3 px-3 min-w-[220px]">
                                <p className="font-medium text-slate-800 whitespace-nowrap">{line.product_name || '-'}</p>
                                {line.product_sku && <p className="text-xs text-slate-400 mt-0.5">{line.product_sku}</p>}
                              </td>
                            )}
                            {showLineQty && <td className="py-3 px-3 text-right font-medium">{fmtQty(qty)}</td>}
                            {showLineUom && <td className="py-3 px-3 text-slate-600">{line.uom || '-'}</td>}
                            {showUnitPrice && <td className="py-3 px-3 text-right">{fmt(price)}</td>}
                            {showDiscount && <td className="py-3 px-3 text-right">{fmt(disc)}</td>}
                            {showGst && <td className="py-3 px-3 text-right text-slate-600">{gst}%</td>}
                            {showLineTotal && <td className="py-3 px-3 text-right font-medium">{fmt(lineTotal)}</td>}
                            {showPending && <td className="py-3 px-3 text-right font-medium text-orange-600">{fmtQty(pending)}</td>}
                            {showLineDelivery && <td className="py-3 px-3 text-slate-600">{formatDate(line.delivery_schedule_date)}</td>}
                            {showLineRemarks && <td className="py-3 px-3 text-slate-500 text-xs">{line.remarks || '-'}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      {/* Footer column-count must match the header. We
                          rebuild it from the same flags so it adapts when
                          financial columns are stripped. */}
                      <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                        <td colSpan={2 + (showLineProduct ? 1 : 0)} className="py-3 px-3 text-right text-slate-600">Totals</td>
                        {showLineQty && <td className="py-3 px-3 text-right">{fmtQty(totalQty)}</td>}
                        {showLineUom && <td></td>}
                        {showUnitPrice && <td></td>}
                        {showDiscount && <td></td>}
                        {showGst && <td></td>}
                        {showLineTotal && <td className="py-3 px-3 text-right text-base">{fmt(grandTotal)}</td>}
                        {showPending && <td className="py-3 px-3 text-right text-orange-600">{fmtQty(totalPending)}</td>}
                        {showLineDelivery && <td></td>}
                        {showLineRemarks && <td></td>}
                      </tr>
                    </tfoot>
                  </table>

                  {/* Financial Summary — hidden entirely when the user
                      cannot see unit_price / discount / gst. Showing a
                      computed Grand Total off masked inputs would leak
                      the hidden numbers, so we drop the whole panel. */}
                  {showFinancialSummary && (
                    <div className="border-t border-slate-200 mt-2 pt-4 flex justify-end">
                      <div className="w-72 space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-slate-600">Subtotal (after discount)</span>
                          <span className="font-medium">{fmt(subtotal)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">Total GST</span>
                          <span className="font-medium">{fmt(totalTax)}</span>
                        </div>
                        <div className="flex justify-between border-t pt-2 text-base">
                          <span className="font-semibold text-slate-800">Grand Total</span>
                          <span className="font-bold text-slate-900">{fmt(grandTotal)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-4 sm:space-y-6">
            {/* Approval + Dispatch Challans share a row on mobile; stacked
                again in the narrow desktop sidebar. */}
            <div className="grid grid-cols-2 lg:grid-cols-1 gap-3 sm:gap-5 items-start">
              {/* Approval Info */}
              <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
                <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3">Approval</h3>
                <div className="text-sm">
                  {status === 'APPROVED' ? (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <span className="inline-flex items-center px-2.5 py-1 bg-green-50 text-green-700 border border-green-200 rounded-lg text-xs font-semibold">Approved</span>
                      {so.approved_by_name && (
                        <div><span className="text-[11px] uppercase text-slate-400 mr-1">By</span><span className="font-medium text-slate-800">{so.approved_by_name}</span></div>
                      )}
                      {so.approval_date && (
                        <div><span className="text-[11px] uppercase text-slate-400 mr-1">On</span><span className="font-medium text-slate-800">{formatDate(so.approval_date)}</span></div>
                      )}
                    </div>
                  ) : status === 'REJECTED' ? (
                    <span className="inline-flex items-center px-2.5 py-1 bg-red-50 text-red-700 border border-red-200 rounded-lg text-xs font-semibold">Rejected</span>
                  ) : (
                    <p className="text-amber-600 font-medium">Pending approval</p>
                  )}
                </div>
              </div>

              {/* Linked Dispatch Challans */}
              <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
                <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3">Dispatch Challans</h3>
                {linkedDCs.length === 0 ? (
                  <p className="text-sm text-slate-400">No dispatch challans yet</p>
                ) : (
                  <div className="space-y-2">
                    {linkedDCs.map(dc => (
                      <button
                        key={dc.id}
                        onClick={() => navigate(`/sales/dc/${dc.id}`)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 hover:bg-blue-50 border border-slate-200 rounded-lg transition group text-left"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-blue-700 group-hover:text-blue-800 truncate max-w-full">{dc.dc_no}</p>
                          <p className="text-xs text-slate-500">
                            {dc.dispatch_date ? formatDateUtil(dc.dispatch_date) : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <StatusBadge status={dc.status} />
                          <ExternalLink size={14} className="text-slate-400 group-hover:text-blue-600" />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Customer Info */}
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-3">Customer</h3>
              <div className="space-y-2 text-sm">
                <p className="font-medium text-slate-800">{so.customer_name || '-'}</p>
                {so.company_name && <p className="text-slate-500">Company: {so.company_name}</p>}
                {so.warehouse_name && <p className="text-slate-500">Warehouse: {so.warehouse_name}</p>}
              </div>
            </div>
          </div>
        </div>

        <FileAttachments module="SALES_ORDER" recordId={id} readOnly />

        <div className="mt-4">
          <ActivityLog module="Sales Order" recordId={id} />
        </div>
      </div>
    </MainLayout>
  );
}
