import { useEffect, useState, useMemo } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatsCard from '../../../components/common/StatsCard';
import Modal from '@/components/ui/Modal';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import toast from 'react-hot-toast';
import { Plus, Trash2, Paperclip, HandCoins, AlertCircle } from 'lucide-react';

const today = () => new Date().toISOString().slice(0, 10);
const MODES = ['CASH', 'BANK', 'UPI', 'CHEQUE', 'OTHER'];
const blankLine = () => ({ name: '', category: '', quantity: '', unit_price: '', is_stock_item: false, consumable_item: '' });
const lineAmount = (l) => {
  const price = Number(l.unit_price) || 0;
  return l.quantity !== '' && l.quantity != null ? (Number(l.quantity) || 0) * price : price;
};

export default function ExpenseRegisterPage() {
  const { canCreate } = usePermissions();
  const expenses = useApiData('/api/expenses/register/');
  const funds = useApiData('/api/expenses/funds/');
  const consumables = useApiData('/api/expenses/consumables/');
  const categories = useApiData('/api/expense-categories/');

  const [credit, setCredit] = useState({ rows: [], total_outstanding: 0 });
  const loadCredit = async () => {
    try {
      const res = await apiClient.get('/api/expenses/register/credit-summary/');
      setCredit(res.data);
    } catch { /* non-fatal */ }
  };
  useEffect(() => { loadCredit(); }, []);

  const [expModal, setExpModal] = useState(false);
  const [payModal, setPayModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);
  const [file, setFile] = useState(null);
  const [payForm, setPayForm] = useState({ party_name: '', payment_date: today(), amount: '', mode: 'CASH', reference: '' });

  const openExpense = () => {
    setForm({ expense_date: today(), title: '', description: '', payment_method: 'CREDIT', fund: '', party_name: '', items: [blankLine()] });
    setFile(null);
    setExpModal(true);
  };

  const total = useMemo(() => (form?.items || []).reduce((s, l) => s + lineAmount(l), 0), [form]);

  // Voucher overdraft guard (mirrors the backend): a voucher can't spend more
  // than the chosen fund holds. Exact balance is allowed.
  const selectedFund = (form?.payment_method === 'VOUCHER' && form?.fund)
    ? (funds.data || []).find((f) => String(f.id) === String(form.fund)) : null;
  const fundBalance = selectedFund ? Number(selectedFund.balance || 0) : null;
  const voucherOver = selectedFund != null && total > fundBalance;

  const setLine = (i, field, value) => setForm((p) => {
    const items = [...p.items];
    items[i] = { ...items[i], [field]: value };
    return { ...p, items };
  });

  const saveExpense = async () => {
    if (!form.title.trim()) { toast.error('Enter an expense title'); return; }
    if (form.payment_method === 'VOUCHER' && !form.fund) { toast.error('Select the fund the voucher is paid from'); return; }
    if (voucherOver) { toast.error(`Voucher total exceeds the fund balance of ${formatCurrency(fundBalance)}. Record a top-up first.`); return; }
    if (form.payment_method === 'CREDIT' && !form.party_name.trim()) { toast.error('Enter the vendor/shop the credit is owed to'); return; }
    const items = form.items.filter((l) => l.name.trim());
    if (items.length === 0) { toast.error('Add at least one item'); return; }
    setSaving(true);
    try {
      const payload = {
        expense_date: form.expense_date,
        title: form.title.trim(),
        description: form.description,
        payment_method: form.payment_method,
        fund: form.payment_method === 'VOUCHER' ? form.fund : null,
        party_name: form.payment_method === 'CREDIT' ? form.party_name.trim() : '',
        items: items.map((l) => ({
          name: l.name.trim(),
          category: l.category || null,
          description: '',
          quantity: l.quantity === '' ? null : l.quantity,
          unit_price: l.unit_price || 0,
          is_stock_item: !!l.is_stock_item,
          consumable_item: l.is_stock_item && l.consumable_item ? l.consumable_item : null,
        })),
      };
      const res = await apiClient.post('/api/expenses/register/', payload);
      if (file && res.data?.id) {
        const fd = new FormData();
        fd.append('attachment', file);
        await apiClient.patch(`/api/expenses/register/${res.data.id}/`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      toast.success('Expense recorded');
      setExpModal(false);
      expenses.refetch(); funds.refetch(); consumables.refetch(); loadCredit();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setSaving(false); }
  };

  const savePayment = async () => {
    if (!payForm.party_name.trim()) { toast.error('Enter the party'); return; }
    if (!(Number(payForm.amount) > 0)) { toast.error('Enter an amount'); return; }
    setSaving(true);
    try {
      await apiClient.post('/api/expenses/credit-payments/', { ...payForm });
      toast.success('Payment recorded');
      setPayModal(false);
      setPayForm({ party_name: '', payment_date: today(), amount: '', mode: 'CASH', reference: '' });
      loadCredit();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setSaving(false); }
  };

  const columns = [
    { key: 'expense_no', label: 'No.' },
    { key: 'expense_date', label: 'Date', render: (v) => formatDate(v) },
    { key: 'title', label: 'Expense' },
    { key: 'payment_method_display', label: 'Paid By', render: (v) => (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${v === 'Voucher' ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-700'}`}>{v}</span>
    ) },
    { key: 'party_label', label: 'Party / Fund', render: (v, row) => v || row.fund_name || '—' },
    { key: 'amount', label: 'Amount', render: (v) => <span className="font-medium">{formatCurrency(v)}</span> },
    { key: 'attachment_url', label: '', render: (v) => v ? <a href={v} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-blue-600"><Paperclip size={15} /></a> : null },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Expense Register"
        subtitle="Purchases paid by credit or voucher"
        breadcrumbs={[{ label: 'Expenses' }, { label: 'Expense Register' }]}
        actions={{
          right: canCreate('Expense Register') ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setPayModal(true)} className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50">
                <HandCoins size={15} /> Settle Credit
              </button>
              <button onClick={openExpense} className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
                <Plus size={15} /> New Expense
              </button>
            </div>
          ) : null,
        }}
      />

      {/* Outstanding credit */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <StatsCard icon={AlertCircle} label="Outstanding Credit" value={formatCurrency(credit.total_outstanding)} />
        <div className="lg:col-span-2 bg-white rounded-lg border border-slate-200 p-4">
          <p className="text-sm font-semibold text-slate-700 mb-2">Credit by party</p>
          {credit.rows?.length ? (
            <div className="space-y-1 max-h-40 overflow-auto">
              {credit.rows.filter((r) => Number(r.outstanding) !== 0).map((r, i) => (
                <div key={i} className="flex items-center justify-between text-sm border-b border-slate-100 py-1">
                  <span className="text-slate-700 truncate">{r.party}</span>
                  <span className={`font-medium ${Number(r.outstanding) > 0 ? 'text-red-600' : 'text-emerald-700'}`}>{formatCurrency(r.outstanding)}</span>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-slate-400">No outstanding credit.</p>}
        </div>
      </div>

      <DataTable persistKey="expenses-register" columns={columns} data={expenses.data || []} isLoading={expenses.isLoading} exportFileName="expense-register" />

      {/* New Expense modal */}
      {form && (
        <Modal isOpen={expModal} onClose={() => setExpModal(false)} title="New Expense" size="lg" footer={
          <>
            <span className="mr-auto text-sm text-slate-600">Total: <span className="font-semibold text-slate-900">{formatCurrency(total)}</span></span>
            <button onClick={() => setExpModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
            <button onClick={saveExpense} disabled={saving || voucherOver} title={voucherOver ? 'Voucher exceeds the fund balance' : undefined} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? 'Saving…' : 'Save Expense'}</button>
          </>
        }>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date"><CustomDatePicker value={form.expense_date} onChange={(d) => setForm((p) => ({ ...p, expense_date: d }))} /></Field>
              <Field label="Paid by" required>
                <CustomSelect name="payment_method" value={form.payment_method} onChange={(e) => setForm((p) => ({ ...p, payment_method: e.target.value }))} className={selectCls}>
                  <option value="CREDIT">Credit</option>
                  <option value="VOUCHER">Voucher</option>
                </CustomSelect>
              </Field>
            </div>
            <Field label="Expense title" required>
              <input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} className={inputCls} placeholder="e.g. Pooja items / Machinery spares" />
            </Field>
            {form.payment_method === 'VOUCHER' ? (
              <Field label="Fund (voucher paid from)" required>
                <CustomSelect name="fund" value={form.fund} onChange={(e) => setForm((p) => ({ ...p, fund: e.target.value }))} className={selectCls}>
                  <option value="">Select fund…</option>
                  {(funds.data || []).map((f) => <option key={f.id} value={f.id}>{f.name} ({formatCurrency(f.balance)})</option>)}
                </CustomSelect>
                {selectedFund && (
                  <p className={`text-xs mt-1.5 ${voucherOver ? 'text-red-600 font-medium' : 'text-slate-500'}`}>
                    {voucherOver
                      ? `Total ${formatCurrency(total)} exceeds the ${formatCurrency(fundBalance)} balance by ${formatCurrency(total - fundBalance)}. Record a top-up first.`
                      : `Available balance: ${formatCurrency(fundBalance)}`}
                  </p>
                )}
              </Field>
            ) : (
              <Field label="Vendor / shop (credit owed to)" required>
                <input value={form.party_name} onChange={(e) => setForm((p) => ({ ...p, party_name: e.target.value }))} className={inputCls} placeholder="e.g. Sri Krishna Traders" />
              </Field>
            )}

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-slate-700">Items</label>
                <button type="button" onClick={() => setForm((p) => ({ ...p, items: [...p.items, blankLine()] }))} className="text-xs text-primary-600 font-medium inline-flex items-center gap-1"><Plus size={13} /> Add item</button>
              </div>
              <div className="space-y-2">
                {form.items.map((l, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-2.5">
                    <div className="mb-2">
                      <CustomSelect name={`category_${i}`} value={l.category} onChange={(e) => setLine(i, 'category', e.target.value)} className={`${selectCls} !py-1.5`}>
                        <option value="">Category… (rolls up for reports / accounting)</option>
                        {(categories.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </CustomSelect>
                    </div>
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <input value={l.name} onChange={(e) => setLine(i, 'name', e.target.value)} placeholder="Item name" className={`col-span-5 ${inputCls}`} />
                      <input type="number" step="0.001" value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} placeholder="Qty" className={`col-span-2 ${inputCls}`} title="Leave blank for price-only (e.g. tea)" />
                      <input type="number" step="0.01" value={l.unit_price} onChange={(e) => setLine(i, 'unit_price', e.target.value)} placeholder="Price" className={`col-span-2 ${inputCls}`} />
                      <span className="col-span-2 text-right text-sm font-medium text-slate-700">{formatCurrency(lineAmount(l))}</span>
                      <button type="button" onClick={() => setForm((p) => ({ ...p, items: p.items.filter((_, j) => j !== i) }))} disabled={form.items.length === 1} className="col-span-1 text-red-400 hover:text-red-600 disabled:opacity-30 flex justify-center"><Trash2 size={15} /></button>
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" checked={l.is_stock_item} onChange={(e) => setLine(i, 'is_stock_item', e.target.checked)} />
                      Add to Consumables stock
                      {l.is_stock_item && (
                        <CustomSelect name={`consumable_${i}`} value={l.consumable_item} onChange={(e) => setLine(i, 'consumable_item', e.target.value)} className={`${selectCls} !py-1 ml-1 min-w-[160px]`}>
                          <option value="">Select consumable…</option>
                          {(consumables.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </CustomSelect>
                      )}
                    </label>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-400">Tip: leave Qty blank for price-only items (tea, pooja). A stock item needs a Qty and a linked consumable.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Description">
                <input value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} className={inputCls} />
              </Field>
              <Field label="Attachment">
                <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-slate-100 file:text-slate-700" />
              </Field>
            </div>
          </div>
        </Modal>
      )}

      {/* Settle Credit modal */}
      <Modal isOpen={payModal} onClose={() => setPayModal(false)} title="Settle Credit" footer={
        <>
          <button onClick={() => setPayModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
          <button onClick={savePayment} disabled={saving} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? 'Saving…' : 'Record Payment'}</button>
        </>
      }>
        <div className="space-y-4">
          <Field label="Party (vendor / shop)" required>
            <input value={payForm.party_name} onChange={(e) => setPayForm((p) => ({ ...p, party_name: e.target.value }))} className={inputCls} list="credit-parties" placeholder="Who you're paying" />
            <datalist id="credit-parties">
              {credit.rows?.map((r, i) => <option key={i} value={r.party} />)}
            </datalist>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><CustomDatePicker value={payForm.payment_date} onChange={(d) => setPayForm((p) => ({ ...p, payment_date: d }))} /></Field>
            <Field label="Amount" required><input type="number" step="0.01" value={payForm.amount} onChange={(e) => setPayForm((p) => ({ ...p, amount: e.target.value }))} className={inputCls} placeholder="0.00" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mode">
              <CustomSelect name="mode" value={payForm.mode} onChange={(e) => setPayForm((p) => ({ ...p, mode: e.target.value }))} className={selectCls}>
                {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </CustomSelect>
            </Field>
            <Field label="Reference"><input value={payForm.reference} onChange={(e) => setPayForm((p) => ({ ...p, reference: e.target.value }))} className={inputCls} /></Field>
          </div>
        </div>
      </Modal>
    </MainLayout>
  );
}

const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const selectCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white';

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}{required && <span className="text-red-500"> *</span>}</label>
      {children}
    </div>
  );
}
