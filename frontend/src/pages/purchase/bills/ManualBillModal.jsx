/**
 * ManualBillModal — inline form for manual bill entry without scanning.
 *
 * Step 1: Company picker + bill type (Purchase / Freight / Expense)
 * Step 2a – Freight:  pick Inward or Outward → /freight/inward/new or /freight/outward/new
 * Step 2b – Purchase: full inline form → POST /api/purchase/bills/ → /purchase/bills/
 * Step 2c – Expense:  full inline form → POST /api/purchase/bills/ (is_expense:true) → /purchase/bills/
 *
 * New vendor / transporter inline create mirrors the scan inbox approach:
 *   POST /api/vendors/ with { vendor_name, company, gst_treatment:'UNREGISTERED' }
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import toast from 'react-hot-toast';
import apiClient from '@/utils/api.js';
import useLookup from '@/hooks/useLookup.js';
import { ShoppingCart, Truck, Receipt, ArrowLeft, ArrowDownLeft, ArrowUpRight, Plus, X, FilePlus2 } from 'lucide-react';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt.toISOString().slice(0, 10); };

const VOUCHER_TYPES = ['GST Purchase', 'GST Purchase-Fruit', 'Purchase-Bought Note', 'Journal', 'GST Journal'];

const PURCHASE_CATEGORIES = [
  ['RM', 'RM Purchase'], ['PACKING', 'Packing Material'], ['FRUIT', 'Fruit Purchase'],
  ['MACHINERY', 'Machinery / Capital'], ['LAB_EXPENSE', 'Lab Expense'],
];

const EXPENSE_CATEGORIES = [
  'Rent', 'Electricity', 'Telephone / Internet', 'Maintenance & Repairs',
  'Stationery', 'Travelling & Conveyance', 'Professional Fees', 'Bank Charges', 'Miscellaneous',
];

const UOM_CHOICES = ['KG', 'LTR', 'PCS', 'MTR', 'MTS', 'BOX', 'PACK', 'SQM', 'CUM'];
const TAX_RATES = ['0', '5', '12', '18', '28'];

const emptyLine = () => ({ description: '', hsn: '', quantity: '1', uom: 'KG', rate: '', tax_percent: '12', amount: '' });

function calcLineAmt(l) {
  const base = (parseFloat(l.quantity) || 0) * (parseFloat(l.rate) || 0);
  return +(base + base * (parseFloat(l.tax_percent) || 0) / 100).toFixed(2);
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-500 mb-1 uppercase tracking-wide">
        {label}{required && <span className="text-rose-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

const inp = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 bg-white';
const fmtMoney = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Inline vendor quick-create (mirrors scan inbox "Create X as vendor" chip) ─
function VendorSelect({ value, onChange, vendors, setVendors, company, label = 'Vendor', required = true }) {
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!newName.trim()) { toast.error('Enter a vendor name'); return; }
    if (!company) { toast.error('Select a company first'); return; }
    setCreating(true);
    try {
      const { data } = await apiClient.post('/api/vendors/', {
        vendor_name: newName.trim(),
        company,
        gst_treatment: 'UNREGISTERED',
      });
      const opt = { value: data.id, label: data.vendor_name };
      setVendors(prev => [...prev, opt]);
      onChange(data.id);
      setNewName('');
      toast.success(`Vendor "${data.vendor_name}" created.`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || err?.response?.data?.vendor_name?.[0] || 'Could not create vendor.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Field label={label} required={required}>
      <CustomSelect value={value || ''} onChange={e => onChange(e.target.value)} className={inp}>
        <option value="">— Select {label} —</option>
        {vendors.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
      </CustomSelect>
      {/* Quick create — same pattern as scan inbox */}
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          className="flex-1 border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-emerald-400 bg-white placeholder:text-slate-400"
          placeholder={`Or type new ${label.toLowerCase()} name…`}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <button
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
          className="text-[11px] bg-emerald-50 text-emerald-700 rounded px-2 py-1 hover:bg-emerald-100 inline-flex items-center gap-1 disabled:opacity-40 whitespace-nowrap border border-emerald-200"
        >
          <FilePlus2 size={11} />
          {creating ? 'Creating…' : `Create as ${label.toLowerCase()}`}
        </button>
      </div>
    </Field>
  );
}

