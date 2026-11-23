import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { formatCurrency } from '@/utils/formatters';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const emptyDCLink = { dc: '', invoice_no: '', destination: '', products: [] };

export default function EditOutwardFreight() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { options: transporterOptions } = useLookup('/api/transporters/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [allDCs, setAllDCs] = useState([]);

  // Freight Details for auto-fill
  const [freightDetailOptions, setFreightDetailOptions] = useState([]);
  const [selectedFreightDetail, setSelectedFreightDetail] = useState('');

  const [formData, setFormData] = useState({
    advice_no: '',
    freight_detail: '',
    transporter: '',
    freight_date: '',
    invoice_date: '',
    customer_name: '',
    lorry_no: '',
    destination: '',
    base_amount: '',
    remarks: '',
  });
  const [dcLinks, setDcLinks] = useState([{ ...emptyDCLink }]);

  useEffect(() => {
    apiClient.get('/api/sales/dc/', { params: { page_size: 500 } })
      .then(r => setAllDCs((r.data?.results || r.data || []).map(d => ({ value: d.id, label: d.dc_no }))))
      .catch(() => {});

    // Fetch freight details for the dropdown (include already-linked ones since we're editing)
    Promise.all([
      apiClient.get('/api/sales/freight-details/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/freight/', { params: { page_size: 500 } }),
    ]).then(([fdRes, fRes]) => {
      const fdList = fdRes.data?.results || fdRes.data || [];
      const freightList = fRes.data?.results || fRes.data || [];
      // Get all freight_detail IDs already linked to an outward freight (except current record)
      const linkedFDIds = new Set(freightList.filter(f => f.freight_detail && String(f.id) !== String(id)).map(f => f.freight_detail));
      setFreightDetailOptions(
        fdList.filter(f => f.status !== 'CANCELLED' && !linkedFDIds.has(f.id)).map(f => ({
          value: f.id, label: `${f.freight_no} - ${f.customer_name || ''} (${f.lorry_no || ''})`,
        }))
      );
    }).catch(() => {});

    const fetchFreight = async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/sales/freight/${id}/`);
        const f = res.data;
        setFormData({
          advice_no: f.advice_no || '',
          freight_detail: f.freight_detail || '',
          transporter: f.transporter || '',
          freight_date: f.freight_date || '',
          invoice_date: f.invoice_date || '',
          customer_name: f.customer_name || '',
          lorry_no: f.lorry_no || '',
          destination: f.destination || '',
          base_amount: f.base_amount || '',
          remarks: f.remarks || '',
        });
        setSelectedFreightDetail(f.freight_detail || '');
        const links = (f.dc_links || []).map(l => ({ dc: l.dc, invoice_no: l.invoice_no || '', destination: l.destination || '', products: [] }));
        const resolvedLinks = links.length > 0 ? links : [{ ...emptyDCLink }];
        setDcLinks(resolvedLinks);
        // Fetch product lines for each DC link
        resolvedLinks.forEach(async (link, idx) => {
          if (!link.dc) return;
          try {
            const dcRes = await apiClient.get(`/api/sales/dc/${link.dc}/`);
            const prods = (dcRes.data?.dc_lines || []).map(l => ({
              name: l.product_name || l.product_sku || '',
              qty: l.quantity_dispatched || 0,
              uom: l.uom || '',
            }));
            setDcLinks(prev => prev.map((l, i) => i === idx ? { ...l, products: prods } : l));
          } catch { /* ignore */ }
        });
      } catch { toast.error('Failed to load'); navigate('/sales/freight'); }
      finally { setIsLoading(false); }
    };
    fetchFreight();
  }, [id]);

  // When Freight Detail is selected, auto-fill from FreightDetail
  const handleFreightDetailSelect = async (fdId) => {
    setSelectedFreightDetail(fdId);
    setFormData(prev => ({ ...prev, freight_detail: fdId }));
    if (!fdId) return;
    try {
      const res = await apiClient.get(`/api/sales/freight-details/${fdId}/`);
      const fd = res.data;
      setFormData(prev => ({
        ...prev,
        freight_detail: fdId,
        transporter: fd.transporter || '',
        freight_date: fd.freight_date || prev.freight_date,
        customer_name: fd.customer_name_display || '',
        lorry_no: fd.lorry_no || '',
        destination: fd.destination || '',
        base_amount: fd.total_freight || '',
        remarks: fd.remarks || '',
      }));
      // Auto-fill DC links from freight detail and fetch product lines
      const links = (fd.dc_links || []).map(l => ({ dc: l.dc, invoice_no: l.invoice_no || '', destination: l.destination || '', products: [] }));
      if (links.length > 0) {
        setDcLinks(links);
        links.forEach(async (link, idx) => {
          if (!link.dc) return;
          try {
            const dcRes = await apiClient.get(`/api/sales/dc/${link.dc}/`);
            const prods = (dcRes.data?.dc_lines || []).map(l => ({
              name: l.product_name || l.product_sku || '',
              qty: l.quantity_dispatched || 0,
              uom: l.uom || '',
            }));
            setDcLinks(prev => prev.map((l, i) => i === idx ? { ...l, products: prods } : l));
          } catch { /* ignore */ }
        });
      }
      toast.success('Freight details auto-filled!');
    } catch {
      toast.error('Failed to load freight detail');
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'freight_detail') return handleFreightDetailSelect(value);
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleDCLinkChange = async (idx, field, value) => {
    setDcLinks(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
    if (field === 'dc' && value) {
      try {
        const res = await apiClient.get(`/api/sales/dc/${value}/`);
        const lines = (res.data?.dc_lines || []).map(l => ({
          name: l.product_name || l.product_sku || '',
          qty: l.quantity_dispatched || 0,
          uom: l.uom || '',
        }));
        setDcLinks(prev => prev.map((l, i) => i === idx ? { ...l, products: lines } : l));
      } catch { /* ignore */ }
    }
    if (field === 'dc' && !value) {
      setDcLinks(prev => prev.map((l, i) => i === idx ? { ...l, products: [] } : l));
    }
  };
  const addDCLink = () => setDcLinks(prev => [...prev, { ...emptyDCLink }]);
  const removeDCLink = (idx) => { if (dcLinks.length > 1) setDcLinks(prev => prev.filter((_, i) => i !== idx)); };

  // Calculations
  const baseAmt = parseFloat(formData.base_amount) || 0;
  const payableAmount = baseAmt;
  const fmt = (v) => formatCurrency(v);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.base_amount || parseFloat(formData.base_amount) <= 0) { toast.error('Freight Value must be > 0.'); return; }

    setIsSaving(true);
    try {
      await apiClient.put(`/api/sales/freight/${id}/`, {
        freight_detail: formData.freight_detail || null,
        transporter: formData.transporter || null,
        freight_type: 'LINEHAUL',
        freight_date: formData.freight_date || null,
        invoice_date: formData.invoice_date || null,
        customer_name: formData.customer_name || '',
        lorry_no: formData.lorry_no || '',
        destination: formData.destination || '',
        base_amount: formData.base_amount || 0,
        remarks: formData.remarks || '',
        dc_links: dcLinks.filter(l => l.dc).map(l => ({
          dc: l.dc, invoice_no: l.invoice_no || '', destination: l.destination || '',
        })),
      });
      toast.success('Freight updated!');
      if (pendingAttachments.length > 0) { await uploadPendingFiles('FREIGHT', id, pendingAttachments); }
      navigate(`/sales/freight/${id}`);
    } catch (error) { toast.error(getApiErrorMessage(error)); }
    finally { setIsSaving(false); }
  };

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;

  return (
    <MainLayout>
      <PageHeader title={`Edit Freight - ${formData.advice_no}`} breadcrumbs={[
        { label: 'Sales', path: '/sales' }, { label: 'Outward Freight', path: '/sales/freight' },
        { label: formData.advice_no, path: `/sales/freight/${id}` }, { label: 'Edit' },
      ]} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6" noValidate>

          {/* Section 1: Basic Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Basic Details</h3>
            {/* Freight Detail Selection */}
            <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <label className="block text-sm font-medium text-blue-800 mb-1">Select Freight Detail (auto-fills all fields)</label>
              <CustomSelect name="freight_detail" value={selectedFreightDetail} onChange={handleChange} className={`${inputClass} border-blue-300`}>
                <option value="">-- Select Freight No to auto-fill (or edit manually) --</option>
                {freightDetailOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Outward Freight No</label>
                <input type="text" value={formData.advice_no} readOnly className={`${inputClass} bg-slate-50 text-slate-600 font-medium`} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="freight_date" value={formData.freight_date} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer Name</label>
                <input type="text" name="customer_name" value={formData.customer_name} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Transporter</label>
                <CustomSelect name="transporter" value={formData.transporter} onChange={handleChange} className={inputClass}>
                  <option value="">Select Transporter</option>
                  {transporterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Invoice Date</label>
                <CustomDatePicker name="invoice_date" value={formData.invoice_date} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Lorry No</label>
                <input type="text" name="lorry_no" value={formData.lorry_no} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Destination</label>
                <input type="text" name="destination" value={formData.destination} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Section 2: DC Links */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">DC Mapping</h3>
              <button type="button" onClick={addDCLink} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add DC
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">DC No</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Product Name</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Quantity</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Invoice No</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Destination</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {dcLinks.map((link, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="px-3 py-2">
                        <CustomSelect value={link.dc} onChange={(e) => handleDCLinkChange(idx, 'dc', e.target.value)} className={inputClass} style={{ minWidth: '160px' }}>
                          <option value="">Select DC</option>
                          {allDCs.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-700" style={{ minWidth: '160px' }}>
                        {(link.products || []).length > 0
                          ? link.products.map((p, pi) => <div key={pi}>{p.name}</div>)
                          : <span className="text-slate-400">-</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-700" style={{ minWidth: '100px' }}>
                        {(link.products || []).length > 0
                          ? link.products.map((p, pi) => <div key={pi}>{p.qty} {p.uom}</div>)
                          : <span className="text-slate-400">-</span>}
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={link.invoice_no} onChange={(e) => handleDCLinkChange(idx, 'invoice_no', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={link.destination} onChange={(e) => handleDCLinkChange(idx, 'destination', e.target.value)} className={inputClass} style={{ minWidth: '140px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeDCLink(idx)} disabled={dcLinks.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30"><Trash2 size={16} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 3: Freight Value & Additional Costs */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Freight Value & Costs</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Value (Base) <span className="text-red-500">*</span></label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                  <input type="number" step="0.01" min="0" name="base_amount" value={formData.base_amount} onChange={handleChange} className={`${inputClass} pl-7`} placeholder="0.00" />
                </div>
              </div>
            </div>
            {/* Payable Summary */}
            <div className="mt-4 p-4 bg-slate-50 rounded-lg border">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-slate-600">Total Payable Amount</span>
                <span className="text-xl font-bold text-slate-900">{fmt(payableAmount)}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Base ({fmt(baseAmt)})
              </div>
            </div>
          </div>

          {/* Remarks */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Remarks</h3>
            <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} className={inputClass} placeholder="Any additional notes..." />
          </div>

          {/* Note about payments */}
          <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 text-sm text-blue-800">
            Payments can be added after creating the freight record. You can make partial payments from the detail page.
          </div>

          <FileAttachments module="FREIGHT" recordId={id} deferUpload onPendingChange={setPendingAttachments} />

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(`/sales/freight/${id}`)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isSaving} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Update'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
