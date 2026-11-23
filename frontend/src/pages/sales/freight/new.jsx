import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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

const emptyDCLink = { dc: '', invoice_no: '', destination: '', products: [], freight_amount: 0, freight_rate: 0, total_qty: 0, uom: '' };

export default function CreateOutwardFreight() {
  const navigate = useNavigate();
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: transporterOptions } = useLookup('/api/transporters/');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [freightNo, setFreightNo] = useState('');

  // Freight Details for auto-fill
  const [freightDetailOptions, setFreightDetailOptions] = useState([]);
  const [selectedFreightDetail, setSelectedFreightDetail] = useState('');

  // All DCs for linking
  const [allDCs, setAllDCs] = useState([]);
  useEffect(() => {
    apiClient.get('/api/sales/dc/', { params: { page_size: 500 } })
      .then(r => setAllDCs((r.data?.results || r.data || []).map(d => ({ value: d.id, label: d.dc_no }))))
      .catch(() => {});
    // Fetch freight details that are not cancelled and not already linked to an outward freight
    Promise.all([
      apiClient.get('/api/sales/freight-details/', { params: { page_size: 500 } }),
      apiClient.get('/api/sales/freight/', { params: { page_size: 500 } }),
    ]).then(([fdRes, fRes]) => {
      const fdList = fdRes.data?.results || fdRes.data || [];
      const freightList = fRes.data?.results || fRes.data || [];
      // Get all freight_detail IDs already linked to an outward freight
      const linkedFDIds = new Set(freightList.filter(f => f.freight_detail).map(f => f.freight_detail));
      setFreightDetailOptions(
        fdList.filter(f => f.status !== 'CANCELLED' && !linkedFDIds.has(f.id)).map(f => ({
          value: f.id, label: `${f.freight_no} - ${f.customer_name || ''} (${f.lorry_no || ''})`,
        }))
      );
    }).catch(() => {});
    // Generate next outward freight number
    apiClient.get('/api/sales/freight/next-number/')
      .then(r => setFreightNo(r.data?.number || ''))
      .catch(() => setFreightNo(''));
  }, []);

  const [formData, setFormData] = useState({
    freight_detail: '',
    transporter: '',
    freight_date: new Date().toISOString().split('T')[0],
    invoice_date: '',
    customer_name: '',
    lorry_no: '',
    destination: '',
    base_amount: '',
    remarks: '',
  });
  const [dcLinks, setDcLinks] = useState([{ ...emptyDCLink }]);

  // When Freight No is selected, auto-fill from FreightDetail
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
        // Fetch product lines for each DC
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

  // Calculations
  const baseAmt = parseFloat(formData.base_amount) || 0;
  const payableAmount = baseAmt;

  const fmt = (v) => formatCurrency(v);

  // Recalculate aggregate freight fields from all selected DCs
  const recalcFromDCs = (links) => {
    const activeLinks = links.filter(l => l.dc);
    if (activeLinks.length === 0) return;
    const totalFreight = activeLinks.reduce((s, l) => s + (parseFloat(l.freight_amount) || 0), 0);
    const totalQty = activeLinks.reduce((s, l) => s + (parseFloat(l.total_qty) || 0), 0);
    const rates = activeLinks.map(l => parseFloat(l.freight_rate) || 0).filter(r => r > 0);
    const avgRate = rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
    const first = activeLinks[0];
    setFormData(prev => ({
      ...prev,
      base_amount: totalFreight > 0 ? totalFreight.toFixed(2) : prev.base_amount,
      transporter: first.transporter || prev.transporter,
      lorry_no: first.lorry_no || prev.lorry_no,
      destination: first.destination || prev.destination,
      invoice_date: first.invoice_date || prev.invoice_date,
    }));
  };

  // DC links
  const handleDCLinkChange = async (idx, field, value) => {
    setDcLinks(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
    if (field === 'dc' && value) {
      try {
        const res = await apiClient.get(`/api/sales/dc/${value}/`);
        const dc = res.data || {};
        const lines = (dc.dc_lines || []).map(l => ({
          name: l.product_name || l.product_sku || '',
          qty: l.quantity_dispatched || 0,
          uom: l.uom || '',
        }));
        const totalQty = lines.reduce((s, p) => s + (parseFloat(p.qty) || 0), 0);
        const firstUom = lines[0]?.uom || '';
        setDcLinks(prev => {
          const updated = prev.map((l, i) => i === idx ? {
            ...l,
            products: lines,
            invoice_no: dc.invoice_no || l.invoice_no,
            destination: dc.destination || l.destination,
            freight_amount: parseFloat(dc.freight_amount_total) || 0,
            freight_rate: parseFloat(dc.freight_rate_value) || 0,
            total_qty: totalQty,
            uom: firstUom,
            transporter: dc.transporter || '',
            lorry_no: dc.lorry_no || '',
            invoice_date: dc.invoice_date || '',
          } : l);
          recalcFromDCs(updated);
          return updated;
        });
        toast.success('Freight details auto-filled from DC!');
      } catch { /* ignore */ }
    }
    if (field === 'dc' && !value) {
      setDcLinks(prev => {
        const updated = prev.map((l, i) => i === idx ? { ...emptyDCLink } : l);
        recalcFromDCs(updated);
        return updated;
      });
    }
  };
  const addDCLink = () => setDcLinks(prev => [...prev, { ...emptyDCLink }]);
  const removeDCLink = (idx) => {
    if (dcLinks.length > 1) {
      setDcLinks(prev => {
        const updated = prev.filter((_, i) => i !== idx);
        recalcFromDCs(updated);
        return updated;
      });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.base_amount || parseFloat(formData.base_amount) <= 0) { toast.error('Freight Value must be > 0.'); return; }

    setIsLoading(true);
    try {
      const payload = {
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
      };
      const res = await apiClient.post('/api/sales/freight/', payload);
      const newId = res.data?.id;
      toast.success('Outward Freight created!');
      if (pendingAttachments.length > 0 && newId) { await uploadPendingFiles('FREIGHT', newId, pendingAttachments); }
      navigate(`/sales/freight/${newId || ''}`);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader title="Create Outward Freight" breadcrumbs={[
        { label: 'Sales', path: '/sales' },
        { label: 'Outward Freight', path: '/sales/freight' },
        { label: 'Create' },
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
                <option value="">-- Select Freight No to auto-fill (or create manually) --</option>
                {freightDetailOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </CustomSelect>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Outward Freight No</label>
                <input type="text" value={freightNo} readOnly className={`${inputClass} bg-slate-50 text-slate-600 font-medium`} placeholder="Generating..." />
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

          <FileAttachments module="FREIGHT" recordId={null} onPendingChange={setPendingAttachments} />

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate('/sales/freight')} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Creating...' : 'Create Outward Freight'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