// ── Company bar (shown at top of every step except type picker where it IS the top) ─
function CompanyBar({ company, setCompany, companyOptions }) {
  return (
    <div className="mb-4 pb-4 border-b border-slate-100">
      <Field label="Company" required>
        <div className="flex gap-2">
          {companyOptions.map(c => (
            <button
              key={c.value}
              onClick={() => setCompany(String(c.value))}
              className={`flex-1 py-2 rounded-lg border text-sm font-semibold transition ${
                String(company) === String(c.value)
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
}

// ── Purchase Bill Form ───────────────────────────────────────────────────────
function PurchaseForm({ form, setForm, vendors, setVendors, company, onSubmit, saving, onBack }) {
  const [lines, setLines] = useState([emptyLine()]);

  const setLine = (i, field, val) => {
    setLines(lines.map((l, idx) => {
      if (idx !== i) return l;
      const updated = { ...l, [field]: val };
      updated.amount = String(calcLineAmt(updated));
      return updated;
    }));
  };

  const subtotal = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
  const cgst = +(subtotal * 0.06).toFixed(2);
  const sgst = +(subtotal * 0.06).toFixed(2);
  const total = +(subtotal + cgst + sgst).toFixed(2);

  const handleSubmit = async () => {
    if (!company) { toast.error('Select a company first'); return; }
    if (!form.vendor) { toast.error('Select a vendor'); return; }
    if (!form.bill_date) { toast.error('Bill date is required'); return; }
    if (!form.voucher_type) { toast.error('Purchase type is required'); return; }
    await onSubmit({
      vendor: form.vendor,
      company,
      vendor_invoice_no: form.invoice_no || '',
      bill_date: form.bill_date,
      due_date: form.due_date || addDays(form.bill_date, 15),
      status: 'DRAFT',
      notes: form.notes || '',
      subtotal: subtotal.toFixed(2),
      tax_amount: (cgst + sgst).toFixed(2),
      total_amount: total.toFixed(2),
      purchase_category: form.category || '',
      tds_amount: form.tds || '0',
      bill_lines: lines.filter(l => l.description || l.rate).map(l => ({
        description: l.description, hsn: l.hsn || '', quantity: l.quantity, uom: l.uom,
        rate: l.rate, tax_percent: l.tax_percent, amount: l.amount,
      })),
    });
  };

  return (
    <>
      <div className="space-y-4 py-1">
        <VendorSelect
          value={form.vendor} onChange={v => setForm(f => ({ ...f, vendor: v }))}
          vendors={vendors} setVendors={setVendors} company={company}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Invoice No">
            <input className={inp} placeholder="Vendor's invoice number"
              value={form.invoice_no || ''} onChange={e => setForm(f => ({ ...f, invoice_no: e.target.value }))} />
          </Field>
          <Field label="TDS Deducted (₹)">
            <input className={inp} type="number" placeholder="0" min="0"
              value={form.tds || ''} onChange={e => setForm(f => ({ ...f, tds: e.target.value }))} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bill Date" required>
            <CustomDatePicker value={form.bill_date} onChange={e => setForm(f => ({ ...f, bill_date: e.target.value }))} className={inp} />
          </Field>
          <Field label="Due Date">
            <CustomDatePicker value={form.due_date || ''} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} className={inp} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Purchase Type" required>
            <select className={inp} value={form.voucher_type || ''} onChange={e => setForm(f => ({ ...f, voucher_type: e.target.value }))}>
              <option value="">— select —</option>
              {VOUCHER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Category">
            <select className={inp} value={form.category || ''} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
              <option value="">— auto-classify —</option>
              {PURCHASE_CATEGORIES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
            </select>
          </Field>
        </div>

        {/* Line items */}
        <div>
          <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Line Items</span>
          <div className="mt-2 overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase text-slate-500 border-b bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                  <th className="px-3 py-2">#</th><th className="px-3 py-2">Description</th>
                  <th className="px-2 py-2 w-20">HSN</th>
                  <th className="px-2 py-2 w-16">Qty</th><th className="px-2 py-2 w-16">UOM</th>
                  <th className="px-2 py-2 w-24 text-right">Rate (₹)</th>
                  <th className="px-2 py-2 w-16 text-right">Tax%</th>
                  <th className="px-2 py-2 w-24 text-right">Amount</th>
                  <th className="px-2 py-2 w-6"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b last:border-0 align-middle">
                    <td className="px-3 py-1.5 text-slate-400 text-xs">{i + 1}</td>
                    <td className="px-2 py-1.5">
                      <input className="w-full border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-indigo-400"
                        value={l.description} onChange={e => setLine(i, 'description', e.target.value)} placeholder="Description" />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="w-full border border-slate-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-indigo-400"
                        value={l.hsn || ''} onChange={e => setLine(i, 'hsn', e.target.value)} placeholder="HSN" />
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="w-full border border-slate-200 rounded px-2 py-1 text-sm text-right focus:outline-none focus:border-indigo-400"
                        type="number" min="0" value={l.quantity} onChange={e => setLine(i, 'quantity', e.target.value)} />
                    </td>
                    <td className="px-2 py-1.5">
                      <select className="w-full border border-slate-200 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-indigo-400"
                        value={l.uom} onChange={e => setLine(i, 'uom', e.target.value)}>
                        {UOM_CHOICES.map(u => <option key={u}>{u}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input className="w-full border border-slate-200 rounded px-2 py-1 text-sm text-right focus:outline-none focus:border-indigo-400"
                        type="number" min="0" placeholder="0.00" value={l.rate} onChange={e => setLine(i, 'rate', e.target.value)} />
                    </td>
                    <td className="px-2 py-1.5">
                      <select className="w-full border border-slate-200 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-indigo-400"
                        value={l.tax_percent} onChange={e => setLine(i, 'tax_percent', e.target.value)}>
                        {TAX_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-right font-medium text-slate-700 text-sm">
                      {l.amount ? `₹${fmtMoney(l.amount)}` : '—'}
                    </td>
                    <td className="px-1 py-1.5">
                      {lines.length > 1 && (
                        <button onClick={() => setLines(lines.filter((_, j) => j !== i))}
                          className="text-slate-300 hover:text-red-400"><X size={13} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={() => setLines([...lines, emptyLine()])}
            className="mt-2 flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium">
            <Plus size={12} /> Add Line
          </button>
        </div>

        {/* Summary */}
        <div className="bg-slate-50 rounded-lg p-4 text-sm space-y-1.5">
          <div className="flex justify-between text-slate-600"><span>Subtotal (Excl. GST)</span><span className="font-medium">₹{fmtMoney(subtotal)}</span></div>
          <div className="flex justify-between text-slate-500 text-xs"><span>CGST (6%)</span><span>₹{fmtMoney(cgst)}</span></div>
          <div className="flex justify-between text-slate-500 text-xs"><span>SGST (6%)</span><span>₹{fmtMoney(sgst)}</span></div>
          <div className="flex justify-between font-semibold border-t border-slate-200 pt-1.5 mt-1"><span>Total (Incl. GST)</span><span>₹{fmtMoney(total)}</span></div>
          {parseFloat(form.tds) > 0 && (
            <div className="flex justify-between text-xs text-amber-700"><span>TDS Deducted</span><span>−₹{fmtMoney(form.tds)}</span></div>
          )}
        </div>

        <Field label="Notes">
          <textarea className={`${inp} resize-none`} rows={2} placeholder="Internal notes…"
            value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>
      <div className="flex items-center justify-between pt-4 border-t border-slate-100 mt-4">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft size={14} /> Back
        </button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={handleSubmit}>Save as Draft</Button>
        </div>
      </div>
    </>
  );
}

// ── Freight Direction Picker ─────────────────────────────────────────────────
function FreightDirectionPicker({ onPick, onBack }) {
  return (
    <>
      <p className="text-sm text-slate-500 mb-4">Select freight direction:</p>
      <div className="flex flex-col gap-3">
        <button onClick={() => onPick('inward')}
          className="flex items-start gap-4 rounded-xl border border-slate-200 p-4 text-left hover:border-amber-400 hover:bg-amber-50 transition group">
          <span className="mt-0.5 inline-flex shrink-0 items-center justify-center rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-amber-700">
            <ArrowDownLeft size={20} />
          </span>
          <div className="min-w-0">
            <div className="font-semibold text-slate-800 group-hover:text-amber-700 transition-colors">Inward Freight</div>
            <div className="text-sm text-slate-500 mt-0.5">Goods coming into your warehouse — transporter bill for inbound lorries.</div>
            <div className="text-[11px] text-slate-400 mt-1.5">Opens → Freight Inward creation page (new transporter can be created there)</div>
          </div>
          <span className="ml-auto shrink-0 self-center text-slate-300 group-hover:text-amber-400 text-xl">›</span>
        </button>
        <button onClick={() => onPick('outward')}
          className="flex items-start gap-4 rounded-xl border border-slate-200 p-4 text-left hover:border-blue-400 hover:bg-blue-50 transition group">
          <span className="mt-0.5 inline-flex shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-blue-700">
            <ArrowUpRight size={20} />
          </span>
          <div className="min-w-0">
            <div className="font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">Outward Freight</div>
            <div className="text-sm text-slate-500 mt-0.5">Goods going out to customers — dispatch freight, delivery charges.</div>
            <div className="text-[11px] text-slate-400 mt-1.5">Opens → Freight Outward creation page</div>
          </div>
          <span className="ml-auto shrink-0 self-center text-slate-300 group-hover:text-blue-400 text-xl">›</span>
        </button>
        <button onClick={() => onPick('local')}
          className="flex items-start gap-4 rounded-xl border border-slate-200 p-4 text-left hover:border-indigo-400 hover:bg-indigo-50 transition group">
          <span className="mt-0.5 inline-flex shrink-0 items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50 p-2.5 text-indigo-700">
            <Truck size={20} />
          </span>
          <div className="min-w-0">
            <div className="font-semibold text-slate-800 group-hover:text-indigo-700 transition-colors">Local Freight</div>
            <div className="text-sm text-slate-500 mt-0.5">Internal DC / branch transfers, local delivery — freight not tied to inward or outward.</div>
            <div className="text-[11px] text-slate-400 mt-1.5">Opens → Local Freight creation page</div>
          </div>
          <span className="ml-auto shrink-0 self-center text-slate-300 group-hover:text-indigo-400 text-xl">›</span>
        </button>
      </div>
      <div className="pt-4 border-t border-slate-100 mt-4">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft size={14} /> Back to bill type
        </button>
      </div>
    </>
  );
}

// ── Expense Bill Form ────────────────────────────────────────────────────────
function ExpenseForm({ form, setForm, vendors, setVendors, company, onSubmit, saving, onBack }) {
  const amount = parseFloat(form.amount) || 0;
  const taxRate = parseFloat(form.tax_rate || '18');
  const tax = amount * taxRate / 100;
  const total = +(amount + tax).toFixed(2);

  const handleSubmit = async () => {
    if (!company) { toast.error('Select a company first'); return; }
    if (!form.vendor) { toast.error('Select a vendor / payee'); return; }
    if (!form.amount) { toast.error('Amount is required'); return; }
    if (!form.bill_date) { toast.error('Bill date is required'); return; }
    await onSubmit({
      vendor: form.vendor,
      company,
      vendor_invoice_no: form.invoice_no || '',
      bill_date: form.bill_date,
      due_date: form.due_date || addDays(form.bill_date, 15),
      status: 'DRAFT',
      is_expense: true,
      purchase_category: 'EXPENSES',
      notes: form.notes || '',
      subtotal: amount.toFixed(2),
      tax_amount: tax.toFixed(2),
      total_amount: total.toFixed(2),
      tds_amount: form.tds || '0',
      bill_lines: [],
    });
  };

  return (
    <>
      <div className="space-y-4 py-1">
        <VendorSelect
          value={form.vendor} onChange={v => setForm(f => ({ ...f, vendor: v }))}
          vendors={vendors} setVendors={setVendors} company={company}
          label="Vendor / Payee"
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Invoice / Ref No">
            <input className={inp} placeholder="Vendor invoice number"
              value={form.invoice_no || ''} onChange={e => setForm(f => ({ ...f, invoice_no: e.target.value }))} />
          </Field>
          <Field label="TDS Deducted (₹)">
            <input className={inp} type="number" min="0" placeholder="0"
              value={form.tds || ''} onChange={e => setForm(f => ({ ...f, tds: e.target.value }))} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bill Date" required>
            <CustomDatePicker value={form.bill_date} onChange={e => setForm(f => ({ ...f, bill_date: e.target.value }))} className={inp} />
          </Field>
          <Field label="Due Date">
            <CustomDatePicker value={form.due_date || ''} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} className={inp} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Expense Head" required>
            <select className={inp} value={form.expense_head || ''} onChange={e => setForm(f => ({ ...f, expense_head: e.target.value }))}>
              <option value="">— Select expense head —</option>
              {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Department / Cost Centre">
            <input className={inp} placeholder="e.g. Factory, Admin, Sales"
              value={form.department || ''} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (Excl. GST) (₹)" required>
            <input className={inp} type="number" min="0" placeholder="0.00"
              value={form.amount || ''} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
          </Field>
          <Field label="GST Rate">
            <select className={inp} value={form.tax_rate || '18'} onChange={e => setForm(f => ({ ...f, tax_rate: e.target.value }))}>
              {TAX_RATES.map(r => <option key={r} value={r}>{r}% GST</option>)}
            </select>
          </Field>
        </div>

        <div className="bg-violet-50 rounded-lg p-4 text-sm space-y-1.5 border border-violet-100">
          <div className="flex justify-between text-slate-600"><span>Amount (Excl. GST)</span><span className="font-medium">₹{fmtMoney(amount)}</span></div>
          <div className="flex justify-between text-slate-500 text-xs"><span>CGST ({taxRate / 2}%)</span><span>₹{fmtMoney(tax / 2)}</span></div>
          <div className="flex justify-between text-slate-500 text-xs"><span>SGST ({taxRate / 2}%)</span><span>₹{fmtMoney(tax / 2)}</span></div>
          {parseFloat(form.tds) > 0 && (
            <div className="flex justify-between text-xs text-amber-700"><span>TDS Deducted</span><span>−₹{fmtMoney(form.tds)}</span></div>
          )}
          <div className="flex justify-between font-semibold border-t border-violet-200 pt-1.5 mt-1"><span>Total (Incl. GST)</span><span>₹{fmtMoney(total)}</span></div>
        </div>

        <Field label="Narration / Notes">
          <textarea className={`${inp} resize-none`} rows={2} placeholder="Describe the expense, purpose…"
            value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>
      <div className="flex items-center justify-between pt-4 border-t border-slate-100 mt-4">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft size={14} /> Back
        </button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={handleSubmit}>Save as Draft</Button>
        </div>
      </div>
    </>
  );
}

// ── Type picker (Step 1) ─────────────────────────────────────────────────────
const TYPE_CARDS = [
  {
    id: 'purchase', Icon: ShoppingCart,
    color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    hoverBorder: 'hover:border-emerald-400', hoverText: 'group-hover:text-emerald-700',
    title: 'Purchase Bill', desc: 'Vendor invoice for goods — raw material, packing, machinery.',
    tags: 'GST Purchase · line items · stays on this page',
  },
  {
    id: 'freight', Icon: Truck,
    color: 'text-amber-700 bg-amber-50 border-amber-200',
    hoverBorder: 'hover:border-amber-400', hoverText: 'group-hover:text-amber-700',
    title: 'Freight Bill', desc: 'Transporter invoice — inward lorry freight or outward delivery charges.',
    tags: 'Opens the Freight Inward / Outward creation page',
  },
  {
    id: 'expense', Icon: Receipt,
    color: 'text-violet-700 bg-violet-50 border-violet-200',
    hoverBorder: 'hover:border-violet-400', hoverText: 'group-hover:text-violet-700',
    title: 'Expense Bill', desc: 'Indirect expense — rent, electricity, professional fees.',
    tags: 'Journal / GST Journal · TDS 194I / 194J · stays on this page',
  },
];

function TypePicker({ onPick, company, setCompany, companyOptions }) {
  return (
    <>
      <CompanyBar company={company} setCompany={setCompany} companyOptions={companyOptions} />
      <p className="text-sm text-slate-500 mb-3">Select the type of bill:</p>
      <div className="flex flex-col gap-3">
        {TYPE_CARDS.map(({ id, Icon, color, hoverBorder, hoverText, title, desc, tags }) => (
          <button key={id} onClick={() => {
            if (!company) { toast.error('Select a company first'); return; }
            onPick(id);
          }}
            className={`flex items-start gap-4 rounded-xl border border-slate-200 p-4 text-left transition group ${hoverBorder} hover:bg-slate-50`}>
            <span className={`mt-0.5 inline-flex shrink-0 items-center justify-center rounded-lg border p-2.5 ${color}`}>
              <Icon size={20} />
            </span>
            <div className="min-w-0">
              <div className={`font-semibold text-slate-800 ${hoverText} transition-colors`}>{title}</div>
              <div className="text-sm text-slate-500 mt-0.5 leading-snug">{desc}</div>
              <div className="text-[11px] text-slate-400 mt-1.5">{tags}</div>
            </div>
            <span className="ml-auto shrink-0 self-center text-slate-300 group-hover:text-indigo-400 text-xl leading-none">›</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ── Root modal ───────────────────────────────────────────────────────────────
export default function ManualBillModal({ isOpen, onClose, onCreated }) {
  const navigate = useNavigate();
  const [step, setStep] = useState('pick');
  const [company, setCompany] = useState('');
  const [form, setForm] = useState({ bill_date: today(), due_date: addDays(today(), 15) });
  const [saving, setSaving] = useState(false);

  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'legal_name', valueField: 'id' });
  const { options: fetchedVendors } = useLookup('/api/vendors/?slim=1', { labelField: 'vendor_name', valueField: 'id' });
  const [localVendors, setLocalVendors] = useState([]);
  const allVendors = [...(fetchedVendors || []), ...localVendors];

  useEffect(() => {
    if (isOpen) {
      setStep('pick');
      setForm({ bill_date: today(), due_date: addDays(today(), 15) });
      setLocalVendors([]);
    }
  }, [isOpen]);

  const handleTypePick = (type) => {
    if (type === 'freight') { setStep('freight-dir'); }
    else { setStep(type); }
  };

  const handleFreightDir = (dir) => {
    onClose();
    const routes = { inward: '/freight/inward/new', outward: '/freight/outward/new', local: '/freight/local/new' };
    navigate(routes[dir] || '/freight/inward/new');
  };

  const submitBill = async (payload) => {
    setSaving(true);
    try {
      await apiClient.post('/api/purchase/bills/', payload);
      toast.success('Bill saved as draft.');
      onClose();
      if (onCreated) onCreated();
      navigate('/purchase/bills/');
    } catch (err) {
      const d = err?.response?.data;
      const msg = typeof d === 'string' ? d
        : d?.detail || d?.error
          || Object.values(d || {}).flat().join(' · ')
          || 'Could not save the bill.';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const title = step === 'pick' ? 'New Manual Bill'
    : step === 'freight-dir' ? 'Freight Bill — Direction'
    : step === 'purchase' ? 'Purchase Bill'
    : 'Expense Bill';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="xl">
      {step === 'pick' && (
        <TypePicker
          onPick={handleTypePick}
          company={company} setCompany={c => setCompany(String(c))}
          companyOptions={companyOptions}
        />
      )}
      {step === 'freight-dir' && (
        <FreightDirectionPicker onPick={handleFreightDir} onBack={() => setStep('pick')} />
      )}
      {step === 'purchase' && (
        <>
          <CompanyBar company={company} setCompany={c => setCompany(String(c))} companyOptions={companyOptions} />
          <PurchaseForm
            form={form} setForm={setForm}
            vendors={allVendors} setVendors={setLocalVendors}
            company={company}
            onSubmit={submitBill} saving={saving} onBack={() => setStep('pick')}
          />
        </>
      )}
      {step === 'expense' && (
        <>
          <CompanyBar company={company} setCompany={c => setCompany(String(c))} companyOptions={companyOptions} />
          <ExpenseForm
            form={form} setForm={setForm}
            vendors={allVendors} setVendors={setLocalVendors}
            company={company}
            onSubmit={submitBill} saving={saving} onBack={() => setStep('pick')}
          />
        </>
      )}
    </Modal>
  );
}
