import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import Modal from "@/components/ui/Modal";
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, Paperclip, X, ArrowLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useGuardedNavigate from '../../../hooks/useGuardedNavigate.js';
import useAllProducts from '../components/useAllProducts.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

// Editable spend categories (matches VendorBill.PURCHASE_CATEGORY_CHOICES) and
// the base Tally purchase voucher types — for the bill-edit dropdowns.
const BILL_CATEGORIES = [
  ['', '— Unclassified —'],
  ['RM', 'RM Purchase'],
  ['MAIZE', 'Maize Purchase'],
  ['BOUGHT_NOTE', 'Bought Note (Exempt)'],
  ['PACKING', 'Packing Material'],
  ['FREIGHT', 'Freight / Transport'],
  ['EXPENSES', 'Expenses'],
  ['FRUIT', 'Fruit Purchase'],
  ['LAB_EXPENSE', 'Lab Expense'],
  ['MACHINERY', 'Machinery / Capital'],
  ['BRANCH', 'Branch Transfer'],
];
const BASE_VOUCHER_TYPES = ['GST Purchase', 'GST Purchase-Fruit', 'Purchase-Bought Note', 'Journal'];


// Expense Bill / Apply Debit / Apply Credit are hidden for now at the user's
// request. The handlers, modals and permission checks stay wired so flipping
// this back to `true` restores all three buttons with no other change.
const SHOW_BILL_CREDIT_ACTIONS = false;

