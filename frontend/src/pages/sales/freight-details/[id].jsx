import { confirm } from '@/components/common/confirm';
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Edit3, Trash2, FileText } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments from '../components/FileAttachments';
import { formatCurrency, formatDate } from '@/utils/formatters';

export default function FreightDetailView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Freight');
  const [fd, setFD] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    apiClient.get(`/api/sales/freight-details/${id}/`).then(r => setFD(r.data))
      .catch((err) => { if (err.response?.status !== 404) toast.error('Failed to load'); }).finally(() => setIsLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete ${fd.freight_no}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try { await apiClient.delete(`/api/sales/freight-details/${id}/`); toast.success('Deleted'); navigate('/sales/freight-details'); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
  };

  const fmt = (v) => formatCurrency(v);
  const fmtDate = (d) => d ? formatDate(d) : '-';
  const Info = ({ label, children }) => (<div><p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p><p className="text-slate-900 font-semibold mt-1">{children}</p></div>);

  if (isLoading) return <MainLayout><div className="space-y-4">{[1,2,3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;
  if (!fd) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Freight detail not found.</p>
        <button onClick={() => navigate('/sales/freight-details')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Freight Details
        </button>
      </div>
    </MainLayout>
  );

  const dcLinks = fd.dc_links || [];

  return (
    <MainLayout>
      <div className="max-w-6xl space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/freight-details'))} className="p-1 text-slate-500 hover:text-slate-700"><ArrowLeft size={20} /></button>
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900">{fd.freight_no}</h1>
            </div>
            <div className="flex items-center gap-4 ml-8"><StatusBadge status={fd.status} /><p className="text-slate-500 text-sm">{fmtDate(fd.freight_date)}</p></div>
          </div>
          <div className="flex items-center gap-3 ml-8 sm:ml-0">
            {/* Edit/Delete only while still PENDING (sales-module
                post-approval rule). */}
            {canEdit('Freight Advice') && fd.status === 'PENDING' && <button onClick={() => navigate(`/sales/freight-details/${id}/edit`)} className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"><Edit3 size={16} /> Edit</button>}
            {canDelete('Freight Advice') && fd.status === 'PENDING' && <button onClick={handleDelete} className="flex items-center gap-2 px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 text-sm font-medium"><Trash2 size={16} /> Delete</button>}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          <div className="lg:col-span-2 space-y-4 sm:space-y-6">
            {/* Freight Details */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">Freight Details</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
                {!isHidden('advice_no') && <Info label="Freight No">{fd.freight_no}</Info>}
                {!isHidden('freight_date') && <Info label="Date">{fmtDate(fd.freight_date)}</Info>}
                {!isHidden('company_name') && <Info label="Company">{fd.company_name || '-'}</Info>}
                {!isHidden('factory_name') && <Info label="Factory">{fd.factory_name || '-'}</Info>}
                {!isHidden('customer_name') && <Info label="Customer">{fd.customer_name_display || '-'}</Info>}
                {!isHidden('transporter_name') && <Info label="Transporter">{fd.transporter_name || '-'}</Info>}
                {!isHidden('lorry_no') && <Info label="Lorry No">{fd.lorry_no || '-'}</Info>}
                {!isHidden('freight_type') && <Info label="Freight Type">{fd.freight_type || '-'}</Info>}
              </div>
            </div>

            {/* DC No */}
            {dcLinks.length > 0 && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">DC No ({dcLinks.length})</h2>
                <table className="w-full text-sm"><thead><tr className="border-b"><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">S No</th><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">DC</th><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Product</th><th className="text-right py-2 px-3 text-xs text-slate-500 uppercase">Quantity</th><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Invoice No</th><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Destination</th></tr></thead>
                  <tbody>{dcLinks.map((l, i) => (<tr key={i} className="border-b hover:bg-primary-50/40 transition-colors"><td className="py-2 px-3 text-slate-500">{i+1}</td><td className="py-2 px-3 font-medium text-blue-700 cursor-pointer" onClick={() => navigate(`/sales/dc/${l.dc}`)}>{l.dc_no}</td><td className="py-2 px-3">{l.product_name || '-'}</td><td className="py-2 px-3 text-right font-medium">{Number(l.quantity || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td><td className="py-2 px-3">{l.invoice_no || '-'}</td><td className="py-2 px-3">{l.destination || '-'}</td></tr>))}</tbody>
                  <tfoot><tr className="bg-slate-50 font-semibold border-t"><td colSpan="3" className="py-2 px-3 text-right">Total:</td><td className="py-2 px-3 text-right font-bold">{dcLinks.reduce((s, l) => s + (Number(l.quantity) || 0), 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td><td colSpan="2"></td></tr></tfoot>
                </table>
              </div>
            )}

            {/* Freight Calculation */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">Freight Calculation</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
                <Info label="Total Quantity">{fd.total_quantity || '0'} {fd.quantity_uom}</Info>
                <Info label="Freight Per Ton">{fmt(fd.freight_per_ton)}</Info>
                <Info label="Discount">{fmt(fd.discount)}</Info>
                <Info label="Additional Freight">{fmt(fd.additional_freight)}</Info>
                <Info label="Less Amount">{fmt(fd.less_amount)}</Info>
                <Info label="TDS Less">{fmt(fd.tds_less)}</Info>
                <Info label="Total Freight">{fmt(fd.total_freight)}</Info>
                <Info label="Freight Paid">{fmt(fd.freight_paid)}</Info>
                <Info label="Balance Freight"><span className={Number(fd.balance_freight) > 0 ? 'text-orange-600' : 'text-green-600'}>{fmt(fd.balance_freight)}</span></Info>
                {!isHidden('destination') && <Info label="Destination">{fd.destination || '-'}</Info>}
                <Info label="Destination State">{fd.destination_state || '-'}</Info>
                {!isHidden('status') && <Info label="Freight Status"><StatusBadge status={fd.status} /></Info>}
              </div>
            </div>

            {/* Additional */}
            {!isHidden('remarks') && fd.remarks && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">Additional</h2>
                <div>
                  <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Remarks</p>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap mt-1">{fd.remarks}</p>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Summary</h3>
              <div className="space-y-4">
                <div><p className="text-xs text-slate-500 uppercase">Status</p><div className="mt-1"><StatusBadge status={fd.status} /></div></div>
                <div><p className="text-xs text-slate-500 uppercase">Total Freight</p><p className="text-2xl font-bold text-slate-900 mt-1">{fmt(fd.total_freight)}</p></div>
                <div><p className="text-xs text-slate-500 uppercase">Paid</p><p className="text-xl font-bold text-green-700 mt-1">{fmt(fd.freight_paid)}</p></div>
                <div><p className="text-xs text-slate-500 uppercase">Balance</p><p className={`text-xl font-bold mt-1 ${Number(fd.balance_freight) > 0 ? 'text-orange-600' : 'text-slate-400'}`}>{fmt(fd.balance_freight)}</p></div>
              </div>
            </div>
          </div>
        </div>

        <FileAttachments module="FREIGHT_DETAIL" recordId={id} readOnly />
      </div>
    </MainLayout>
  );
}
