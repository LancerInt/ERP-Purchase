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
const emptyDCLink = { dc: '', product: '', product_name: '', quantity: '', invoice_no: '', destination: '' };

export default function CreateFreightDetail() {
  const navigate = useNavigate();
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: transporterOptions } = useLookup('/api/transporters/');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [freightNo, setFreightNo] = useState('');
  const [selectedCompany, setSelectedCompany] = useState('');
  const [filteredCustomers, setFilteredCustomers] = useState([]);
  // `sales_scope=true` restricts the picker to the user's allowed
  // warehouses — see sales.mixins._user_allowed_warehouse_ids.
  const { options: warehouseOptions } = useLookup(selectedCompany ? `/api/warehouses/?company=${selectedCompany}&sales_scope=true` : null);
  const [allDCs, setAllDCs] = useState([]);

  // Fetch DCs filtered by customer
  const fetchAvailableDCs = (customerId) => {
    setAllDCs([]);
    setDcLinks([{ ...emptyDCLink }]);
    if (!customerId) return;
    apiClient.get('/api/sales/freight-details/available-dcs/', { params: { customer_id: customerId } })
      .then(r => setAllDCs((r.data || []).map(d => ({ value: d.id, label: d.dc_no }))))
      .catch(() => {});
  };

  useEffect(() => {
    apiClient.get('/api/sales/freight-details/next-number/')
      .then(r => setFreightNo(r.data?.number || ''))
      .catch(() => setFreightNo(''));
  }, []);

  const [formData, setFormData] = useState({
    freight_date: new Date().toISOString().split('T')[0],
    company: '', factory: '', customer: '', transporter: '',
    freight_type: '', lorry_no: '', total_quantity: '', quantity_uom: 'MTS',
    freight_per_ton: '0', total_freight: '0', freight_paid: '0',
    discount: '0', additional_freight: '0', less_amount: '0', tds_less: '0',
    destination: '', destination_state: '', remarks: '', status: 'PENDING',
  });
  const [dcLinks, setDcLinks] = useState([{ ...emptyDCLink }]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    const val = type === 'checkbox' ? checked : value;
    setFormData(prev => ({ ...prev, [name]: val }));
    if (name === 'company') {
      setSelectedCompany(value);
      setFormData(prev => ({ ...prev, company: value, factory: '', customer: '' }));
      setFilteredCustomers([]);
      setAllDCs([]);
      setDcLinks([{ ...emptyDCLink }]);
      if (value) {
        apiClient.get(`/api/customers/?company=${value}`)
          .then(r => {
            const list = r.data?.results || r.data || [];
            setFilteredCustomers(list.map(c => ({ value: c.id, label: c.customer_name || c.name || c.customer_code || c.id })));
          }).catch(() => setFilteredCustomers([]));
      }
    }
    if (name === 'customer') {
      setFormData(prev => ({ ...prev, customer: value }));
      fetchAvailableDCs(value);
    }
  };

  // Auto-calculate total quantity from DC lines
  const totalQuantity = dcLinks.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);

  // Auto-calculate total freight = (freight per ton × total quantity) - discount + additional - less - tds
  const freightPerTon = parseFloat(formData.freight_per_ton) || 0;
  const baseFreight = freightPerTon * totalQuantity;
  const discountAmt = parseFloat(formData.discount) || 0;
  const additionalFreight = parseFloat(formData.additional_freight) || 0;
  const lessAmount = parseFloat(formData.less_amount) || 0;
  const tdsLess = parseFloat(formData.tds_less) || 0;
  const totalFreight = baseFreight - discountAmt + additionalFreight - lessAmount - tdsLess;
  const freightPaid = 0; // Always 0 for new freight, payments happen in Outward Freight
  const balance = Math.max(0, totalFreight - freightPaid);
  const fmt = (v) => formatCurrency(v);


  const handleDCChange = async (idx, field, value) => {
    if (field === 'dc' && value) {
      // Fetch DC details to auto-fill invoice_no, destination, products, qty
      try {
        const res = await apiClient.get(`/api/sales/dc/${value}/`);
        const dcData = res.data;
        const dcLinesList = dcData.dc_lines || [];
        // Create one row per DC line (product)
        const newRows = dcLinesList.map(l => ({
          dc: value,
          product: l.product || '',
          product_name: l.product_name || '',
          quantity: l.quantity_dispatched || '',
          invoice_no: dcData.invoice_no || '',
          destination: dcData.warehouse_name || '',
        }));
        if (newRows.length > 0) {
          setDcLinks(prev => {
            const updated = [...prev];
            updated.splice(idx, 1, ...newRows);
            return updated;
          });
          return;
        }
      } catch { /* fallback to manual */ }
    }
    setDcLinks(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };
  const addDC = () => setDcLinks(prev => [...prev, { ...emptyDCLink }]);
  const removeDC = (idx) => { if (dcLinks.length > 1) setDcLinks(prev => prev.filter((_, i) => i !== idx)); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.company || !formData.factory || !formData.freight_date) {
      toast.error('Company, Factory and Date are required.'); return;
    }
    setIsLoading(true);
    try {
      const payload = {
        ...formData,
        customer: formData.customer || null,
        transporter: formData.transporter || null,
        total_quantity: totalQuantity,
        total_freight: totalFreight,
        freight_paid: 0,
        dc_links: dcLinks.filter(l => l.dc).map(l => ({
          dc: l.dc, product: l.product || null, quantity: l.quantity || 0,
          invoice_no: l.invoice_no || '', destination: l.destination || '',
        })),
      };
      const res = await apiClient.post('/api/sales/freight-details/', payload);
      const newId = res.data?.id;
      toast.success('Freight Detail created!');
      if (pendingAttachments.length > 0 && newId) { await uploadPendingFiles('FREIGHT_DETAIL', newId, pendingAttachments); }
      navigate(`/sales/freight-details/${newId || ''}`);
    } catch (error) { toast.error(getApiErrorMessage(error)); }
    finally { setIsLoading(false); }
  };

  return (
    <MainLayout>
      <PageHeader title="Create Freight Detail" breadcrumbs={[
        { label: 'Sales', path: '/sales' }, { label: 'Freight Details', path: '/sales/freight-details' }, { label: 'Create' },
      ]} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6" noValidate>
          {/* Basic Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Freight Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Freight No</label>
                <input type="text" value={freightNo} readOnly className={`${inputClass} bg-slate-50 text-slate-600 font-medium`} placeholder="Generating..." /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="freight_date" value={formData.freight_date} onChange={handleChange} required className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required className={inputClass}>
                  <option value="">Select Company</option>{companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Factory <span className="text-red-500">*</span></label>
                <CustomSelect name="factory" value={formData.factory} onChange={handleChange} required disabled={!selectedCompany} className={`${inputClass} disabled:bg-slate-100`}>
                  <option value="">{selectedCompany ? 'Select Factory' : 'Select Company first'}</option>{warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer Name</label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} disabled={!selectedCompany} className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                  <option value="">{selectedCompany ? 'Select Customer' : 'Select Company first'}</option>{filteredCustomers.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Transporter</label>
                <CustomSelect name="transporter" value={formData.transporter} onChange={handleChange} className={inputClass}>
                  <option value="">Select Transporter</option>{transporterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Lorry No</label>
                <input type="text" name="lorry_no" value={formData.lorry_no} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Freight Type</label>
                <CustomSelect name="freight_type" value={formData.freight_type} onChange={handleChange} className={inputClass}>
                  <option value="">Select</option><option value="FULL_LOAD">Full Load</option><option value="PART_LOAD">Part Load</option>
                  <option value="LOCAL">Local</option><option value="EXPRESS">Express</option>
                </CustomSelect></div>
            </div>
          </div>

          {/* DC No Section */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">DC No</h3>
              <button type="button" onClick={addDC} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100"><Plus size={16} /> Add New</button>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                <th className="text-left px-3 py-2 font-medium text-slate-600">S No</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">DC <span className="text-red-500">*</span></th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>
                <th className="text-right px-3 py-2 font-medium text-slate-600">Quantity</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Invoice No</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600">Destination</th>
                <th className="px-3 py-2"></th>
              </tr></thead>
              <tbody>{dcLinks.map((l, idx) => (
                <tr key={idx} className="border-b">
                  <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                  <td className="px-3 py-2"><CustomSelect value={l.dc} onChange={(e) => handleDCChange(idx, 'dc', e.target.value)} className={inputClass} style={{ minWidth: '150px' }}>
                    <option value="">Select DC</option>{allDCs.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect></td>
                  <td className="px-3 py-2">
                    {l.product_name ? (
                      <span className="text-sm font-medium text-slate-800">{l.product_name}</span>
                    ) : (
                      <span className="text-xs text-slate-400 italic">Auto-filled from DC</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" step="0.001" min="0" value={l.quantity} onChange={(e) => handleDCChange(idx, 'quantity', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} placeholder="0" />
                  </td>
                  <td className="px-3 py-2"><input type="text" value={l.invoice_no} onChange={(e) => handleDCChange(idx, 'invoice_no', e.target.value)} className={inputClass} style={{ minWidth: '100px' }} /></td>
                  <td className="px-3 py-2"><input type="text" value={l.destination} onChange={(e) => handleDCChange(idx, 'destination', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} /></td>
                  <td className="px-3 py-2"><button type="button" onClick={() => removeDC(idx)} disabled={dcLinks.length <= 1} className="text-red-500 disabled:opacity-30"><Trash2 size={16} /></button></td>
                </tr>
              ))}</tbody>
              {totalQuantity > 0 && (
                <tfoot><tr className="bg-slate-50 font-semibold border-t-2">
                  <td colSpan="3" className="px-3 py-2 text-right text-slate-600">Total Quantity:</td>
                  <td className="px-3 py-2 text-right font-bold text-slate-800">{totalQuantity.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                  <td colSpan="3"></td>
                </tr></tfoot>
              )}
            </table>
          </div>

          {/* Freight Calculation */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Freight Calculation</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Total Quantity</label>
                <input type="text" readOnly value={totalQuantity > 0 ? totalQuantity.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : '0'} className={`${inputClass} bg-slate-50 font-semibold text-slate-700`} />
                <p className="text-xs text-slate-400 mt-0.5">Auto-calculated from DC lines</p></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Freight Per Ton (₹)</label>
                <input type="number" step="0.01" name="freight_per_ton" value={formData.freight_per_ton} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Discount (₹)</label>
                <input type="number" step="0.01" min="0" name="discount" value={formData.discount} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Additional Freight (₹)</label>
                <input type="number" step="0.01" min="0" name="additional_freight" value={formData.additional_freight} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Less Amount (₹)</label>
                <input type="number" step="0.01" min="0" name="less_amount" value={formData.less_amount} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">TDS Less (₹)</label>
                <input type="number" step="0.01" min="0" name="tds_less" value={formData.tds_less} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Total Freight (₹)</label>
                <input type="text" readOnly value={fmt(totalFreight)} className={`${inputClass} bg-slate-50 font-semibold text-slate-700`} />
                <p className="text-xs text-slate-400 mt-0.5">(Per Ton × Qty) - Discount + Additional - Less - TDS</p></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Freight Paid (₹)</label>
                <input type="text" readOnly value={fmt(freightPaid)} className={`${inputClass} bg-slate-50 text-slate-500`} />
                <p className="text-xs text-slate-400 mt-0.5">Updated from Outward Freight</p></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Balance Freight</label>
                <input type="text" readOnly value={fmt(balance)} className={`${inputClass} bg-slate-50 font-semibold ${balance > 0 ? 'text-orange-600' : 'text-green-600'}`} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Destination</label>
                <input type="text" name="destination" value={formData.destination} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Destination (State)</label>
                <input type="text" name="destination_state" value={formData.destination_state} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Freight Status</label>
                <input type="text" readOnly value="Pending" className={`${inputClass} bg-slate-50 text-slate-600`} /></div>
            </div>
          </div>

          {/* Remarks */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional</h3>
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
              <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} className={inputClass} /></div>
          </div>

          <FileAttachments module="FREIGHT_DETAIL" recordId={null} onPendingChange={setPendingAttachments} />

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/freight-details')} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Creating...' : 'Submit'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