export default function VendorBillDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Back honours a `backTo` URL passed by the caller (dashboard drawers,
  // filtered lists) so Back restores the exact view they came from; otherwise
  // falls back to the existing history-aware default.
  const goBack = () => {
    const backTo = location.state?.backTo;
    if (backTo) navigate(backTo);
    else if (window.history.state?.idx > 0) navigate(-1);
    else navigate('/purchase/bills');
  };
  // Permission-aware navigation for cross-module reference links (PO,
  // Receipt) — raises a toast when the user can't view the target.
  const go = useGuardedNavigate();
  const { canEdit, canDelete, canApprove, canCreate, canRecordPayment, canApplyDebit, canApplyCredit, canApplyAdvance } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('Vendor Bill');
  // Each Vendor Bill action button has its own dedicated flag on the
  // Vendor Bill row of the admin permissions grid — admins can grant
  // Record Payment / Apply Debit / Apply Credit / Apply Advance
  // independently of the broader Vendor Bill CRUD perms.
  const canApplyDebitToBill   = canApplyDebit('Vendor Bill');
  const canApplyCreditToBill  = canApplyCredit('Vendor Bill');
  const [bill, setBill] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState(false);
  // Apply-credit modal is one of: null (closed), 'CREDIT', 'DEBIT', 'ADVANCE'.
  // Replaces the older boolean `showCreditModal` so the bill page can render
  // a dedicated Apply Credit / Apply Debit / Apply Advance button per type.
  const [creditModalType, setCreditModalType] = useState(null);
  const [availableCredits, setAvailableCredits] = useState([]);
  const [selectedCredit, setSelectedCredit] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [isApplyingCredit, setIsApplyingCredit] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editData, setEditData] = useState({});
  const [editLines, setEditLines] = useState([]);
  // Zoho bill photo (invoice copy / gatepass / weighment) shown in an in-page modal.
  const [photo, setPhoto] = useState(null); // { kind, label, url, loading, error }
  const openPhoto = async (kind, label) => {
    setPhoto({ kind, label, url: null, loading: true, error: null });
    try {
      const res = await apiClient.get(`/api/purchase/bills/${id}/zoho-photo/?kind=${kind}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      setPhoto((p) => (p && p.kind === kind ? { ...p, url, loading: false } : p));
    } catch {
      setPhoto((p) => (p && p.kind === kind ? { ...p, loading: false, error: 'Could not load the photo from Zoho.' } : p));
    }
  };
  const closePhoto = () => setPhoto((p) => { if (p?.url) URL.revokeObjectURL(p.url); return null; });
  // "Expense Bill" quick-entry — books a CREDIT expense against this bill's
  // vendor in the Expenses > Expense Register.
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  // Left-hand card below the line items switches between the file attachments
  // and the bill's notes / terms, so both share one row with the Amount Summary.
  const [infoTab, setInfoTab] = useState('attachments');
  const [expBill, setExpBill] = useState({ date: new Date().toISOString().slice(0, 10), title: '', description: '', amount: '' });
  const [expBillFile, setExpBillFile] = useState(null);
  const [expBillSaving, setExpBillSaving] = useState(false);

  const openExpenseBill = () => {
    setExpBill({ date: new Date().toISOString().slice(0, 10), title: '', description: '', amount: '' });
    setExpBillFile(null);
    setShowExpenseModal(true);
  };

  const handleSaveExpenseBill = async () => {
    if (!expBill.title.trim()) { toast.error('Enter the expense'); return; }
    if (!(Number(expBill.amount) > 0)) { toast.error('Enter an amount'); return; }
    setExpBillSaving(true);
    try {
      const payload = {
        expense_date: expBill.date,
        title: expBill.title.trim(),
        description: expBill.description,
        payment_method: 'CREDIT',
        vendor: bill.vendor || null,
        party_name: bill.vendor_name || '',
        source_bill: bill.id || id,
        items: [{ name: expBill.title.trim(), quantity: null, unit_price: expBill.amount, is_stock_item: false, consumable_item: null }],
      };
      const res = await apiClient.post('/api/expenses/register/', payload);
      if (expBillFile && res.data?.id) {
        const fd = new FormData();
        fd.append('attachment', expBillFile);
        await apiClient.patch(`/api/expenses/register/${res.data.id}/`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      toast.success('Expense bill booked to credit');
      setShowExpenseModal(false);
    } catch (e) {
      toast.error(getApiErrorMessage(e));
    } finally {
      setExpBillSaving(false);
    }
  };

  const { options: productOptions } = useAllProducts();

  const emptyBillLine = { product: '', description: '', quantity: '', uom: 'KG', rate: '', discount_percent: '0', tax_percent: '0', amount: '' };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this bill? This action cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/bills/${id}/`);
      toast.success('Bill deleted successfully');
      navigate('/purchase/bills');
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete bill');
    }
  };

  const handleEditToggle = () => {
    setIsEditing(true);
    setEditData({ ...bill });
    setEditLines((bill.bill_lines || []).map(l => ({ ...l })));
  };
  const handleEditCancel = () => {
    setIsEditing(false);
    setEditLines((bill.bill_lines || []).map(l => ({ ...l })));
  };
  const handleEditChange = (e) => { setEditData(prev => ({ ...prev, [e.target.name]: e.target.value })); };

  // Line item handlers
  const handleLineChange = (index, field, value) => {
    setEditLines(prev => {
      const updated = prev.map((line, i) => {
        if (i !== index) return line;
        const newLine = { ...line, [field]: value };
        // Auto-calc amount: (qty * rate) - discount% + tax%
        const qty = parseFloat(field === 'quantity' ? value : newLine.quantity) || 0;
        const rate = parseFloat(field === 'rate' ? value : newLine.rate) || 0;
        const disc = parseFloat(field === 'discount_percent' ? value : newLine.discount_percent) || 0;
        const tax = parseFloat(field === 'tax_percent' ? value : newLine.tax_percent) || 0;
        const subtotal = Math.round(qty * rate * 100) / 100;
        const afterDisc = Math.round((subtotal - (subtotal * disc / 100)) * 100) / 100;
        newLine.amount = (Math.round((afterDisc + (afterDisc * tax / 100)) * 100) / 100).toFixed(2);
        return newLine;
      });
      return updated;
    });
  };
  const handleAddLine = () => setEditLines(prev => [...prev, { ...emptyBillLine }]);
  const handleRemoveLine = (i) => setEditLines(prev => prev.filter((_, idx) => idx !== i));

  const handleEditSave = async () => {
    // Validate bill line quantities before saving
    for (const line of editLines) {
      if (!line.product) continue;
      const qty = parseFloat(line.quantity) || 0;
      if (qty <= 0) {
        toast.error('Quantity must be greater than 0.');
        return;
      }
    }

    setIsSaving(true);
    try {
      const payload = {
        vendor_invoice_no: editData.vendor_invoice_no || '',
        due_date: editData.due_date || null,
        purchase_category: editData.purchase_category || '',
        tally_voucher_type: editData.tally_voucher_type || '',
        notes: editData.notes || '',
        terms_and_conditions: editData.terms_and_conditions || '',
        bill_lines: editLines.filter(l => l.product && l.quantity).map(l => {
          // Route the picked id to the matching FK column based on
          // the line's item_type (carried from the serializer).
          // Goods (default) continue to use `product`.
          const itemType = (l.item_type || 'PRODUCT').toUpperCase();
          // Machine spares are MACHINERY Products now → save to `product`.
          const fkPair = itemType === 'SERVICE'
            ? { service_catalogue: l.product }
            : { product: l.product };
          return {
            ...fkPair,
            description: l.description || '',
            quantity: l.quantity,
            uom: l.uom || '',
            rate: l.rate || 0,
            discount_percent: l.discount_percent || 0,
            tax_percent: l.tax_percent || 0,
            amount: l.amount || 0,
          };
        }),
      };
      // A hand-picked category is a manual override — stamp it so the
      // auto-classifier never reverts it on a future re-run.
      if ((editData.purchase_category || '') !== (bill.purchase_category || '')) {
        payload.category_source = 'manual';
      }
      // Recalculate totals
      const lines = payload.bill_lines;
      const subtotal = lines.reduce((s, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const rate = parseFloat(l.rate) || 0;
        return s + qty * rate;
      }, 0);
      const discountAmount = lines.reduce((s, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const rate = parseFloat(l.rate) || 0;
        const disc = parseFloat(l.discount_percent) || 0;
        return s + (qty * rate * disc / 100);
      }, 0);
      const taxAmount = lines.reduce((s, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const rate = parseFloat(l.rate) || 0;
        const disc = parseFloat(l.discount_percent) || 0;
        const tax = parseFloat(l.tax_percent) || 0;
        const afterDisc = qty * rate - (qty * rate * disc / 100);
        return s + (afterDisc * tax / 100);
      }, 0);
      payload.subtotal = subtotal.toFixed(2);
      payload.discount_amount = discountAmount.toFixed(2);
      payload.tax_amount = taxAmount.toFixed(2);
      payload.total_amount = (subtotal - discountAmount + taxAmount + (parseFloat(editData.shipping_charges) || 0) + (parseFloat(editData.adjustment) || 0) - (parseFloat(editData.tds_amount) || 0)).toFixed(2);

      const res = await apiClient.patch(`/api/purchase/bills/${id}/`, payload);
      setBill(res.data);
      setEditLines(res.data.bill_lines || []);
      setIsEditing(false);
      toast.success('Bill updated');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally { setIsSaving(false); }
  };
  const [vendorAdvances, setVendorAdvances] = useState([]);

  // Receipt line data for diff in qty display
  const [receiptLines, setReceiptLines] = useState([]);

  const fetchBill = () => {
    apiClient.get(`/api/purchase/bills/${id}/`)
      .then(res => {
        setBill(res.data);
        // Fetch receipt lines for diff in qty
        if (res.data.receipt_advice) {
          apiClient.get(`/api/purchase/receipts/${res.data.receipt_advice}/`)
            .then(rRes => setReceiptLines(rRes.data?.receipt_lines || []))
            .catch(() => {});
        }
      })
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  };

  // Editable round-off on the freight tile: save it onto the freight advice and
  // recompute payable = Freight − TDS − Round-off, then reload the bill.
  const saveFreightRoundoff = async (f, raw) => {
    const roundoff = Number(raw) || 0;
    const freight = Number(f.freight_amount) || 0;
    const tds = Number(f.tds) || 0;
    try {
      await apiClient.patch(`/api/purchase/freight/${f.id}/`, {
        less_amount: Math.abs(roundoff),
        less_amount_sign: roundoff >= 0 ? 'LESS' : 'PLUS',
        payable_amount: Math.max(0, freight - tds - roundoff),
      });
      toast.success('Round-off updated.');
      fetchBill();
    } catch (err) { toast.error(getApiErrorMessage(err) || 'Could not update round-off.'); }
  };

  // Get diff for a bill line by matching product to receipt line
  const getDiffQty = (billLine) => {
    const pid = billLine.product;
    if (!pid || receiptLines.length === 0) return null;
    const rl = receiptLines.find(r => (r.product || r.product_service) === pid);
    if (!rl) return null;
    const rcvd = parseFloat(rl.quantity_received) || 0;
    const net = parseFloat(rl.net_quantity);
    if (isNaN(net)) return null;
    return Math.round((rcvd - net) * 100) / 100;
  };

  useEffect(() => { fetchBill(); }, [id]);

  // Fetch vendor advances when bill loads
  useEffect(() => {
    if (bill?.vendor) {
      apiClient.get(`/api/purchase/vendor-credits/?vendor=${bill.vendor}`)
        .then(res => {
          const credits = res.data?.results || res.data || [];
          setVendorAdvances(credits.filter(c => c.credit_type === 'ADVANCE'));
        })
        .catch(() => setVendorAdvances([]));
    }
  }, [bill?.vendor]);

  // Fetch available credits/advances when modal opens. Only APPROVED
  // (status=OPEN) entries come back from the backend, and we scope to
  // the modal's credit_type so each button only shows its own pool.
  useEffect(() => {
    if (creditModalType && bill?.vendor) {
      apiClient.get(`/api/purchase/vendor-credits/available-for-bill/?vendor_id=${bill.vendor}&bill_id=${id}&credit_type=${creditModalType}`)
        .then(res => setAvailableCredits(res.data || []))
        .catch(() => setAvailableCredits([]));
    } else {
      setAvailableCredits([]);
    }
  }, [creditModalType, bill?.vendor]);

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/purchase/bills/${id}/approve/`);
      setBill(res.data);
      toast.success('Bill approved!');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to approve');
    } finally {
      setIsApproving(false);
    }
  };

  const [isGenerating, setIsGenerating] = useState(false);
  const handleGenerateDebitNote = async () => {
    setIsGenerating(true);
    try {
      const res = await apiClient.post(`/api/purchase/bills/${id}/generate-debit-note/`);
      if (res.data?.created) {
        toast.success(`Debit Note ${res.data.credit_no} created!`);
      } else {
        toast(res.data?.detail || 'No action taken');
      }
      const billRes = await apiClient.get(`/api/purchase/bills/${id}/`);
      setBill(billRes.data);
    } catch (error) {
      toast.error(error.response?.data?.detail || error.response?.data?.error || 'Failed to generate debit note');
    } finally {
      setIsGenerating(false);
    }
  };

  const fmt = (v) => `\u20B9${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const fmtDate = (v) => v ? formatDate(v) : '-';

  const inputClass = "w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
  const labelClass = "block text-xs font-semibold text-slate-700 mb-0.5";

  if (isLoading) return <MainLayout><div className="text-center py-12 text-slate-500">Loading...</div></MainLayout>;
  if (!bill) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Bill not found. It may be a Tally-synced entry with no ERP bill behind it.</p>
        <button onClick={goBack} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Go back
        </button>
      </div>
    </MainLayout>
  );

  const balanceDue = Number(bill.balance_due) || 0;
  const amt = (x) => Number(x) || 0;
  // 194Q/194C TDS withheld on this bill — paid to the govt, not the vendor.
  // Show ONLY Tally's actual deduction (tds_withheld, from TDS Payable) — the SAME
  // source the Bills list "TDS" column uses — so the detail and the list always
  // agree. The old fallback to the on-bill tds_amount was a sparsely-filled estimate
  // that made bills look like TDS was deducted (e.g. ₹489) when Tally booked nothing
  // and the list correctly showed "—".
  const tdsWithheld = amt(bill.tds_withheld);
  // Prefer Tally's actual deduction; when it hasn't been booked yet, fall back to
  // the ENGINE's computed 194Q/194C (computed_tds_amount) — threshold-aware, not the
  // old flat on-bill estimate — so a bill always shows its expected TDS. Flagged
  // "est." so it's never mistaken for a confirmed Tally deduction.
  const tdsComputed = amt(bill.computed_tds_amount);
  // Still used only to keep Balance Due correct for net-total bills (TDS baked
  // into the total). Not displayed — TDS has its own page now.
  const tdsVal = tdsWithheld > 0 ? tdsWithheld : tdsComputed;
  // Gross (pre-TDS) parts of the invoice. Some imports store total_amount GROSS
  // (TDS shown separately, e.g. Coromandel) and some already NET (TDS baked into
  // the total, e.g. this maize bill). We detect which so TDS is shown ONCE and the
  // net is never double-counted: TDS is "in the total" when the gross parts exceed
  // total_amount by ~the TDS amount.
  const _shownCharge = (bill.additional_charges || []).length > 0
    ? (bill.additional_charges || []).reduce((s, c) => s + amt(c.amount), 0)
    : amt(bill.other_charges);
  const grossParts = amt(bill.subtotal) - amt(bill.discount_amount) + amt(bill.tax_amount)
    + amt(bill.shipping_charges) + _shownCharge + amt(bill.adjustment);
  const tdsInTotal = tdsVal > 0 && Math.abs((grossParts - amt(bill.total_amount)) - tdsVal) < 2;
  // What we still owe the vendor, never negative. If TDS is already in the total,
  // it's total − paid; otherwise total − TDS − paid (a gross-paid bill is settled).
  const netDue = Math.max(0, (tdsInTotal ? amt(bill.total_amount) : amt(bill.total_amount) - tdsVal) - amt(bill.amount_paid));

  return (
    <MainLayout>
      <PageHeader
        title={`Bill ${bill.bill_no}`}
        breadcrumbs={[
          { label: 'Purchase', path: '/purchase' },
          { label: 'Bills', path: '/purchase/bills' },
          { label: bill.bill_no },
        ]}
      />

      <div className="space-y-2 sm:space-y-3">
        {/* Header info */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              {!isHidden('status') && <StatusBadge status={bill.status_display || bill.status} />}
              {bill.company_name && (
                <span
                  title={bill.company_name}
                  className="inline-flex items-center max-w-[220px] truncate px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200"
                >
                  {bill.company_name}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {!isEditing && (
                <>
                  {canEdit('Vendor Bill') && bill.status === 'DRAFT' && (
                    <button onClick={handleEditToggle} className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50">Edit</button>
                  )}
                  {canDelete('Vendor Bill') && bill.status === 'DRAFT' && (
                    <button onClick={handleDelete} className="px-4 py-2 border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50">
                      <Trash2 size={16} className="inline mr-1" />Delete
                    </button>
                  )}
                </>
              )}
              {isEditing && (
                <>
                  <button onClick={handleEditCancel} className="px-4 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
                  <button onClick={handleEditSave} disabled={isSaving} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Save'}</button>
                </>
              )}
              {!isEditing && (bill.zoho_photos || []).map((ph) => (
                <button key={ph.kind} onClick={() => openPhoto(ph.kind, ph.label)}
                  className="px-4 py-2 border border-indigo-300 text-indigo-700 rounded-lg text-sm font-medium hover:bg-indigo-50">
                  <Paperclip size={16} className="inline mr-1" />{ph.label}
                </button>
              ))}
              {SHOW_BILL_CREDIT_ACTIONS && !isEditing && canCreate('Expense Register') && (
                <button onClick={openExpenseBill} className="px-4 py-2 border border-teal-300 text-teal-700 rounded-lg text-sm font-medium hover:bg-teal-50">
                  <Plus size={16} className="inline mr-1" />Expense Bill
                </button>
              )}
              {canApprove('Vendor Bill') && bill.status === 'DRAFT' && !isEditing && (
                <button onClick={handleApprove} disabled={isApproving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                  {isApproving ? 'Approving...' : 'Approve'}
                </button>
              )}
              {['OPEN', 'PARTIALLY_PAID'].includes(bill.status) && balanceDue > 0 && (
                <>
                  {SHOW_BILL_CREDIT_ACTIONS && canApplyDebitToBill && (
                    <button onClick={() => setCreditModalType('DEBIT')} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700">
                      Apply Debit
                    </button>
                  )}
                  {SHOW_BILL_CREDIT_ACTIONS && canApplyCreditToBill && (
                    <button onClick={() => setCreditModalType('CREDIT')} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
                      Apply Credit
                    </button>
                  )}
                  {canCreate('Vendor Credit') && bill.is_debit_eligible && !bill.has_credit && (
                    <button onClick={handleGenerateDebitNote} disabled={isGenerating} className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
                      {isGenerating ? 'Generating...' : 'Generate Debit Note'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap rounded-lg border border-slate-200 overflow-hidden bg-white">
            {!isHidden('vendor') && (
            <div className="flex-1 min-w-[150px] px-4 py-2.5 border-b sm:border-b-0 border-r border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Vendor</span>
              <span className="text-[13px] font-semibold text-slate-800">{bill.vendor_name}</span>
            </div>
            )}
            {!isHidden('vendor_invoice_no') && (
            <div className="flex-1 min-w-[150px] px-4 py-2.5 border-b sm:border-b-0 border-r border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Invoice No</span>
              {isEditing ? <input name="vendor_invoice_no" value={editData.vendor_invoice_no || ''} onChange={handleEditChange} disabled={isReadOnly('vendor_invoice_no')} className={isReadOnly('vendor_invoice_no') ? `${lockedInputClass} mt-0.5` : "w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm"} /> : <span className="text-[13px] font-semibold text-slate-800">{bill.vendor_invoice_no || '-'}</span>}
            </div>
            )}
            {!isHidden('bill_date') && (
            <div className="flex-1 min-w-[130px] px-4 py-2.5 border-b sm:border-b-0 border-r border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Bill Date</span>
              <span className="text-[13px] font-semibold text-slate-800">{fmtDate(bill.bill_date)}</span>
            </div>
            )}
            {!isHidden('due_date') && (
            <div className="flex-1 min-w-[130px] px-4 py-2.5 border-b sm:border-b-0 border-r border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Due Date</span>
              {isEditing ? <CustomDatePicker name="due_date" value={editData.due_date || ''} onChange={handleEditChange} disabled={isReadOnly('due_date')} className={isReadOnly('due_date') ? `${lockedInputClass} mt-0.5` : "w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm"} /> : <span className="text-[13px] font-semibold text-slate-800">{fmtDate(bill.due_date)}</span>}
            </div>
            )}
            {!isHidden('purchase_category') && (
            <div className="flex-1 min-w-[150px] px-4 py-2.5 border-b sm:border-b-0 border-r border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Category</span>
              {isEditing ? (
                <CustomSelect value={editData.purchase_category || ''} onChange={(e) => setEditData(prev => ({ ...prev, purchase_category: e.target.value }))} className="w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm bg-white">
                  {BILL_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </CustomSelect>
              ) : <span className="text-[13px] font-semibold text-slate-800">{bill.purchase_category_display || (BILL_CATEGORIES.find(([v]) => v === (bill.purchase_category || ''))?.[1]) || '-'}</span>}
            </div>
            )}
            {!isHidden('tally_voucher_type') && (
            <div className="flex-1 min-w-[150px] px-4 py-2.5 border-b sm:border-b-0 border-r border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Purchase type</span>
              {isEditing ? (
                <CustomSelect value={editData.tally_voucher_type || ''} onChange={(e) => setEditData(prev => ({ ...prev, tally_voucher_type: e.target.value }))} className="w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm bg-white">
                  <option value="">— select —</option>
                  {[...new Set([...BASE_VOUCHER_TYPES, bill.tally_voucher_type].filter(Boolean))].map((t) => <option key={t} value={t}>{t}</option>)}
                </CustomSelect>
              ) : <span className="text-[13px] font-semibold text-slate-800">{bill.tally_voucher_type || '-'}</span>}
            </div>
            )}
            {!isHidden('purchase_order') && (
            <div className="flex-1 min-w-[130px] px-4 py-2.5 border-b sm:border-b-0 border-r border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">PO</span>
              {bill.purchase_order && bill.po_no
                ? <button onClick={() => go(`/purchase/orders/${bill.purchase_order}`)} className="text-[13px] font-semibold text-primary-600 hover:text-primary-800 hover:underline">{bill.po_no}</button>
                : <span className="text-[13px] font-semibold text-slate-400">Not linked</span>}
            </div>
            )}
            {!isHidden('receipt_advice') && (
            <div className="flex-1 min-w-[130px] px-4 py-2.5 border-b sm:border-b-0 border-slate-100">
              <span className="block text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">Receipt</span>
              {bill.receipt_advice && bill.receipt_no
                ? <button onClick={() => go(`/purchase/receipts/${bill.receipt_advice}`)} className="text-[13px] font-semibold text-primary-600 hover:text-primary-800 hover:underline">{bill.receipt_no}</button>
                : <span className="text-[13px] font-semibold text-slate-400">Not linked</span>}
            </div>
            )}
          </div>
        </div>

        {/* Line Items */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800">Line Items <span className="text-slate-400 font-normal">({(isEditing ? editLines : (bill.bill_lines || [])).length})</span></h3>
            {isEditing && (
              <button onClick={handleAddLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Line
              </button>
            )}
          </div>
          {(() => {
            const lines = isEditing ? editLines : (bill.bill_lines || []);
            return lines.length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isEditing ? 'No line items. Click "Add Line" to add.' : 'No line items'}
              </p>
            ) : (
              <>
              {/* Mobile-stacked Bill lines — read-only mode shows
                  key/value rows; edit mode uses the same inputs as the
                  desktop table. */}
              <div className="sm:hidden space-y-3 mb-3">
                {lines.map((line, idx) => {
                  const diff = getDiffQty(line);
                  return (
                    <div key={`m-${line.id || `new-${idx}`}`} className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                      <div className="flex items-start justify-between px-3 py-2 bg-slate-50 border-b border-slate-100 gap-2">
                        <div className="min-w-0">
                          <p className="text-[11px] uppercase tracking-wide text-slate-500">Line #{idx + 1}</p>
                          <p className="text-sm font-semibold text-slate-800 break-words">{line.item_name || line.product_name || '-'}</p>
                          {line.item_type && line.item_type !== 'PRODUCT' && (
                            <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'}`}>
                              {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <p className="text-sm font-bold text-slate-900 whitespace-nowrap">{fmt(line.amount)}</p>
                          {isEditing && (
                            <button onClick={() => handleRemoveLine(idx)} className="text-red-500 hover:text-red-700 p-1"><Trash2 size={14} /></button>
                          )}
                        </div>
                      </div>
                      <div className="px-3 py-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                        <div>
                          <p className="text-[10px] uppercase text-slate-500">Qty</p>
                          <p className="text-slate-800 font-medium">{line.quantity} <span className="text-slate-400">{line.uom || ''}</span></p>
                        </div>
                        {diff !== null && (
                          <div>
                            <p className="text-[10px] uppercase text-slate-500">Diff</p>
                            <p className={`font-medium ${diff > 0 ? 'text-red-600' : diff < 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{diff.toFixed(2)}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-[10px] uppercase text-slate-500">Rate</p>
                          <p className="text-slate-700">{fmt(line.rate)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase text-slate-500">Disc / Tax</p>
                          {isEditing ? (
                            <div className="flex gap-1">
                              <input type="number" step="0.01" min="0" value={line.discount_percent || ''} onChange={(e) => handleLineChange(idx, 'discount_percent', e.target.value)} className="w-1/2 px-2 py-1 border border-slate-300 rounded text-xs text-right" />
                              <input type="number" step="0.01" min="0" value={line.tax_percent || ''} onChange={(e) => handleLineChange(idx, 'tax_percent', e.target.value)} className="w-1/2 px-2 py-1 border border-slate-300 rounded text-xs text-right" />
                            </div>
                          ) : (<p className="text-slate-700">{line.discount_percent}% / {line.effective_tax_percent ?? line.tax_percent}%{line.tax_percent_derived && <span className="text-slate-400" title="Derived from the bill's total GST">*</span>}</p>)}
                        </div>
                        {line.description && (
                          <div className="col-span-2">
                            <p className="text-[10px] uppercase text-slate-500">Description</p>
                            {isEditing ? (
                              <input type="text" value={line.description} onChange={(e) => handleLineChange(idx, 'description', e.target.value)} className="w-full px-2 py-1 border border-slate-300 rounded text-xs" />
                            ) : (<p className="text-slate-700 break-words">{line.description}</p>)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Product {isEditing && <span className="text-red-500">*</span>}</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Qty {isEditing && <span className="text-red-500">*</span>}</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Diff in Qty</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Disc%</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Tax%</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                      {isEditing && <th className="px-3 py-2"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={line.id || `new-${idx}`} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          // Bill lines persisted under machinery /
                          // service_catalogue render as a read-only
                          // label here — the dropdown only knows about
                          // Product master items, so switching to it
                          // would lose the non-Goods FK. Goods rows
                          // keep their existing editable dropdown.
                          line.item_type === 'MACHINERY' || line.item_type === 'SERVICE' ? (
                            <span className="font-medium">{line.item_name || '-'}</span>
                          ) : (
                            <CustomSelect value={line.product || ''} onChange={(e) => handleLineChange(idx, 'product', e.target.value)} className={inputClass} style={{ minWidth: '160px' }}>
                              <option value="">Select Product</option>
                              {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </CustomSelect>
                          )
                        ) : (
                          <span className="font-medium">
                            {line.item_name || line.product_name || '-'}
                            {line.item_type && line.item_type !== 'PRODUCT' && (
                              <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium align-middle ${
                                line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                              }`}>
                                {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                              </span>
                            )}
                          </span>
                        )}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="text" value={line.description || ''} onChange={(e) => handleLineChange(idx, 'description', e.target.value)} className={inputClass} style={{ minWidth: '140px' }} />
                        ) : (<span className="text-slate-500">{line.description || '-'}</span>)}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" value={line.quantity || ''} readOnly className={`${inputClass} bg-slate-50 cursor-not-allowed`} style={{ minWidth: '90px' }} title="Quantity cannot be changed. Bill quantity must match the linked Receipt quantity." onClick={() => toast.error('Quantity cannot be changed. Bill quantity must match the linked Receipt quantity.')} />
                        ) : (<span className="text-right block">{line.quantity}</span>)}</td>
                        <td className="px-3 py-2 text-right">
                          {(() => {
                            const diff = getDiffQty(line);
                            if (diff === null) return <span className="text-slate-400">-</span>;
                            const cls = diff > 0 ? 'text-red-600' : diff < 0 ? 'text-amber-600' : 'text-emerald-600';
                            return <span className={`font-medium ${cls}`}>{diff.toFixed(2)}</span>;
                          })()}
                        </td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="text" value={line.uom || ''} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} />
                        ) : (line.uom || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" value={line.rate || ''} readOnly className={`${inputClass} bg-slate-50 cursor-not-allowed`} style={{ minWidth: '90px' }} title="Unit price cannot be changed. It must match the linked Purchase Order price." onClick={() => toast.error('Unit price cannot be changed. It must match the linked Purchase Order price.')} />
                        ) : (<span className="text-right block">{fmt(line.rate)}</span>)}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.discount_percent || ''} onChange={(e) => handleLineChange(idx, 'discount_percent', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} />
                        ) : (<span className="text-right block">{line.discount_percent}%</span>)}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.tax_percent || ''} onChange={(e) => handleLineChange(idx, 'tax_percent', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} />
                        ) : (<span className="text-right block">{line.effective_tax_percent ?? line.tax_percent}%{line.tax_percent_derived && <span className="text-slate-400" title="Derived from the bill's total GST — not captured per line">*</span>}</span>)}</td>
                        <td className="px-3 py-2 text-right font-medium">{fmt(line.amount)}</td>
                        {isEditing && (
                          <td className="px-3 py-2">
                            <button onClick={() => handleRemoveLine(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            );
          })()}
        </div>

        {/* Documents / notes + totals, side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 sm:gap-3 items-stretch">
          {/* Left: Attachments / Additional Information as switchable tabs */}
          <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200">
            <div className="flex items-center gap-1 border-b border-slate-200 px-2">
              {[['attachments', 'Attachments'], ['info', 'Additional Information']].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setInfoTab(k)}
                  className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px ${infoTab === k ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{l}</button>
              ))}
            </div>
            <div className="p-3 sm:p-4">
              {infoTab === 'attachments' && <FileAttachments module="BILL" recordId={id} showPreview />}
              {infoTab === 'info' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {!isHidden('terms_and_conditions') && (
                  <div>
                    <h4 className="text-sm font-semibold text-slate-700 mb-1">Terms &amp; Conditions</h4>
                    {isEditing ? (
                      <textarea name="terms_and_conditions" value={editData.terms_and_conditions || ''} onChange={handleEditChange} rows={2} disabled={isReadOnly('terms_and_conditions')} className={isReadOnly('terms_and_conditions') ? lockedInputClass : inputClass} />
                    ) : (
                      <p className="text-sm text-slate-600 whitespace-pre-wrap">{bill.terms_and_conditions || '-'}</p>
                    )}
                  </div>
                  )}
                  {!isHidden('notes') && (
                  <div>
                    <h4 className="text-sm font-semibold text-slate-700 mb-1">Notes</h4>
                    {isEditing ? (
                      <textarea name="notes" value={editData.notes || ''} onChange={handleEditChange} rows={2} disabled={isReadOnly('notes')} className={isReadOnly('notes') ? lockedInputClass : inputClass} />
                    ) : (
                      <p className="text-sm text-slate-600 whitespace-pre-wrap">{bill.notes || '-'}</p>
                    )}
                  </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right: Amount Summary */}
          <div className="lg:col-span-1 h-full">
        {/* Amount Summary */}
        <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 h-full">
          <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2">Amount Summary</h3>
          <div className="flex flex-col gap-3">
          <div className="w-full space-y-2 text-sm">
            {isEditing ? (() => {
              // Live totals while editing. Tax is AUTO from each line's Tax% (the
              // same formula handleSave uses), so the figures here match what will
              // be saved; Round-off/Adjustment is the only typed field — set it to
              // 0 to clear a bogus AI round-off once the line Tax% is correct.
              const n = (x) => parseFloat(x) || 0;
              const ls = editLines || [];
              const sub = ls.reduce((s, l) => s + n(l.quantity) * n(l.rate), 0);
              const disc = ls.reduce((s, l) => { const b = n(l.quantity) * n(l.rate); return s + b * n(l.discount_percent) / 100; }, 0);
              const tax = ls.reduce((s, l) => { const b = n(l.quantity) * n(l.rate); return s + (b - b * n(l.discount_percent) / 100) * n(l.tax_percent) / 100; }, 0);
              const ship = n(editData.shipping_charges), adj = n(editData.adjustment), tds = n(editData.tds_amount);
              const total = sub - disc + tax + ship + adj - tds;
              return (
                <>
                  <div className="flex justify-between"><span className="text-slate-600">Subtotal:</span><span>{fmt(sub)}</span></div>
                  {disc > 0 && <div className="flex justify-between text-red-600"><span>Discount:</span><span>-{fmt(disc)}</span></div>}
                  <div className="flex justify-between"><span className="text-slate-600">Tax <span className="text-[10px] text-slate-400">(auto from line Tax%)</span>:</span><span>{fmt(tax)}</span></div>
                  {ship > 0 && <div className="flex justify-between"><span className="text-slate-600">Shipping:</span><span>{fmt(ship)}</span></div>}
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-slate-600 whitespace-nowrap">Round-off / Adjustment:</span>
                    <input type="number" step="0.01" name="adjustment" value={editData.adjustment ?? ''} onChange={handleEditChange}
                      className="w-28 px-2 py-1 border border-slate-300 rounded text-sm text-right" />
                  </div>
                  <p className="text-[11px] text-slate-400 leading-snug">Tax auto-recomputes from each line&apos;s Tax% on save. If the AI stored a wrong tax and left a bogus round-off, set this to 0 — the Total updates live.</p>
                  {tds > 0 && <div className="flex justify-between text-amber-600"><span>Less: TDS:</span><span>- {fmt(tds)}</span></div>}
                  <div className="flex justify-between pt-2 border-t font-bold text-base"><span>Total:</span><span>{fmt(total)}</span></div>
                </>
              );
            })() : (<>
            {!isHidden('subtotal') && <div className="flex justify-between"><span className="text-slate-600">Subtotal:</span><span>{fmt(bill.subtotal)}</span></div>}
            {!isHidden('discount_amount') && Number(bill.discount_amount) > 0 && <div className="flex justify-between text-red-600"><span>Discount:</span><span>-{fmt(bill.discount_amount)}</span></div>}
            {!isHidden('tax_amount') && Number(bill.tax_amount) > 0 && (() => {
              const g = bill.gst_split || {};
              const note = g.derived ? <span className="text-[10px] text-slate-400 ml-1" title="Classified from the bill total by place of supply (vendor state vs company state), since this bill stored only the combined GST">(derived)</span> : null;
              if (g.basis === 'intra') return (<>
                <div className="flex justify-between"><span className="text-slate-600">CGST:{note}</span><span>{fmt(g.cgst)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600">SGST:</span><span>{fmt(g.sgst)}</span></div>
              </>);
              if (g.basis === 'inter') return (
                <div className="flex justify-between"><span className="text-slate-600">IGST:{note}</span><span>{fmt(g.igst)}</span></div>
              );
              return <div className="flex justify-between"><span className="text-slate-600">Tax (GST):</span><span>{fmt(bill.tax_amount)}</span></div>;
            })()}
            {Number(bill.shipping_charges) > 0 && <div className="flex justify-between"><span className="text-slate-600">Shipping:</span><span>{fmt(bill.shipping_charges)}</span></div>}
            {/* Non-product charges carried on the invoice (freight, packing, …).
                Shown per charge with its own label when the breakdown is there,
                otherwise as one combined "Other charges" line. */}
            {(bill.additional_charges || []).length > 0
              ? bill.additional_charges.map((c, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-slate-600">
                    {String(c.type).toUpperCase() === 'FREIGHT' ? 'Freight charge' : 'Other charge'}
                    {c.label && c.label !== 'Freight charge' && c.label !== 'Other charge'
                      ? <span className="text-slate-400"> · {c.label}</span> : null}
                    :
                  </span>
                  <span>{fmt(c.amount)}</span>
                </div>
              ))
              : Number(bill.other_charges) > 0 && (
                <div className="flex justify-between"><span className="text-slate-600">Other charges:</span><span>{fmt(bill.other_charges)}</span></div>
              )}
            {/* TDS baked into a net total shows on its OWN line (not swept into
                "Round off"). The residual that remains after removing recorded TDS
                is the genuine rounding. */}
            {amt(bill.tds_amount) > 0 && (
              <div className="flex justify-between"><span className="text-slate-600">TDS:</span><span>{fmt(-amt(bill.tds_amount))}</span></div>
            )}
            {(() => {
              // total = grossParts − TDS + adjustment + rounding. Remove the TDS
              // we now show separately, so only true rounding is left here.
              const roundOff = Math.round((amt(bill.total_amount) - grossParts + amt(bill.adjustment) + amt(bill.tds_amount)) * 100) / 100;
              return Math.abs(roundOff) >= 0.01
                ? <div className="flex justify-between"><span className="text-slate-600">Round off:</span><span>{fmt(roundOff)}</span></div>
                : null;
            })()}
            {!isHidden('total_amount') && <div className="flex justify-between pt-2 border-t font-bold text-base"><span>Total:</span><span>{fmt(bill.total_amount)}</span></div>}
            <div className="flex justify-between text-green-600"><span>Paid:</span><span>{fmt(bill.amount_paid)}</span></div>
            {/* TDS withheld on this bill lowers what the VENDOR is still owed even
                though no cash was paid to them (it's remitted to the govt). Show it
                here so Balance Due < Total reads clearly as Total − TDS − Paid,
                rather than looking like an unexplained gap. Only when the TDS isn't
                already baked into the total and isn't shown in the breakdown above. */}
            {!tdsInTotal && tdsVal > 0 && !(amt(bill.tds_amount) > 0) && (
              <div className="flex justify-between text-amber-600">
                <span>Less: TDS (to govt):</span><span>- {fmt(tdsVal)}</span>
              </div>
            )}
            <div className={`flex justify-between font-bold text-base ${netDue > 0 ? 'text-red-600' : 'text-green-600'}`}>
              <span>Balance Due:</span><span>{fmt(netDue)}</span>
            </div>
            {/* The engine's reporting-only ESTIMATE used to show here and compared
                against the sparsely-filled on-bill tds_amount (almost always 0),
                so it falsely read "≠ deducted ₹0" even when TDS WAS deducted. The
                actual TDS now lives in the TDS withheld line above + the "TDS
                Deducted" detail section below — both from Tally's TDS Payable — so
                that misleading estimate line is removed. */}
            </>)}
          </div>
          {/* Freight tracked for this bill (invoice-included freight mirrored
              into the freight register) — a Payment-style card beside the totals,
              matching the Sales Invoice. Paid follows the bill: goods first,
              freight last. */}
          {(bill.invoice_freight || []).length > 0 && (
            <div className="w-full space-y-3">
              {bill.invoice_freight.map((f) => {
                const billed = Number(f.billed) || 0;
                const paid = Number(f.paid) || 0;
                const pct = billed > 0 ? Math.min(100, Math.max(0, (paid / billed) * 100)) : 0;
                const st = String(f.status_display || f.status || '').toLowerCase();
                const badge = (st.includes('paid') && !st.includes('part'))
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : st.includes('part') ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-slate-100 text-slate-600 border-slate-200';
                return (
                  <div key={f.id} className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-4">
                    <div className="flex items-center justify-between gap-2 mb-2.5">
                      <h3 className="text-sm font-semibold text-slate-900">Freight{Number(f.covered_count) > 1 ? ' (shared)' : ''}</h3>
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold border ${badge}`}>{f.status_display || f.status || '—'}</span>
                    </div>
                    {Number(f.covered_count) > 1 && (
                      <p className="mb-2 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">🚚 One slip shared across {f.covered_count} bills — paid once</p>
                    )}
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-[width] duration-300" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-1.5 text-[11px] text-slate-400 tabular-nums">{Math.round(pct)}% paid</p>
                    <div className="mt-3 space-y-1.5 text-sm">
                      {Number(f.freight_amount) > 0 && (
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-500">Freight</span>
                          <span className="font-semibold text-slate-800 tabular-nums">{fmt(f.freight_amount)}</span>
                        </div>
                      )}
                      {Number(f.tds) > 0 && (
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-500">TDS</span>
                          <span className="font-medium text-slate-500 tabular-nums">− {fmt(f.tds)}</span>
                        </div>
                      )}
                      {/* Round-off — editable: type it and blur to save; payable
                          recomputes as Freight − TDS − Round-off. */}
                      <div className="flex justify-between gap-3 items-center">
                        <span className="text-slate-500">Round-off</span>
                        <input
                          key={`ro-${f.id}-${f.roundoff}`}
                          type="number" step="0.01" defaultValue={Number(f.roundoff) || 0}
                          onBlur={(e) => { if (Number(e.target.value) !== Number(f.roundoff)) saveFreightRoundoff(f, e.target.value); }}
                          title="Positive reduces the payable, negative adds"
                          className="w-20 text-right tabular-nums border border-slate-300 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">Payable</span>
                        <span className="font-semibold text-slate-800 tabular-nums">{fmt(f.billed)}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">Paid</span>
                        <span className="font-semibold text-emerald-700 tabular-nums">{fmt(f.paid)}</span>
                      </div>
                      <div className="flex justify-between gap-3 border-t border-slate-100 pt-1.5">
                        <span className="text-slate-500">Pending</span>
                        <span className={`font-semibold tabular-nums ${Number(f.pending) > 0 ? 'text-rose-600' : 'text-slate-500'}`}>{fmt(f.pending)}</span>
                      </div>
                    </div>
                    {(f.lorry_no || f.freight_no) && (
                      <p className="mt-2 text-[11px] text-slate-400 truncate">
                        {f.lorry_no ? `🚛 ${f.lorry_no}` : ''}{f.lorry_no && f.freight_no ? ' · ' : ''}{f.freight_no ? `#${f.freight_no}` : ''}
                      </p>
                    )}
                    <Link to={`/freight/purchase/${f.id}`} className="mt-3 inline-block text-xs font-medium text-indigo-600 hover:underline">{f.advice_no} →</Link>
                  </div>
                );
              })}
            </div>
          )}
          {/* Separate-slip freight mapped to THIS bill (Scan/Email) — attached
              here instead of raising a Freight Advice, so it won't appear in
              invoice_freight above. Show it so the bill visibly says "freight
              attached", with the amount + transporter. The slip document itself
              is in the Documents section below. */}
          {(bill.attached_freight || []).length > 0 && (
            <div className="w-full space-y-3">
              {bill.attached_freight.map((f) => (
                <div key={f.id} className="bg-teal-50 rounded-lg border border-teal-200 p-3.5 sm:p-4">
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <h3 className="text-sm font-semibold text-teal-900">🚚 Freight attached</h3>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border bg-teal-100 text-teal-700 border-teal-200 uppercase">{f.source}</span>
                  </div>
                  <div className="space-y-1.5 text-sm">
                    {f.transporter_name && (
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">Transporter</span>
                        <span className="font-medium text-slate-800 text-right">{f.transporter_name}</span>
                      </div>
                    )}
                    {f.invoice_no && (
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">Freight bill</span>
                        <span className="font-medium text-slate-800 tabular-nums">{f.invoice_no}</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-3">
                      <span className="text-slate-500">Amount</span>
                      <span className="font-semibold text-slate-900 tabular-nums">{fmt(f.amount)}</span>
                    </div>
                    {Number(f.tds) > 0 && (
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">TDS</span>
                        <span className="font-medium text-slate-700 tabular-nums">{fmt(f.tds)}</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-2.5 text-[11px] text-teal-700/80">Freight slip attached to this bill — see Documents below.</p>
                </div>
              ))}
            </div>
          )}
          </div>
        </div>
          </div>
        </div>

        {/* TDS block removed from the bill detail page (shown elsewhere, not here). */}

        {/* Payment History */}
        {(bill.payment_history || []).length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2">Payment History</h3>

            {/* Mobile: one compact card per payment (the 6-col table
                overflowed/overlapped on phones). */}
            <div className="sm:hidden space-y-2">
              {bill.payment_history.map((p, idx) => (
                <button
                  key={p.id || idx}
                  // p.id is on every payment_history row (the serializer emits
                  // it); this went to the LIST, which then looked like a search
                  // landing on the wrong page. Falls back to the list only when
                  // a row genuinely has no id.
                  onClick={() => navigate(p.id ? `/purchase/payments-made/${p.id}` : '/purchase/payments-made',
                    { state: { backTo: `/purchase/bills/${bill.id}` } })}
                  className="w-full text-left bg-white border border-slate-200 rounded-lg p-3 active:bg-slate-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-primary-600 truncate">{p.payment_no}</span>
                    <span className="text-sm font-bold text-slate-900 shrink-0">{fmt(p.amount)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <span className="text-xs text-slate-500 truncate">{fmtDate(p.payment_date)} · {p.payment_mode}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  {p.reference_no && <p className="text-xs text-slate-500 mt-1 break-words">Ref: {p.reference_no}</p>}
                </button>
              ))}
            </div>

            {/* Desktop: full table, horizontally scrollable if needed. */}
            <div className="hidden sm:block overflow-x-auto ios-scroll touch-pan-x">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Payment No</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Date</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Mode</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Reference</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.payment_history.map((p, idx) => (
                    <tr key={p.id || idx} className="border-b hover:bg-primary-50/40 transition-colors cursor-pointer"
                      onClick={() => navigate(p.id ? `/purchase/payments-made/${p.id}` : '/purchase/payments-made',
                        { state: { backTo: `/purchase/bills/${bill.id}` } })}>
                      <td className="px-3 py-2 text-primary-600 font-medium">{p.payment_no}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(p.payment_date)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmt(p.amount)}</td>
                      <td className="px-3 py-2">{p.payment_mode}</td>
                      <td className="px-3 py-2">{p.reference_no || '-'}</td>
                      <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Advance Payment History */}
        {vendorAdvances.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2">Advance Payment History</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Credit No</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Date</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Type</th>
                  <th className="text-right px-3 py-2 font-medium text-slate-600">Total Amount</th>
                  <th className="text-right px-3 py-2 font-medium text-slate-600">Applied</th>
                  <th className="text-right px-3 py-2 font-medium text-slate-600">Balance</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {vendorAdvances.map((adv, idx) => (
                  <tr key={adv.id || idx} className="border-b hover:bg-primary-50/40 transition-colors cursor-pointer" onClick={() => navigate(`/purchase/vendor-credits/${adv.id}`)}>
                    <td className="px-3 py-2 text-primary-600 font-medium">{adv.credit_no}</td>
                    <td className="px-3 py-2">{fmtDate(adv.credit_date)}</td>
                    <td className="px-3 py-2">{adv.credit_type_display || adv.credit_type}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmt(adv.total_amount)}</td>
                    <td className="px-3 py-2 text-right text-green-600">{fmt(adv.amount_applied)}</td>
                    <td className="px-3 py-2 text-right">{fmt(Number(adv.total_amount || 0) - Number(adv.amount_applied || 0))}</td>
                    <td className="px-3 py-2"><StatusBadge status={adv.status_display || adv.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Notes & Terms now live in the Additional Information tab above. */}
      </div>

      {/* Apply Credit / Debit / Advance Modal — title and copy follow
          creditModalType so each of the three header buttons opens its
          own focused dialog. */}
      {creditModalType && (() => {
        const typeLabel = creditModalType === 'DEBIT' ? 'Debit Note'
          : creditModalType === 'CREDIT' ? 'Credit Note'
          : 'Advance';
        const closeModal = () => { setCreditModalType(null); setSelectedCredit(''); setCreditAmount(''); };
        return (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={closeModal}>
            <div className="bg-white rounded-xl shadow-xl p-3 sm:p-4 w-full max-w-lg" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Apply credit to bill">
              <h3 className="text-lg font-bold text-slate-800 mb-1">Apply {typeLabel} to Bill</h3>
              <p className="text-xs text-slate-500 mb-3">Vendor: <strong>{bill.vendor_name}</strong> — showing approved {typeLabel.toLowerCase()}s only</p>
              <p className="text-sm text-slate-600 mb-4">Balance Due: <strong className="text-red-600">₹{balanceDue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></p>

              {availableCredits.length === 0 ? (
                <div className="text-center py-4 sm:py-6">
                  <p className="text-slate-500">No approved {typeLabel.toLowerCase()}s available for this vendor.</p>
                  <p className="text-xs text-slate-400 mt-1">Draft entries must be approved on the Vendor Credit detail page before they appear here.</p>
                  <button onClick={closeModal} className="mt-3 text-sm text-primary-600 hover:underline">Close</button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-0.5">Select {typeLabel}</label>
                    <CustomSelect value={selectedCredit} onChange={e => {
                      setSelectedCredit(e.target.value);
                      const cr = availableCredits.find(c => c.id === e.target.value);
                      if (cr) setCreditAmount(Math.min(cr.balance, balanceDue).toFixed(2));
                    }} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm">
                      <option value="">Select...</option>
                      {availableCredits.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.credit_no} — Balance: ₹{c.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </option>
                      ))}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-0.5">Amount to Apply</label>
                    <input type="number" step="0.01" min="0" value={creditAmount} onChange={e => setCreditAmount(e.target.value)} className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm" />
                  </div>
                  <div className="flex justify-end gap-3">
                    <button onClick={closeModal} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
                    <button disabled={!selectedCredit || !creditAmount || isApplyingCredit} onClick={async () => {
                      setIsApplyingCredit(true);
                      try {
                        await apiClient.post(`/api/purchase/vendor-credits/${selectedCredit}/apply-to-bill/`, {
                          bill_id: id,
                          amount: creditAmount,
                        });
                        toast.success(`${typeLabel} applied to bill!`);
                        closeModal();
                        fetchBill();
                      } catch (err) {
                        toast.error(err.response?.data?.error || 'Failed to apply');
                      } finally {
                        setIsApplyingCredit(false);
                      }
                    }} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
                      {isApplyingCredit ? 'Applying...' : 'Apply'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* FileAttachments now render in the Attachments tab above. */}

      {/* Expense Bill — quick CREDIT expense against this bill's vendor */}
      <Modal isOpen={showExpenseModal} onClose={() => setShowExpenseModal(false)} title="Expense Bill" footer={
        <>
          <button onClick={() => setShowExpenseModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
          <button onClick={handleSaveExpenseBill} disabled={expBillSaving} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{expBillSaving ? 'Saving…' : 'Book to Credit'}</button>
        </>
      }>
        <div className="space-y-3">
          <p className="text-xs text-slate-500">Books a credit expense to <span className="font-medium text-slate-700">{bill.vendor_name}</span> in Expenses → Expense Register.</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">Date</label>
              <CustomDatePicker value={expBill.date} onChange={(d) => setExpBill((p) => ({ ...p, date: d }))} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-0.5">Amount <span className="text-red-500">*</span></label>
              <input type="number" step="0.01" value={expBill.amount} onChange={(e) => setExpBill((p) => ({ ...p, amount: e.target.value }))} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="0.00" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-0.5">Expense <span className="text-red-500">*</span></label>
            <input value={expBill.title} onChange={(e) => setExpBill((p) => ({ ...p, title: e.target.value }))} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="What was bought" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-0.5">Description</label>
            <textarea value={expBill.description} onChange={(e) => setExpBill((p) => ({ ...p, description: e.target.value }))} rows={2} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-none" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-0.5">Attachment</label>
            <input type="file" onChange={(e) => setExpBillFile(e.target.files?.[0] || null)} className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-slate-100 file:text-slate-700" />
          </div>
        </div>
      </Modal>

      {/* Zoho bill photo — opens in-page, click backdrop or ✕ to close. */}
      {photo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={closePhoto}>
          <div className="relative bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[92dvh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 sticky top-0 bg-white">
              <span className="text-sm font-semibold text-slate-700">{photo.label} — {bill.bill_no}</span>
              <div className="flex items-center gap-2">
                {photo.url && <a href={photo.url} download={`${bill.bill_no}-${photo.kind}.jpg`} className="text-xs text-indigo-600 hover:text-indigo-800">Download</a>}
                <button onClick={closePhoto} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close photo"><X size={18} /></button>
              </div>
            </div>
            <div className="p-3 min-h-[220px] flex items-center justify-center">
              {photo.loading && <div className="text-slate-500 text-sm">Loading photo…</div>}
              {photo.error && <div className="text-amber-600 text-sm">{photo.error}</div>}
              {photo.url && <img src={photo.url} alt={photo.label} className="max-w-full max-h-[78dvh] object-contain" />}
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
