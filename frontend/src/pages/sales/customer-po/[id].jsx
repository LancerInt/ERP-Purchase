import { confirm } from '@/components/common/confirm';
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Edit3, Trash2, FileText, CheckCircle, ShoppingCart, XCircle, RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatAddressDisplay } from '../../../components/common/AddressField';
import ConsigneeBilling from '../../../components/common/ConsigneeBilling';
import FileAttachments from '../components/FileAttachments';
import { formatCurrency, formatDate } from '@/utils/formatters';

export default function CustomerPODetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Back honours a `backTo` URL passed by the caller (filtered list rows) so
  // Back restores the exact view they came from; otherwise falls back to each
  // button's existing default.
  const goBack = () => {
    const backTo = location.state?.backTo;
    if (backTo) navigate(backTo);
    else if (window.history.state?.idx > 0) navigate(-1);
    else navigate('/sales/customer-po');
  };
  const { canEdit, canDelete, canCreateSo, canView, canConfirm, canReject } = usePermissions();
  // Dedicated permission for the "Create SO" header button. Admins
  // tick can_create_so on the Customer PO row in the Sales Module
  // Permissions admin grid. Backend CreateSalesOrderPermission
  // honors the same flag, so one tick covers UI + save.
  const canCreateSOPerm = canCreateSo('Customer PO');
  // Cross-module nav: linked SO buttons in the "Linked Sales Orders"
  // panel. Falls back to plain text when the user lacks the perm so
  // the SO number is still visible for reference.
  const canSeeSO = canView('Sales Order');
  const [po, setPO] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    apiClient.get(`/api/sales/customer-po/${id}/`).then(r => {
      setPO(r.data);
    }).catch((err) => { if (err.response?.status !== 404) toast.error('Failed to load'); }).finally(() => setIsLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete ${po.upload_id}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try { await apiClient.delete(`/api/sales/customer-po/${id}/`); toast.success('Deleted'); navigate('/sales/customer-po'); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
  };

  const handleConfirm = async () => {
    if (!(await confirm({ message: 'Confirm this Customer PO?' }))) return;
    try {
      await apiClient.patch(`/api/sales/customer-po/${id}/`, { status: 'CONFIRMED' });
      toast.success('PO Confirmed!');
      setPO(prev => ({ ...prev, status: 'CONFIRMED' }));
    } catch { toast.error('Failed to confirm'); }
  };

  // Cancel = the explicit "reject" action. Once cancelled the PO is
  // locked from edits and ineligible to back a Sales Order — the
  // Create SO button hides and Confirm + Edit drop off. Delete still
  // works if the user wants the row gone entirely.
  const handleCancel = async () => {
    if (!(await confirm({ message: 'Cancel this Customer PO? Once cancelled it cannot be used to create a Sales Order.', isDangerous: true, confirmLabel: 'Cancel' }))) return;
    try {
      await apiClient.patch(`/api/sales/customer-po/${id}/`, { status: 'CANCELLED' });
      toast.success('PO Cancelled');
      setPO(prev => ({ ...prev, status: 'CANCELLED' }));
    } catch { toast.error('Failed to cancel'); }
  };

  // Re-fetch the authoritative price-list rate for every line from the
  // CURRENT price list. A draft's line prices are frozen at creation, so a
  // draft made before the price list existed shows ₹0 — this refreshes it
  // in place instead of re-uploading the PO.
  const [repricing, setRepricing] = useState(false);
  const handleReprice = async () => {
    setRepricing(true);
    try {
      const r = await apiClient.post(`/api/sales/customer-po/${id}/reprice/`);
      const { updated = 0, unresolved = [] } = r.data || {};
      if (updated > 0) {
        const fresh = await apiClient.get(`/api/sales/customer-po/${id}/`);
        setPO(fresh.data);
        toast.success(`Re-priced ${updated} line(s) from the price list.`);
      }
      if (unresolved.length) {
        toast(`No price-list rate for: ${unresolved.join(', ')}. Check the product is on this customer's price list.`,
          { icon: '⚠️', duration: 7000 });
      } else if (updated === 0) {
        toast('Nothing to re-price on this PO.', { icon: 'ℹ️' });
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to re-price.');
    } finally {
      setRepricing(false);
    }
  };

  const fmt = (v) => formatCurrency(v);
  const fmtDate = (d) => d ? formatDate(d) : '-';
  const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const termLabel = (v) => {
    const m = { 'TO_PAY': 'To Pay', 'PAID': 'Paid', 'NET_15': 'Net 15', 'NET_30': 'Net 30', 'NET_45': 'Net 45', 'EX_FACTORY': 'Ex-Factory', 'DOOR_DELIVERY': 'Door Delivery', 'CIF': 'CIF', 'FOB': 'FOB' };
    return m[v] || v || '-';
  };
  const catLabel = (v) => {
    const m = { 'RAW_MATERIAL': 'Raw Material', 'PACKING_MATERIAL': 'Packing Material', 'FINISHED_GOOD': 'Finished Good', 'SEMI_FINISHED': 'Semi Finished', 'TRADED_PRODUCTS': 'Traded Products', 'CAPITAL_GOOD': 'Capital Good', 'MACHINE_SPARES': 'Machine Spares', 'CONSUMABLES': 'Consumables' };
    return m[v] || v || '-';
  };

  // Mobile-tightened label/value pair. On mobile the label drops to
  // 10px and the value drops to a regular 14px so each row takes ~30%
  // less vertical space than the old `text-base font-semibold` value
  // did. On sm+ the label stays at xs and the value bumps to text-base
  // semibold — matching the pre-existing desktop look exactly.
  const Info = ({ label, children, className = '' }) => (
    <div className={className}>
      <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
      <p className="text-sm sm:text-base text-slate-900 font-medium sm:font-semibold mt-0.5 sm:mt-1 break-words">{children}</p>
    </div>
  );

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;
  if (!po) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Customer PO not found.</p>
        <button onClick={() => { const b = location.state?.backTo; if (b) navigate(b); else navigate('/sales/customer-po'); }} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Customer POs
        </button>
      </div>
    </MainLayout>
  );

  const lines = po.parsed_lines || [];
  const totalQty = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const totalDiscount = lines.reduce((s, l) => s + (Number(l.discount) || 0), 0);
  const totalSGST = lines.reduce((s, l) => { const sub = (Number(l.quantity) || 0) * (Number(l.price) || 0) - (Number(l.discount) || 0); return s + sub * (Number(l.sgst_percent) || 0) / 100; }, 0);
  const totalCGST = lines.reduce((s, l) => { const sub = (Number(l.quantity) || 0) * (Number(l.price) || 0) - (Number(l.discount) || 0); return s + sub * (Number(l.cgst_percent) || 0) / 100; }, 0);
  const grandTotal = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const isDraft = po.status === 'DRAFT';
  const isConfirmed = po.status === 'CONFIRMED';
  const isCancelled = po.status === 'CANCELLED';
  const hasLinkedSO = (po.linked_sos?.length > 0) || po.linked_sales_order || po.linked_so_number;

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-3 sm:space-y-6">
        {/* Header — mobile gets a smaller title (text-lg) and tighter
            vertical rhythm so the action row above the fold stays
            usable on phones. Desktop keeps the larger text-3xl. */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
          <div>
            <div className="flex items-center gap-2 sm:gap-3 mb-1.5 sm:mb-2">
              <button onClick={goBack} className="p-1 text-slate-500 hover:text-slate-700"><ArrowLeft size={18} /></button>
              <h1 className="text-lg sm:text-3xl font-bold text-slate-900 break-all">{po.upload_id}</h1>
            </div>
            <div className="flex items-center gap-3 sm:gap-4 ml-7 sm:ml-8">
              <StatusBadge status={po.status} />
              <p className="text-slate-500 text-xs sm:text-sm">{fmtDate(po.po_date || po.upload_date)}</p>
              {hasLinkedSO && (() => {
                const so = (po.linked_sos || [])[0] || (po.linked_so_number ? { id: po.linked_sales_order, so_no: po.linked_so_number } : null);
                return (
                  <div className="flex items-center gap-2 ml-auto">
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-green-50 text-green-700 border border-green-200 rounded-lg text-xs font-medium whitespace-nowrap"><ShoppingCart size={13} /> SO Created</span>
                    {so && (canSeeSO ? (
                      <button onClick={() => navigate(`/sales/orders/${so.id}`)} className="text-blue-700 hover:underline text-xs sm:text-sm font-semibold whitespace-nowrap">{so.so_no}</button>
                    ) : (
                      <span className="text-slate-700 text-xs sm:text-sm font-semibold whitespace-nowrap">{so.so_no}</span>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap ml-8 sm:ml-0">
            {canEdit('Customer PO') && isDraft && (
              <button onClick={() => navigate(`/sales/customer-po/${id}/edit`)} title="Edit" aria-label="Edit" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-medium"><Edit3 size={16} /> Edit</button>
            )}
            {canEdit('Customer PO') && isDraft && (
              <button onClick={handleReprice} disabled={repricing} title="Refresh line rates from the current price list" aria-label="Re-price" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-medium disabled:opacity-50"><RefreshCw size={16} className={repricing ? 'animate-spin' : ''} /> {repricing ? 'Re-pricing…' : 'Re-price'}</button>
            )}
            {isDraft && canConfirm('Customer PO') && (
              <button onClick={handleConfirm} title="Confirm" aria-label="Confirm" className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-xs sm:text-sm font-medium"><CheckCircle size={16} /> Confirm</button>
            )}
            {/* Cancel = reject. Only available while the PO is still
                in DRAFT — once the user has explicitly Confirmed the
                PO, Cancel disappears so a confirmed contract can't be
                back-cancelled from the detail page. (To unwind a
                confirmed PO, cancel the downstream SO instead.) */}
            {canReject('Customer PO') && isDraft && (
              <button onClick={handleCancel} title="Cancel PO" aria-label="Cancel PO" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-amber-300 rounded-lg text-amber-700 hover:bg-amber-50 text-xs sm:text-sm font-medium"><XCircle size={16} /> Cancel</button>
            )}
            {/* Create SO suppressed entirely when the PO is cancelled —
                a cancelled PO is ineligible to back an SO regardless
                of permission. */}
            {canCreateSOPerm && !hasLinkedSO && !isCancelled && (
              <button onClick={() => {
                if (!isConfirmed) { toast.error('Customer PO must be confirmed before creating a Sales Order. Please confirm the PO first.'); return; }
                navigate(`/sales/orders/new?cpo_id=${id}&company=${po.company}&customer=${po.customer}`);
              }} title="Create SO" aria-label="Create SO" className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium ${isConfirmed ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-blue-100 text-blue-600 hover:bg-blue-200'}`}><ShoppingCart size={16} /> Create SO</button>
            )}
            {/* "SO Created" + the SO link now live up in the status row. */}
            {canDelete('Customer PO') && (isDraft || isCancelled) && (
              <button onClick={handleDelete} title="Delete" aria-label="Delete" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 text-xs sm:text-sm font-medium"><Trash2 size={16} /> Delete</button>
            )}
          </div>
        </div>

        {/* Cancelled banner — surfaces the rejected state prominently
            so a glance at the page makes it clear the PO is locked
            and ineligible to back a Sales Order. */}
        {isCancelled && (
          <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
            <XCircle size={20} className="text-red-600 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold text-red-800">This Customer PO has been cancelled.</p>
              <p className="text-red-700 mt-0.5">
                It can no longer be edited, confirmed, or used to create a Sales Order. You can still delete the record if you no longer need it.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-3 sm:space-y-6">
            {/* Order Details */}
            <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
              <h2 className="text-sm sm:text-lg font-semibold text-slate-900 mb-3 sm:mb-5 pb-1.5 sm:pb-2 border-b">Order Details</h2>
              <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2 sm:gap-5">
                <Info label="PO No">{po.upload_id}</Info>
                <Info label="PO Date">{fmtDate(po.po_date)}</Info>
                <Info label="Company">{po.company_name || '-'}</Info>
                <Info label="Currency">{po.currency || 'INR'}</Info>
                {/* Customer spans the full row so the long name doesn't wrap. */}
                <Info label="Customer" className="col-span-2 md:col-span-3">{po.customer_name || '-'}</Info>
                <Info label="Price List">{po.price_list_name || '-'}</Info>
                <Info label="Customer PO Number">{po.po_number || '-'}</Info>
                <Info label="Delivery Terms">{termLabel(po.delivery_type)}</Info>
                <Info label="Payment Terms">{termLabel(po.payment_terms)}</Info>
              </div>
            </div>

            {/* Shipping & Reference */}
            <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
              <h2 className="text-sm sm:text-lg font-semibold text-slate-900 mb-3 sm:mb-5 pb-1.5 sm:pb-2 border-b">Shipping & Reference</h2>
              <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2 sm:gap-5">
                <Info label="Required Ship Date">{fmtDate(po.required_ship_date)}</Info>
                <Info label="Delivery Due Date">{fmtDate(po.delivery_due_date)}</Info>
                <Info label="Dispatched Through">{po.dispatched_through || '-'}</Info>
                <Info label="Destination">{po.destination || '-'}</Info>
              </div>
            </div>

            {/* Consignee & Billing */}
            <ConsigneeBilling
              consignee={{ name: po.consignee_name, gstin: po.consignee_gstin, address: po.consignee_address }}
              billing={{ name: po.billing_name, gstin: po.billing_gstin, address: po.billing_address }}
            />

            {/* Product Lines */}
            <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
              <h2 className="text-sm sm:text-lg font-semibold text-slate-900 mb-3 sm:mb-5 pb-1.5 sm:pb-2 border-b">Product Lines ({lines.length})</h2>
              {lines.length === 0 ? (
                <p className="text-slate-500 text-center py-4 sm:py-6">No line items</p>
              ) : (
                <>
                  {/* Mobile-only line cards. The wide 14-column table
                      below works on tablets+ but is painful on a phone
                      — horizontal-scrolling a finance table is the
                      worst UX for accurate reading. The cards below
                      surface the same data, vertically stacked, one
                      line per card with totals at the bottom. Desktop
                      table stays untouched. */}
                  <div className="sm:hidden space-y-3">
                    {lines.map((l, i) => {
                      const amt = (Number(l.quantity) || 0) * (Number(l.price) || 0);
                      const netAmt = Number(l.line_total) || 0;
                      const hasDiscount = Number(l.discount) > 0;
                      const hasSgst = Number(l.sgst_percent) > 0;
                      const hasCgst = Number(l.cgst_percent) > 0;
                      const hasIgst = Number(l.igst_percent) > 0;
                      return (
                        <div key={i} className="border border-slate-200 rounded-lg overflow-hidden">
                          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs text-slate-400">Line #{i + 1}</p>
                              <p className="text-sm font-semibold text-slate-800 break-words">{l.product_name || '-'}</p>
                              {l.product_sku && (
                                <p className="text-[11px] text-slate-500 mt-0.5">{l.product_sku}</p>
                              )}
                            </div>
                            <p className="shrink-0 text-base font-bold text-slate-900 whitespace-nowrap">
                              {netAmt > 0 ? fmt(netAmt) : '-'}
                            </p>
                          </div>
                          <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                            {l.product_category && (
                              <div className="col-span-2">
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Category</span>
                                <p className="text-slate-700">{catLabel(l.product_category)}</p>
                              </div>
                            )}
                            {l.item_code && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Item Code</span>
                                <p className="text-slate-700 break-all">{l.item_code}</p>
                              </div>
                            )}
                            {l.hsn_code && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">HSN</span>
                                <p className="text-slate-700">{l.hsn_code}</p>
                              </div>
                            )}
                            <div>
                              <span className="text-slate-400 uppercase tracking-wide text-[10px]">Qty</span>
                              <p className="text-slate-800 font-medium">{fmtQty(l.quantity)} {l.uom || ''}</p>
                            </div>
                            <div>
                              <span className="text-slate-400 uppercase tracking-wide text-[10px]">Rate</span>
                              <p className="text-slate-800">{fmt(l.price)}</p>
                            </div>
                            {amt > 0 && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Amount</span>
                                <p className="text-slate-700">{fmt(amt)}</p>
                              </div>
                            )}
                            {hasDiscount && (
                              <div>
                                <span className="text-slate-400 uppercase tracking-wide text-[10px]">Discount</span>
                                <p className="text-red-600">{fmt(l.discount)}</p>
                              </div>
                            )}
                            {(hasSgst || hasCgst || hasIgst) && (
                              <div className="col-span-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
                                {hasSgst && <span>SGST {l.sgst_percent}%</span>}
                                {hasCgst && <span>CGST {l.cgst_percent}%</span>}
                                {hasIgst && <span>IGST {l.igst_percent}%</span>}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {/* Mobile totals strip — matches the tfoot on the
                        desktop table, but stacked vertically so each
                        figure has enough room to read without a
                        magnifying glass. */}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
                      <div className="flex justify-between"><span className="text-slate-500">Total Qty</span><span className="font-medium text-slate-800">{fmtQty(totalQty)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Total Discount</span><span className="font-medium text-red-600">{fmt(totalDiscount)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Total SGST</span><span className="font-medium text-slate-700">{fmt(totalSGST)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Total CGST</span><span className="font-medium text-slate-700">{fmt(totalCGST)}</span></div>
                      <div className="flex justify-between pt-2 mt-1 border-t border-slate-300">
                        <span className="text-slate-700 font-semibold">Grand Total</span>
                        <span className="text-base font-bold text-slate-900">{fmt(grandTotal)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Desktop / tablet table — original markup, hidden on
                      mobile. Kept verbatim so any future column tweak
                      only needs to be made in one place. */}
                  <div className="hidden sm:block overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                  <table className="w-full text-xs sm:text-sm">
                    <thead><tr className="border-b">
                      <th className="text-left py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">#</th>
                      <th className="text-left py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Category</th>
                      <th className="text-left py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Product</th>
                      <th className="text-left py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Item Code</th>
                      <th className="text-left py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">HSN</th>
                      <th className="text-left py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">UOM</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Qty</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Rate</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Amount</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Disc.</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">SGST %</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">CGST %</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">IGST %</th>
                      <th className="text-right py-2 px-2 sm:px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Net Amt</th>
                    </tr></thead>
                    <tbody>{lines.map((l, i) => {
                      const amt = (Number(l.quantity) || 0) * (Number(l.price) || 0);
                      const netAmt = Number(l.line_total) || 0;
                      return (
                        <tr key={i} className="border-b hover:bg-primary-50/40 transition-colors">
                          <td className="py-2 px-2 text-slate-500">{i + 1}</td>
                          <td className="py-2 px-2 text-xs whitespace-nowrap text-slate-700">{catLabel(l.product_category)}</td>
                          <td className="py-2 px-2 min-w-[220px]">
                            <p className="font-medium text-slate-800 whitespace-nowrap">{l.product_name || '-'}</p>
                            {l.product_sku && <p className="text-xs text-slate-400 mt-0.5">{l.product_sku}</p>}
                          </td>
                          <td className="py-2 px-2 text-slate-600 text-xs">{l.item_code || '-'}</td>
                          <td className="py-2 px-2 text-slate-600 text-xs">{l.hsn_code || '-'}</td>
                          <td className="py-2 px-2">{l.uom || '-'}</td>
                          <td className="py-2 px-2 text-right font-medium">{fmtQty(l.quantity)}</td>
                          <td className="py-2 px-2 text-right">{fmt(l.price)}</td>
                          <td className="py-2 px-2 text-right text-slate-600">{amt > 0 ? fmt(amt) : '-'}</td>
                          <td className="py-2 px-2 text-right text-red-600">{Number(l.discount) > 0 ? fmt(l.discount) : '-'}</td>
                          <td className="py-2 px-2 text-right text-xs">{Number(l.sgst_percent) > 0 ? `${l.sgst_percent}%` : '-'}</td>
                          <td className="py-2 px-2 text-right text-xs">{Number(l.cgst_percent) > 0 ? `${l.cgst_percent}%` : '-'}</td>
                          <td className="py-2 px-2 text-right text-xs">{Number(l.igst_percent) > 0 ? `${l.igst_percent}%` : '-'}</td>
                          <td className="py-2 px-2 text-right font-semibold">{netAmt > 0 ? fmt(netAmt) : '-'}</td>
                        </tr>
                      );
                    })}</tbody>
                    <tfoot>
                      <tr className="bg-slate-50 font-semibold border-t-2">
                        <td colSpan="6" className="py-2 px-2 text-right text-slate-600">Totals:</td>
                        <td className="py-2 px-2 text-right">{fmtQty(totalQty)}</td>
                        <td></td>
                        <td className="py-2 px-2 text-right">{fmt(lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.price) || 0), 0))}</td>
                        <td className="py-2 px-2 text-right text-red-600">{fmt(totalDiscount)}</td>
                        <td className="py-2 px-2 text-right text-xs">{fmt(totalSGST)}</td>
                        <td className="py-2 px-2 text-right text-xs">{fmt(totalCGST)}</td>
                        <td></td>
                        <td className="py-2 px-2 text-right text-base">{fmt(grandTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                  </div>
                </>
              )}
            </div>

            {/* Special Instructions & Remarks */}
            {(po.special_instructions || po.remarks) && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
                <h2 className="text-lg sm:text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">Additional Information</h2>
                <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
                  {po.special_instructions && (
                    <div><p className="text-xs text-slate-500 uppercase font-medium">Special Instructions</p>
                      <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap">{po.special_instructions}</p></div>
                  )}
                  {po.remarks && (
                    <div><p className="text-xs text-slate-500 uppercase font-medium">Remarks</p>
                      <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap">{po.remarks}</p></div>
                  )}
                </div>
              </div>
            )}
          </div>

        {/* Attachments last — full-width at the bottom of the page. */}
        <FileAttachments module="CUSTOMER_PO" recordId={id} readOnly />
      </div>
    </MainLayout>
  );
}
