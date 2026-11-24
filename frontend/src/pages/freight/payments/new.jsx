import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowDownLeft, ArrowUpRight, Truck } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const labelClass = 'block text-sm font-medium text-slate-700 mb-1';
const readOnlyClass = `${inputClass} bg-slate-50 cursor-not-allowed`;
const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export default function FreightPaymentCreate() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Freight Payment');
  const [searchParams] = useSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [saveAndNew, setSaveAndNew] = useState(false);

  // All freight records for dropdown
  const [purchaseFreights, setPurchaseFreights] = useState([]);
  const [salesFreights, setSalesFreights] = useState([]);
  const [localFreights, setLocalFreights] = useState([]);
  const [loadingFreights, setLoadingFreights] = useState(true);

  // Selected freight info
  const [selectedType, setSelectedType] = useState('');
  const [selectedFreightId, setSelectedFreightId] = useState('');
  const [freightInfo, setFreightInfo] = useState(null);
  // Which freight leg the picker is showing: 'purchase' = Inward, 'sales' = Outward.
  // The dropdown lists only the chosen leg so the two never mix.
  const [freightDirection, setFreightDirection] = useState('purchase');

  // Payment form
  const [formData, setFormData] = useState({
    payment_date: new Date().toISOString().split('T')[0],
    amount_paid: '',
    payment_mode: 'BANK',
    paid_to: '',
    reference_no: '',
    notes: '',
  });

  // Fetch all freights for dropdown
  useEffect(() => {
    const load = async () => {
      setLoadingFreights(true);
      try {
        const [pRes, sRes, lRes] = await Promise.all([
          apiClient.get('/api/purchase/freight/').catch(() => ({ data: [] })),
          apiClient.get('/api/sales/freight/').catch(() => ({ data: [] })),
          apiClient.get('/api/purchase/local-freight/').catch(() => ({ data: [] })),
        ]);
        setPurchaseFreights(pRes.data?.results || pRes.data || []);
        setSalesFreights(sRes.data?.results || sRes.data || []);
        setLocalFreights(lRes.data?.results || lRes.data || []);
      } catch { /* ignore */ }
      finally { setLoadingFreights(false); }
    };
    load();
  }, []);

  // Auto-select from query params
  useEffect(() => {
    const type = searchParams.get('type');
    const freightId = searchParams.get('freight_id');
    if (type && freightId) {
      setFreightDirection(type);
      setSelectedType(type);
      setSelectedFreightId(freightId);
      loadFreightInfo(type, freightId);
    }
  }, [searchParams]);

  // Build dropdown options (exclude fully paid and cancelled)
  const freightOptions = useMemo(() => {
    const pOpts = purchaseFreights
      .filter(f => {
        if (['CANCELLED', 'PAID'].includes(f.status)) return false;
        // Exclude if fully paid by amount (balance <= 0)
        const payable = Number(f.payable_amount) || Number(f.total_freight_cost) || 0;
        const paid = Number(f.total_paid) || 0;
        if (payable > 0 && paid >= payable) return false;
        return true;
      })
      .map(f => ({
        value: `purchase__${f.id}`,
        label: `${f.advice_no} (Purchase) - ${f.vendor_name || f.transporter_name || ''}`,
        type: 'purchase',
        id: f.id,
      }));
    const sOpts = salesFreights
      .filter(f => !['CANCELLED', 'PAID'].includes(f.status))
      .map(f => ({
        value: `sales__${f.id}`,
        label: `${f.advice_no} (Sales) - ${f.customer_name || f.transporter_name || ''}`,
        type: 'sales',
        id: f.id,
      }));
    const lOpts = localFreights
      .filter(f => (Number(f.balance) || 0) > 0)
      .map(f => ({
        value: `local__${f.id}`,
        label: `${f.freight_no} (Local) - ${f.transporter_name || f.company_name || ''}`,
        type: 'local',
        id: f.id,
      }));
    // Show only the leg the user picked (Inward / Outward / Local) so the
    // legs never appear in the same dropdown.
    if (freightDirection === 'sales') return sOpts;
    if (freightDirection === 'local') return lOpts;
    return pOpts;
  }, [purchaseFreights, salesFreights, localFreights, freightDirection]);

  // Switch Inward/Outward — clears any in-progress selection so a stale
  // freight from the other leg can't stay selected.
  const handleDirectionChange = (dir) => {
    if (dir === freightDirection) return;
    setFreightDirection(dir);
    setSelectedType('');
    setSelectedFreightId('');
    setFreightInfo(null);
    setFormData(prev => ({ ...prev, amount_paid: '', paid_to: '' }));
  };

  const loadFreightInfo = async (type, id) => {
    try {
      if (type === 'local') {
        const res = await apiClient.get(`/api/purchase/local-freight/${id}/`);
        const f = res.data;
        const totalPayable = Number(f.payable_amount) || 0;
        const totalPaid = Number(f.total_paid) || 0;
        const balance = Math.max(0, Number(f.balance) || (totalPayable - totalPaid));
        setFreightInfo({
          advice_no: f.freight_no,
          type,
          freight_type: f.freight_type || '',
          freight_terms: '',
          is_prepaid: false,
          transporter_name: f.transporter_name || '',
          party_name: f.transporter_name || f.company_name || '',
          total_amount: totalPayable,
          total_paid: totalPaid,
          balance,
          status: balance <= 0 ? 'Paid' : (totalPaid > 0 ? 'Partially Paid' : 'Unpaid'),
        });
        setFormData(prev => ({
          ...prev,
          amount_paid: balance.toFixed(2),
          paid_to: f.transporter_name || f.company_name || '',
        }));
        return;
      }
      const api = type === 'purchase' ? '/api/purchase/freight' : '/api/sales/freight';
      const res = await apiClient.get(`${api}/${id}/`);
      const f = res.data;
      const totalPayable = type === 'purchase'
        ? (Number(f.total_freight_cost) || Number(f.payable_amount) || 0)
        : (Number(f.payable_amount) || 0);
      const totalPaid = Number(f.total_paid) || 0;
      const balance = totalPayable - totalPaid;

      // freight_terms = 'PAID' means the freight charges were already
      // settled at source (e.g. vendor paid the transporter directly and
      // baked it into the goods price). The "Record Freight Payment"
      // form should be locked in that case — there's nothing to pay.
      const freightTerms = f.freight_terms || '';
      const isPrepaid = freightTerms === 'PAID';

      setFreightInfo({
        advice_no: f.advice_no,
        type,
        freight_type: f.freight_type || '',
        freight_terms: freightTerms,
        is_prepaid: isPrepaid,
        transporter_name: f.transporter_name || '',
        vendor_name: type === 'purchase' ? (f.vendor_name || '') : '',
        customer_name: type === 'sales' ? (f.customer_name || '') : '',
        party_name: type === 'purchase' ? (f.transporter_name || f.vendor_name || '') : (f.transporter_name || f.customer_name || ''),
        total_amount: totalPayable,
        // When prepaid, treat the whole amount as already paid so the
        // sidebar summary, progress bar, and status all read 100%.
        total_paid: isPrepaid ? totalPayable : totalPaid,
        balance: isPrepaid ? 0 : Math.max(0, balance),
        status: f.status_display || f.status,
      });
      setFormData(prev => ({
        ...prev,
        amount_paid: isPrepaid ? '0.00' : Math.max(0, balance).toFixed(2),
        paid_to: type === 'purchase' ? (f.transporter_name || f.vendor_name || '') : (f.transporter_name || f.customer_name || ''),
      }));
    } catch {
      toast.error('Failed to load freight details');
      setFreightInfo(null);
    }
  };

  const handleFreightSelect = (val) => {
    if (!val) {
      setSelectedType('');
      setSelectedFreightId('');
      setFreightInfo(null);
      return;
    }
    const [type, id] = val.split('__');
    setSelectedType(type);
    setSelectedFreightId(id);
    loadFreightInfo(type, id);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  // Calculations
  const currentAmount = parseFloat(formData.amount_paid) || 0;
  const remainingBalance = freightInfo ? freightInfo.balance - currentAmount : 0;

  const getPaymentStatus = () => {
    if (!freightInfo) return '-';
    const newTotalPaid = freightInfo.total_paid + currentAmount;
    if (newTotalPaid <= 0) return 'Unpaid';
    if (newTotalPaid >= freightInfo.total_amount) return 'Paid';
    return 'Partially Paid';
  };

  const handleSubmit = async (e, andNew = false) => {
    e.preventDefault();
    if (!selectedFreightId || !selectedType) {
      toast.error('Please select a Freight Reference.');
      return;
    }
    if (freightInfo?.is_prepaid) {
      toast.error('This freight was prepaid (Freight Terms = Paid). No payment needs to be recorded.');
      return;
    }
    if (!formData.amount_paid || currentAmount <= 0) {
      toast.error('Payment amount must be greater than 0.');
      return;
    }
    if (freightInfo && currentAmount > freightInfo.balance) {
      toast.error(`Payment amount (${fmt(currentAmount)}) exceeds balance (${fmt(freightInfo.balance)}).`);
      return;
    }
    // LINEHAUL freight: partial payments NOT allowed for INWARD
    // (purchase) freight — we pay the transporter the whole haul fee
    // in one go. OUTWARD (sales) freight is the customer paying US,
    // and customers often pay in instalments, so partial payments are
    // allowed there even for LINEHAUL.
    if (freightInfo && freightInfo.freight_type === 'LINEHAUL' && selectedType === 'purchase') {
      if (Math.abs(currentAmount - freightInfo.balance) > 0.01) {
        toast.error(`Partial payments are not allowed for LINEHAUL inward freight. You must pay the full balance of ${fmt(freightInfo.balance)} in a single payment.`);
        return;
      }
    }

    setIsLoading(true);
    try {
      const api = selectedType === 'purchase'
        ? `/api/purchase/freight/${selectedFreightId}/add-payment/`
        : selectedType === 'local'
          ? `/api/purchase/local-freight/${selectedFreightId}/add-payment/`
          : `/api/sales/freight/${selectedFreightId}/add-payment/`;

      // Sales freight payment uses `remarks`; inbound + local use `paid_to`/`notes`.
      const payload = selectedType === 'sales'
        ? {
            payment_date: formData.payment_date,
            amount_paid: formData.amount_paid,
            payment_mode: formData.payment_mode,
            reference_no: formData.reference_no,
            remarks: formData.notes,
          }
        : {
            payment_date: formData.payment_date,
            amount_paid: formData.amount_paid,
            payment_mode: formData.payment_mode,
            paid_to: formData.paid_to,
            reference_no: formData.reference_no,
            notes: formData.notes,
          };

      await apiClient.post(api, payload);
      toast.success('Payment recorded successfully!');

      if (andNew) {
        setFormData({ payment_date: new Date().toISOString().split('T')[0], amount_paid: '', payment_mode: 'BANK', paid_to: '', reference_no: '', notes: '' });
        setSelectedType('');
        setSelectedFreightId('');
        setFreightInfo(null);
      } else {
        navigate('/freight/payments');
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const statusColors = { 'Unpaid': 'bg-red-100 text-red-700', 'Partially Paid': 'bg-amber-100 text-amber-700', 'Paid': 'bg-emerald-50 text-emerald-700' };

  return (
    <MainLayout>
      <PageHeader
        title="Record Freight Payment"
        breadcrumbs={[{ label: 'Freight', path: '/freight/inward' }, { label: 'Payments', path: '/freight/payments' }, { label: 'New Payment' }]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        {/* Main Form */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <form onSubmit={(e) => handleSubmit(e, false)} noValidate>
              <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">

              {/* Freight Reference Selection */}
              <div>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Freight Reference</h3>
                {/* Inward / Outward toggle — picks which freight leg the
                    dropdown below lists. Locked when arriving with a freight
                    pre-selected via query params. */}
                <div className="mb-4">
                  <label className={labelClass}>Freight Type</label>
                  <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => handleDirectionChange('purchase')}
                      disabled={!!searchParams.get('freight_id')}
                      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${freightDirection === 'purchase' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                    >
                      <ArrowDownLeft size={16} /> Inward
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDirectionChange('sales')}
                      disabled={!!searchParams.get('freight_id')}
                      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-l border-slate-300 disabled:opacity-50 disabled:cursor-not-allowed ${freightDirection === 'sales' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                    >
                      <ArrowUpRight size={16} /> Outward
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDirectionChange('local')}
                      disabled={!!searchParams.get('freight_id')}
                      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-l border-slate-300 disabled:opacity-50 disabled:cursor-not-allowed ${freightDirection === 'local' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                    >
                      <Truck size={16} /> Local
                    </button>
                  </div>
                </div>
                <div>
                  <label className={labelClass}>Select {({ purchase: 'Inward', sales: 'Outward', local: 'Local' }[freightDirection] || 'Inward')} Freight <span className="text-red-500">*</span></label>
                  <CustomSelect
                    value={selectedType && selectedFreightId ? `${selectedType}__${selectedFreightId}` : ''}
                    onChange={(e) => handleFreightSelect(e.target.value)}
                    className={inputClass}
                    disabled={!!searchParams.get('freight_id')}
                  >
                    <option value="">{`-- Select ${({ purchase: 'Inward', sales: 'Outward', local: 'Local' }[freightDirection] || 'Inward')} Freight --`}</option>
                    {freightOptions.length === 0 && !loadingFreights && (
                      <option value="" disabled>{`No ${({ purchase: 'inward', sales: 'outward', local: 'local' }[freightDirection] || 'inward')} freight to pay`}</option>
                    )}
                    {freightOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>

                {/* Auto-fetched freight info */}
                {freightInfo && (
                  <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex items-center gap-2 mb-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${selectedType === 'purchase' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                        {selectedType === 'purchase' ? <><ArrowDownLeft size={12} /> Purchase</> : selectedType === 'local' ? <><Truck size={12} /> Local</> : <><ArrowUpRight size={12} /> Sales</>}
                      </span>
                      <span className="font-semibold text-blue-800">{freightInfo.advice_no}</span>
                      {freightInfo.is_prepaid && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-700">
                          Freight Terms: Paid
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div><span className="text-blue-600">Party:</span> <span className="ml-1 font-medium">{freightInfo.party_name || '-'}</span></div>
                      <div><span className="text-blue-600">Total Amount:</span> <span className="ml-1 font-medium">{fmt(freightInfo.total_amount)}</span></div>
                      <div><span className="text-blue-600">Already Paid:</span> <span className="ml-1 font-medium text-emerald-700">{fmt(freightInfo.total_paid)}</span></div>
                      <div><span className="text-blue-600">Balance:</span> <span className="ml-1 font-bold text-orange-600">{fmt(freightInfo.balance)}</span></div>
                    </div>
                  </div>
                )}
                {freightInfo?.is_prepaid && (
                  <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-800">
                    <strong>This freight is fully paid.</strong> Freight Terms on the source freight are set to <strong>Paid</strong>,
                    meaning the charges were settled at source (typically baked into the vendor's invoice).
                    No payment needs to be recorded here.
                  </div>
                )}
              </div>

              {/* Payment Details */}
              <fieldset disabled={!!freightInfo?.is_prepaid} className={freightInfo?.is_prepaid ? 'opacity-60' : ''}>
                <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Payment Details</h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Payment Date <span className="text-red-500">*</span></label>
                    <CustomDatePicker name="payment_date" value={formData.payment_date} onChange={handleChange} required className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Paid To</label>
                    <input type="text" name="paid_to" value={formData.paid_to} onChange={handleChange} className={inputClass} placeholder="Transporter / Vendor / Driver" />
                  </div>
                  <div>
                    <label className={labelClass}>Payment Mode <span className="text-red-500">*</span></label>
                    <CustomSelect name="payment_mode" value={formData.payment_mode} onChange={handleChange} className={inputClass}>
                      <option value="CASH">Cash</option>
                      <option value="BANK">Bank Transfer</option>
                      <option value="UPI">UPI</option>
                      <option value="CHEQUE">Cheque</option>
                      <option value="NEFT">NEFT</option>
                      <option value="RTGS">RTGS</option>
                      <option value="OTHER">Other</option>
                    </CustomSelect>
                  </div>
                  <div>
                    {/* The "full payment required" rule applies ONLY to
                        LINEHAUL inward (purchase) freight — we pay the
                        transporter their whole haul in one go. Outward
                        (sales) freight is the customer paying us, and
                        instalments are common; partial payments are
                        always allowed there. */}
                    {(() => {
                      const lockToFullPayment =
                        freightInfo?.freight_type === 'LINEHAUL' && selectedType === 'purchase';
                      return (
                        <>
                          <label className={labelClass}>
                            Payment Amount <span className="text-red-500">*</span>
                            {lockToFullPayment && (
                              <span className="text-amber-600 text-xs font-normal ml-2">(Full payment required — partial not allowed)</span>
                            )}
                          </label>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                            <input
                              type="number" step="0.01" min="0.01"
                              max={freightInfo?.balance || ''}
                              name="amount_paid" value={formData.amount_paid}
                              onChange={(e) => {
                                if (lockToFullPayment) {
                                  toast.error('Partial payments are not allowed for LINEHAUL inward freight. Full balance must be paid.');
                                  return;
                                }
                                handleChange(e);
                              }}
                              readOnly={lockToFullPayment}
                              className={`${inputClass} pl-7 ${lockToFullPayment ? 'bg-slate-50 cursor-not-allowed' : ''}`}
                              placeholder="0.00"
                              title={lockToFullPayment ? 'LINEHAUL inward freight requires full payment in one go' : ''}
                            />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  <div>
                    <label className={labelClass}>Reference No / Transaction ID</label>
                    <input type="text" name="reference_no" value={formData.reference_no} onChange={handleChange} className={inputClass} placeholder="Cheque no, UTR, etc." />
                  </div>
                  <div>
                    <label className={labelClass}>Balance After Payment</label>
                    <input type="text" readOnly value={freightInfo ? fmt(Math.max(0, remainingBalance)) : '-'} className={`${readOnlyClass} ${remainingBalance < 0 ? 'text-red-600' : remainingBalance === 0 ? 'text-green-600' : 'text-orange-600'} font-semibold`} />
                  </div>
                </div>
                <div className="mt-4">
                  <label className={labelClass}>Remarks / Notes</label>
                  <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} placeholder="Payment notes..." />
                </div>
              </fieldset>

              {/* Validation warnings */}
              {remainingBalance < 0 && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  Payment amount exceeds the pending balance by {fmt(Math.abs(remainingBalance))}.
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-between items-center pt-4 border-t">
                {freightInfo && (
                  <button type="button" onClick={() => navigate(`/freight/${selectedType}/${selectedFreightId}`)} className="text-sm text-primary-600 hover:underline">
                    View Linked Freight →
                  </button>
                )}
                <div className="flex gap-3 ml-auto">
                  <button type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/payments')} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
                  <button
                    type="submit"
                    disabled={isLoading || !!freightInfo?.is_prepaid}
                    title={freightInfo?.is_prepaid ? 'Freight Terms are Paid — nothing to record' : ''}
                    className="px-4 sm:px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoading ? 'Processing...' : freightInfo?.is_prepaid ? 'Already Paid' : 'Pay'}
                  </button>
                </div>
              </div>
              </EditGate>
            </form>
          </div>
        </div>

        {/* Sidebar - Payment Summary */}
        <div className="space-y-4 sm:space-y-5">
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Payment Summary</h3>
            {freightInfo ? (
              <div className="space-y-4">
                <div>
                  <p className="text-xs text-slate-500 uppercase">Total Freight Amount</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{fmt(freightInfo.total_amount)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase">Already Paid</p>
                  <p className="text-xl font-bold text-emerald-700 mt-1">{fmt(freightInfo.total_paid)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase">Current Payment</p>
                  <p className="text-xl font-bold text-blue-700 mt-1">{fmt(currentAmount)}</p>
                </div>
                <div className="border-t pt-3">
                  <p className="text-xs text-slate-500 uppercase">Balance After Payment</p>
                  <p className={`text-xl font-bold mt-1 ${remainingBalance > 0 ? 'text-orange-600' : remainingBalance === 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {fmt(Math.max(0, remainingBalance))}
                  </p>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-500 uppercase">Status After Payment</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusColors[getPaymentStatus()] || 'bg-slate-100 text-slate-600'}`}>
                    {getPaymentStatus()}
                  </span>
                </div>
                <div>
                  <div className="w-full bg-slate-200 rounded-full h-2.5 mt-2">
                    <div className="bg-emerald-600 h-2.5 rounded-full transition-all" style={{ width: `${Math.min(100, freightInfo.total_amount > 0 ? ((freightInfo.total_paid + currentAmount) / freightInfo.total_amount) * 100 : 0)}%` }}></div>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {freightInfo.total_amount > 0 ? Math.round(((freightInfo.total_paid + currentAmount) / freightInfo.total_amount) * 100) : 0}% paid
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400 text-center py-4 sm:py-5">Select a freight record to see payment summary</p>
            )}
          </div>

          {/* Quick Info */}
          <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-3">Quick Actions</h3>
            <div className="space-y-2">
              <button onClick={() => navigate('/freight/inward')} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 text-left">
                View Inward Freight
              </button>
              <button onClick={() => navigate('/freight/outward')} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 text-left">
                View Outward Freight
              </button>
              <button onClick={() => navigate('/freight/payments')} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 text-left">
                View Payment History
              </button>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}
