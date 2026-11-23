import { confirm } from '@/components/common/confirm';
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft, CheckCircle, Edit3, Trash2, FileText, Truck,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import FileAttachments from '../components/FileAttachments';
import ActivityLog from '@/components/common/ActivityLog';
import { parseAddress } from '../../../components/common/AddressField';
import ConsigneeBilling from '../../../components/common/ConsigneeBilling';
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

export default function DispatchChallanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const backTo = location.state?.backTo || '/sales/dc';
  const { canEdit, canDelete, canView, canCreateFreight, canIssue, canConfirm } = usePermissions();
  // Cross-module nav gates for linked-document buttons.
  const canSeeCPO = canView('Customer PO');
  const canSeeSO = canView('Sales Order');
  // Orange "Create Freight" header button — gated by can_create_freight
  // on the Dispatch Challan row in the admin grid.
  const canSeeFreightBtn = canCreateFreight('Dispatch Challan');

  const [dc, setDC] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isReleasing, setIsReleasing] = useState(false);
  const [isDelivering, setIsDelivering] = useState(false);

  useEffect(() => { fetchDC(); }, [id]);

  const fetchDC = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/sales/dc/${id}/`);
      setDC(res.data);
    } catch (err) {
      if (err.response?.status !== 404) toast.error('Failed to load Dispatch Challan');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete Dispatch Challan ${dc.dc_no}? This cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/dc/${id}/`);
      toast.success(`DC ${dc.dc_no} deleted`);
      navigate('/sales/dc');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const handleRelease = async () => {
    if (!(await confirm({ message: 'Release this Dispatch Challan for shipment?' }))) return;
    setIsReleasing(true);
    try {
      await apiClient.post(`/api/sales/dc/${id}/release/`);
      toast.success('Dispatch Challan released!');
      fetchDC();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to release');
    } finally {
      setIsReleasing(false);
    }
  };

  const handleDelivered = async () => {
    if (!(await confirm({ message: 'Mark this Dispatch Challan as delivered?' }))) return;
    setIsDelivering(true);
    try {
      await apiClient.post(`/api/sales/dc/${id}/mark_delivered/`);
      toast.success('Marked as delivered!');
      fetchDC();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to mark delivered');
    } finally {
      setIsDelivering(false);
    }
  };

  const formatDate = (d) => {
    if (!d) return '-';
    return formatDateUtil(d);
  };

  const fmt = (v) => {
    const n = Number(v);
    return isNaN(n) ? '-' : formatCurrency(n);
  };

  const fmtQty = (v) => {
    const n = Number(v);
    return isNaN(n) ? '-' : n.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
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

  const freightTermsLabel = (val) => {
    const map = { 'PAID': 'Paid', 'TO_PAY': 'To Pay' };
    return map[val] || val || '-';
  };

  const paymentTermsLabel = (val) => {
    const map = { 'NET_15': 'Net 15', 'NET_30': 'Net 30', 'NET_45': 'Net 45' };
    return map[val] || val || '-';
  };

  const deliveryTermsLabel = (val) => {
    const map = { 'EX_WORKS': 'Ex Works', 'FOR': 'FOR', 'CIF': 'CIF', 'FOB': 'FOB', 'DOOR_DELIVERY': 'Door Delivery' };
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

  if (!dc) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <FileText className="mx-auto text-slate-300 mb-4" size={48} />
          <p className="text-slate-600 text-lg">Dispatch Challan not found</p>
          <button onClick={() => navigate(backTo, { replace: true })} className="mt-4 px-4 py-2 text-blue-600 hover:text-blue-800">
            Back to Dispatch Challans
          </button>
        </div>
      </MainLayout>
    );
  }

  const dcStatus = dc.status || 'DRAFT';
  const isDraft = dcStatus === 'DRAFT';
  const isReleased = dcStatus === 'RELEASED';
  const lines = dc.dc_lines || [];
  const hasEditPerm = canEdit('Dispatch Challan');
  const hasDeletePerm = canDelete('Dispatch Challan');

  const totalQty = lines.reduce((s, l) => s + (Number(l.quantity_dispatched) || 0), 0);

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
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/dc'))} className="p-1 text-slate-500 hover:text-slate-700" title="Back">
                <ArrowLeft size={20} />
              </button>
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 break-all">{dc.dc_no}</h1>
            </div>
            <div className="flex items-center gap-3 ml-8">
              <StatusBadge status={dcStatus} />
              <p className="text-slate-500 text-xs sm:text-sm whitespace-nowrap">Dispatched on {formatDate(dc.dispatch_date)}</p>
              <div className="flex items-center gap-2 ml-auto">
                {(dc.customer_po_numbers || []).map((po, i) => {
                  const isObj = po && typeof po === 'object';
                  const label = isObj ? po.upload_id : po;
                  const cpoId = isObj ? po.id : null;
                  return cpoId && canSeeCPO ? (
                    <button key={i} onClick={() => navigate(`/sales/customer-po/${cpoId}`)} className="text-blue-700 hover:underline text-xs sm:text-sm font-semibold whitespace-nowrap max-w-[120px] truncate">{label}</button>
                  ) : (
                    <span key={i} className="text-slate-600 text-xs sm:text-sm font-semibold whitespace-nowrap">{label}</span>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 flex-wrap ml-8 sm:ml-0">
            {/* Hide "Create Freight" on Ex-Factory DCs — the customer
                collects at the gate, we never bill freight on those.
                Without this gate the user could create an outward
                freight against a DC that should never have one. */}
            {canSeeFreightBtn && ['RELEASED', 'DELIVERED'].includes(dcStatus) && !dc.has_freight && dc.delivery_terms !== 'EX_FACTORY' && (
              <button onClick={() => navigate(`/freight/outward/new?dc_id=${id}`)} title="Create Freight" aria-label="Create Freight" className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-xs sm:text-sm font-medium">
                <Truck size={16} /> Create Freight
              </button>
            )}
            {['RELEASED', 'DELIVERED'].includes(dcStatus) && !dc.has_freight && dc.delivery_terms === 'EX_FACTORY' && (
              <span
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs font-medium"
                title="Ex-Factory delivery — customer collects at the gate. We don't bill freight on this DC."
              >
                Ex-Factory · no freight
              </span>
            )}
            {dc.has_freight && (dc.linked_freights || []).map(lf => (
              <button key={lf.id} onClick={() => navigate(`/freight/sales/${lf.id}`)} title={`View Freight ${lf.advice_no}`} aria-label={`View Freight ${lf.advice_no}`}
                className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-xs sm:text-sm font-medium">
                <Truck size={16} /> View Freight {lf.advice_no}
              </button>
            ))}
            {/* Edit/Delete only while the DC is still DRAFT (sales-module
                post-approval lock). Once it has been RELEASED the stock
                ledger has fired and the document is read-only. */}
            {hasEditPerm && isDraft && (
              <button onClick={() => navigate(`/sales/dc/${id}/edit`)} title="Edit" aria-label="Edit" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-medium">
                <Edit3 size={16} /> Edit
              </button>
            )}
            {hasDeletePerm && isDraft && (
              <button onClick={handleDelete} title="Delete" aria-label="Delete" className="flex items-center gap-2 px-2 sm:px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 text-xs sm:text-sm font-medium">
                <Trash2 size={16} /> Delete
              </button>
            )}
            {isDraft && canIssue('Dispatch Challan') && (
              <button onClick={handleRelease} disabled={isReleasing} title="Release for Dispatch" aria-label="Release for Dispatch" className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs sm:text-sm font-medium disabled:opacity-50">
                <Truck size={16} /> {isReleasing ? 'Releasing...' : 'Release for Dispatch'}
              </button>
            )}
            {isReleased && canConfirm('Dispatch Challan') && (
              <button onClick={handleDelivered} disabled={isDelivering} title="Mark Delivered" aria-label="Mark Delivered" className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-xs sm:text-sm font-medium disabled:opacity-50">
                <CheckCircle size={16} /> {isDelivering ? 'Updating...' : 'Mark Delivered'}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-4 sm:space-y-6">
          {/* Dispatch Details */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Dispatch Details</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2.5 sm:gap-5">
              <InfoField label="Sales Order">
                {dc.linked_so_no ? (
                  canSeeSO ? (
                    <button
                      onClick={() => navigate(`/sales/orders/${dc.linked_so_id}`)}
                      className="text-blue-700 hover:text-blue-900 hover:underline font-semibold"
                    >
                      {dc.linked_so_no}
                    </button>
                  ) : (
                    <span className="text-slate-700 font-semibold">{dc.linked_so_no}</span>
                  )
                ) : '-'}
              </InfoField>
              <InfoField label="SO Date">{formatDate(dc.so_date)}</InfoField>
              <InfoField label="Company">{dc.company_name || '-'}</InfoField>
              <InfoField label="Customer">{dc.customer_name || '-'}</InfoField>
              <InfoField label="Warehouse">{dc.warehouse_name || '-'}</InfoField>
            </div>
          </div>

          {/* Terms & Currency */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Terms & Currency</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2.5 sm:gap-5">
              <InfoField label="Freight Terms">{freightTermsLabel(dc.freight_terms)}</InfoField>
              <InfoField label="Freight Type">{dc.freight_type === 'LOCAL' ? 'Local' : dc.freight_type === 'LINEHAUL' ? 'Linehaul' : '-'}</InfoField>
              <InfoField label="Payment Terms">{paymentTermsLabel(dc.payment_terms)}</InfoField>
              <InfoField label="Currency">{dc.currency || '-'}</InfoField>
            </div>
          </div>

          {/* Shipping & Reference */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Shipping & Reference</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2.5 sm:gap-5">
              <InfoField label="Delivery Terms">{deliveryTermsLabel(dc.delivery_terms)}</InfoField>
              <InfoField label="Required Ship Date">{formatDate(dc.required_ship_date)}</InfoField>
              <InfoField label="Delivery Due Date">{formatDate(dc.delivery_due_date)}</InfoField>
              <InfoField label="Destination">{dc.destination || '-'}</InfoField>
              <InfoField label="Dispatched Through">{dc.dispatched_through || '-'}</InfoField>
            </div>
          </div>

          {/* Consignee & Billing */}
          <ConsigneeBilling
            consignee={{ name: dc.consignee_name, gstin: dc.consignee_gstin, address: dc.consignee_address }}
            billing={{ name: dc.billing_name || dc.company_name, gstin: dc.billing_gstin, address: dc.billing_address }}
          />

          {/* Transport Details — for Ex-Factory we hide the
              transporter (none assigned) and instead surface the
              driver name + phone captured at DC create. For
              transporter-backed flows the transporter is shown and
              driver fields are blank by design. */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Transport Details</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2.5 sm:gap-5">
              {dc.delivery_terms === 'EX_FACTORY' ? (
                <>
                  <InfoField label="Driver Name">{dc.driver_name || '-'}</InfoField>
                  <InfoField label="Lorry / Vehicle No">{dc.lorry_no || '-'}</InfoField>
                  <InfoField label="Driver Phone">{dc.driver_contact || '-'}</InfoField>
                </>
              ) : (
                <>
                  <InfoField label="Transporter">{dc.transporter_name || '-'}</InfoField>
                  <InfoField label="Lorry / Vehicle No">{dc.lorry_no || '-'}</InfoField>
                  <InfoField label="Driver Contact">{dc.driver_contact || '-'}</InfoField>
                </>
              )}
              <InfoField label="Destination">{dc.destination || '-'}</InfoField>
            </div>
          </div>

          {/* Freight Details */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Freight Details</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-2.5 sm:gap-5">
              <InfoField label="Freight Rate (Per Unit)">{dc.freight_rate_value ? fmt(dc.freight_rate_value) : '-'}</InfoField>
              <InfoField label="Total Dispatch Qty">{totalQty ? fmtQty(totalQty) : '-'}</InfoField>
              <InfoField label="Freight Amount"><span className="text-lg font-bold text-emerald-700">{dc.freight_amount_total ? fmt(dc.freight_amount_total) : '-'}</span></InfoField>
            </div>
          </div>

          {/* Additional Information */}
          {(dc.special_instructions || dc.so_remarks) && (
            <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Additional Information</h2>
              <div className="grid grid-cols-2 md:grid-cols-2 gap-5">
                {dc.special_instructions && (
                  <InfoField label="Special Instructions">
                    <span className="whitespace-pre-line">{dc.special_instructions}</span>
                  </InfoField>
                )}
                {dc.so_remarks && (
                  <InfoField label="Remarks">
                    <span className="whitespace-pre-line">{dc.so_remarks}</span>
                  </InfoField>
                )}
              </div>
            </div>
          )}

          {/* DC Lines */}
          <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">
              Dispatch Items ({lines.length})
            </h2>
            {lines.length === 0 ? (
              <p className="text-slate-500 text-center py-4 sm:py-6">No items</p>
            ) : (
              <>
                {/* Mobile-only line cards. */}
                <div className="sm:hidden space-y-3">
                  {lines.map((line, idx) => (
                    <div key={line.id || idx} className="border border-slate-200 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs text-slate-400">Line #{idx + 1}</p>
                          <p className="text-sm font-semibold text-slate-800 break-words">{line.product_name || '-'}</p>
                          {line.product_sku && <p className="text-[11px] text-slate-500 mt-0.5">{line.product_sku}</p>}
                        </div>
                        <p className="shrink-0 text-base font-bold text-slate-900 whitespace-nowrap">{fmtQty(line.quantity_dispatched)} {line.uom || ''}</p>
                      </div>
                      <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                        {line.product_category && (
                          <div className="col-span-2">
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">Category</span>
                            <p className="text-slate-700">{categoryLabel(line.product_category)}</p>
                          </div>
                        )}
                        {line.quantity_ordered != null && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">SO Qty</span>
                            <p className="text-slate-700">{fmtQty(line.quantity_ordered)}</p>
                          </div>
                        )}
                        {line.pending_qty != null && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">Balance</span>
                            <p className="text-orange-600 font-medium">{fmtQty(line.pending_qty)}</p>
                          </div>
                        )}
                        {line.warehouse_name && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">Warehouse</span>
                            <p className="text-slate-700">{line.warehouse_name}</p>
                          </div>
                        )}
                        {line.godown_name && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">Godown</span>
                            <p className="text-slate-700">{line.godown_name}</p>
                          </div>
                        )}
                        {line.batch && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">Batch</span>
                            <p className="text-slate-700">{line.batch}</p>
                          </div>
                        )}
                        {line.noa && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">NOA</span>
                            <p className="text-slate-700">{line.noa}</p>
                          </div>
                        )}
                        {line.weight && (
                          <div>
                            <span className="text-slate-400 uppercase tracking-wide text-[10px]">Weight</span>
                            <p className="text-slate-700">{line.weight}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex justify-between text-sm">
                    <span className="text-slate-700 font-semibold">Total Dispatch Qty</span>
                    <span className="text-base font-bold text-blue-700">{fmtQty(totalQty)}</span>
                  </div>
                </div>

                <div className="hidden sm:block overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">#</th>
                      <th className="text-left px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Category</th>
                      <th className="text-left px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Product</th>
                      <th className="text-right px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">SO Qty</th>
                      <th className="text-right px-2 sm:px-3 py-2 font-medium text-slate-600 text-orange-600 whitespace-nowrap">Balance to Dispatch</th>
                      <th className="text-right px-2 sm:px-3 py-2 font-medium text-slate-600 text-blue-700 whitespace-nowrap">Qty Dispatched</th>
                      <th className="text-left px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">UOM</th>
                      <th className="text-left px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Warehouse</th>
                      <th className="text-left px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Godown</th>
                      <th className="text-left px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Batch</th>
                      <th className="text-right px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">NOA</th>
                      <th className="text-right px-2 sm:px-3 py-2 font-medium text-slate-600 whitespace-nowrap">Weight</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {lines.map((line, idx) => (
                      <tr key={line.id || idx} className="hover:bg-primary-50/40 transition-colors">
                        <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                        <td className="px-3 py-2 text-slate-600 text-xs">{categoryLabel(line.product_category)}</td>
                        <td className="px-3 py-2">
                          <p className="font-medium text-slate-800">{line.product_name || '-'}</p>
                          {line.product_sku && <p className="text-xs text-slate-400">{line.product_sku}</p>}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-500 font-medium">{line.quantity_ordered ? fmtQty(line.quantity_ordered) : '-'}</td>
                        <td className="px-3 py-2 text-right font-semibold text-orange-600">{line.pending_qty ? fmtQty(line.pending_qty) : '-'}</td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-800">{fmtQty(line.quantity_dispatched)}</td>
                        <td className="px-3 py-2 text-slate-600">{line.uom || '-'}</td>
                        <td className="px-3 py-2 text-slate-600">{line.warehouse_name || '-'}</td>
                        <td className="px-3 py-2 text-slate-600">{line.godown_name || '-'}</td>
                        <td className="px-3 py-2 text-slate-500">{line.batch || '-'}</td>
                        <td className="px-3 py-2 text-right text-slate-600">{line.noa || '-'}</td>
                        <td className="px-3 py-2 text-right text-slate-600">{line.weight || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                      <td colSpan="5" className="px-3 py-2 text-right text-slate-600">Total Dispatch Qty:</td>
                      <td className="px-3 py-2 text-right text-blue-700">{fmtQty(totalQty)}</td>
                      <td colSpan="6"></td>
                    </tr>
                  </tfoot>
                </table>
                </div>
              </>
            )}
          </div>

          <FileAttachments module="DISPATCH_CHALLAN" recordId={id} readOnly />

          <div className="mt-4">
            <ActivityLog module="Dispatch Challan" recordId={id} />
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
