import { useState } from 'react';
import * as XLSX from 'xlsx';

import toast from 'react-hot-toast';
import { FileSpreadsheet, X, UploadCloud, FileDown, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '../../components/ui';
import apiClient from '../../utils/api.js';
import useApiData from '../../hooks/useApiData.js';
import { getApiErrorMessage } from '../../utils/formHelpers.js';
import BankTallyImport from './BankTallyImport.jsx';

// ---------- cell / value helpers ----------
const arr = (resp) => (resp?.data?.results ?? resp?.data ?? []);
const UP = (v) => String(v ?? '').trim().toUpperCase();
const NUM = (v) => { const n = parseFloat(String(v ?? '').replace(/[,₹\s]/g, '')); return isNaN(n) ? 0 : n; };
function cell(row, ...aliases) {
  const keys = Object.keys(row);
  for (const a of aliases) {
    const k = keys.find((kk) => kk.trim().toLowerCase() === a.toLowerCase());
    if (k != null && row[k] !== '' && row[k] != null) return row[k];
  }
  return '';
}
function typeCode(v) { const u = UP(v); if (u.includes('SAV')) return 'SAVINGS'; if (u.includes('CC') || u.includes('OD')) return 'CC_OD'; return 'CURRENT'; }
function modeCode(v) { const u = UP(v).replace(/[^A-Z]/g, ''); return ['RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD', 'CASH', 'NEFT'].find((m) => u.includes(m)) || 'NEFT'; }
function dateISO(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && XLSX.SSF) { const d = XLSX.SSF.parse_date_code(v); if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/); if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  const d = new Date(s); if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}
function matchByName(list, fields, wanted) {
  const w = String(wanted ?? '').trim().toLowerCase();
  if (!w) return '';
  const eq = list.find((o) => fields.some((f) => String(o[f] ?? '').trim().toLowerCase() === w));
  if (eq) return eq.id;
  const inc = list.find((o) => fields.some((f) => { const val = String(o[f] ?? '').trim().toLowerCase(); return val && (val.includes(w) || w.includes(val)); }));
  return inc ? inc.id : '';
}
function matchAccount(list, wanted) {
  const w = String(wanted ?? '').trim().toLowerCase();
  if (!w) return '';
  const hit = list.find((a) => String(a.code ?? '').toLowerCase() === w)
    || list.find((a) => `${a.bank_name} ${a.branch}`.toLowerCase().includes(w) || w.includes(String(a.branch ?? '').toLowerCase()))
    || list.find((a) => String(a.account_number ?? '').replace(/\s/g, '') === w.replace(/\s/g, ''));
  return hit ? hit.id : '';
}

// ---------- per-entity import config ----------
const CONFIG = {
  accounts: {
    endpoint: '/api/bank/accounts/',
    template: [
      ['Code', 'Nickname', 'Bank Name', 'Branch', 'Account Number', 'Category', 'Type', 'IFSC', 'Opening Balance', 'Status'],
      ['BANK-001', 'ICICI Current', 'ICICI Bank', 'Ambattur', '0234 5012 3456', 'Primary', 'Current', 'ICIC0000234', '6120000', 'Active'],
    ],
    lookups: async () => ({}),
    build: (row) => ({
      code: cell(row, 'Code', 'A/C Code', 'Account Code'),
      nickname: cell(row, 'Nickname'),
      bank_name: cell(row, 'Bank Name', 'Bank') || 'ICICI Bank',
      branch: cell(row, 'Branch'),
      account_number: String(cell(row, 'Account Number', 'Account No', 'A/C No') || ''),
      category: UP(cell(row, 'Category')).startsWith('S') ? 'SECONDARY' : 'PRIMARY',
      account_type: typeCode(cell(row, 'Type', 'Account Type')),
      ifsc_code: cell(row, 'IFSC', 'IFSC Code'),
      opening_balance: NUM(cell(row, 'Opening Balance', 'Balance')),
      current_balance: NUM(cell(row, 'Opening Balance', 'Balance')),
      status: UP(cell(row, 'Status')).startsWith('IN') ? 'INACTIVE' : 'ACTIVE',
    }),
    valid: (p) => p.code && p.account_number,
  },
  receipts: {
    endpoint: '/api/bank/receipts/',
    template: [
      ['Voucher No', 'Date', 'Customer', 'Against Invoice', 'Bank Account', 'Mode', 'Amount', 'Reference No'],
      ['RCP-2026-0001', '12-08-2026', 'SSBI Chem', 'INV-0042', 'BANK-001', 'NEFT', '560000', 'N0423119'],
    ],
    lookups: async () => {
      const [c, a] = await Promise.all([apiClient.get('/api/customers/'), apiClient.get('/api/bank/accounts/')]);
      return { customers: arr(c), accounts: arr(a) };
    },
    build: (row, lk) => ({
      voucher_no: cell(row, 'Voucher No', 'Voucher', 'Receipt No'),
      receipt_date: dateISO(cell(row, 'Date', 'Receipt Date')),
      customer: matchByName(lk.customers, ['customer_name', 'name'], cell(row, 'Customer', 'Party', 'Customer Name')),
      against_invoice: cell(row, 'Against Invoice', 'Invoice', 'Invoice No'),
      bank_account: matchAccount(lk.accounts, cell(row, 'Bank Account', 'Bank', 'Account')),
      payment_mode: modeCode(cell(row, 'Mode', 'Payment Mode')),
      amount: NUM(cell(row, 'Amount', 'Amount Received')),
      reference_no: cell(row, 'Reference No', 'UTR', 'Reference'),
    }),
    valid: (p) => p.voucher_no && p.receipt_date && p.customer && p.bank_account && p.amount,
    missing: (p) => [!p.customer && 'customer not found', !p.bank_account && 'bank account not found', !p.receipt_date && 'bad date', !p.amount && 'no amount'].filter(Boolean).join(', '),
  },
  payments: {
    endpoint: '/api/bank/payments/',
    template: [
      ['Voucher No', 'Date', 'Vendor', 'Against Bill', 'Bank Account', 'Mode', 'Amount', 'Reference No'],
      ['PAY-2026-0001', '10-08-2026', 'Greenstar Fertilisers', 'BILL-0311', 'BANK-001', 'RTGS', '980000', 'R0233871'],
    ],
    lookups: async () => {
      const [vd, a] = await Promise.all([apiClient.get('/api/vendors/'), apiClient.get('/api/bank/accounts/')]);
      return { vendors: arr(vd), accounts: arr(a) };
    },
    build: (row, lk) => ({
      voucher_no: cell(row, 'Voucher No', 'Voucher', 'Payment No'),
      payment_date: dateISO(cell(row, 'Date', 'Payment Date')),
      vendor: matchByName(lk.vendors, ['vendor_name', 'name'], cell(row, 'Vendor', 'Supplier', 'Party')),
      against_bill: cell(row, 'Against Bill', 'Bill', 'Bill No'),
      bank_account: matchAccount(lk.accounts, cell(row, 'Bank Account', 'Bank', 'Account')),
      payment_mode: modeCode(cell(row, 'Mode', 'Payment Mode')),
      amount: NUM(cell(row, 'Amount', 'Amount Paid')),
      reference_no: cell(row, 'Reference No', 'UTR', 'Reference'),
    }),
    valid: (p) => p.voucher_no && p.payment_date && p.vendor && p.bank_account && p.amount,
    missing: (p) => [!p.vendor && 'vendor not found', !p.bank_account && 'bank account not found', !p.payment_date && 'bad date', !p.amount && 'no amount'].filter(Boolean).join(', '),
  },
};

// ================= component =================
export default function BankImports({ entity, exportRows, exportName, onImported }) {
  const [modal, setModal] = useState(null); // 'excel'
  const [companyId, setCompanyId] = useState('');
  const { data: companies } = useApiData('/api/companies/');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const cfg = CONFIG[entity];

  const reset = () => { setFile(null); setResult(null); setBusy(false); };
  const close = () => { setModal(null); reset(); };

  // ---- Export (CSV) ----
  const doExport = () => {
    const data = exportRows ? exportRows() : [];
    if (!data.length) { toast('Nothing to export'); return; }
    const csv = data.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = exportName || `bank-${entity}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  const downloadTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet(cfg.template);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, `bank-${entity}-template.xlsx`);
  };

  const onFile = (e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setResult(null); } };

  const runUpload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (companyId) fd.append('company', companyId);
      const res = await apiClient.post('/api/bank/import-tally/', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 });
      setResult(res.data);
      const imported = (res.data.payments || 0) + (res.data.receipts || 0);
      if (imported > 0) { toast.success(`${imported} vouchers imported`); onImported?.(); }
      else toast('No new vouchers imported', { icon: 'ℹ️' });
    } catch (err) {
      const msg = getApiErrorMessage(err);
      toast.error(msg); setResult({ error: msg });
    } finally { setBusy(false); }
  };

  return (
    <>
      <Button variant="outline" icon={FileSpreadsheet} responsiveLabel onClick={() => { reset(); setModal('excel'); }} title="Import from Excel">Import Excel</Button>
      <BankTallyImport onImported={onImported} />
      <Button variant="outline" icon={FileDown} responsiveLabel onClick={doExport} title="Export">Export</Button>
      <Button variant="outline" icon={UploadCloud} responsiveLabel onClick={() => window.print()} title="Print">Print</Button>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden">
          <div className="fixed inset-0 bg-black/40" onClick={close} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85dvh] flex flex-col">
            <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900">Import from Excel · {entity}</h3>
              <button onClick={close} className="text-slate-400 hover:text-slate-700" aria-label="Close"><X size={20} /></button>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto">
              {modal === 'excel' && (
                <>
                  <p className="text-sm text-slate-500 mb-3">Upload your <b>Tally Payment / Receipt Register</b> Excel export. Both sheets are imported; bank accounts, vendors and customers are created automatically, and voucher numbers already imported are skipped.</p>
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Import for company</label>
                    <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                      <option value="">Auto-detect from file</option>
                      {(companies || []).map((c) => <option key={c.id} value={c.id}>{c.legal_name || c.name || c.company_code}</option>)}
                    </select>
                  </div>
                  <label className="block border-2 border-dashed border-slate-300 rounded-lg p-4 sm:p-5 text-center cursor-pointer hover:bg-slate-50">
                    <UploadCloud className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <span className="text-sm text-slate-500">Click to choose your Tally .xlsx</span>
                    <input type="file" accept=".xlsx,.xls" className="hidden" onChange={onFile} />
                  </label>
                  {file && <p className="text-sm text-slate-700 mt-3 font-medium">Selected: {file.name}</p>}
                </>
              )}

              {result && (
                <div className="mt-4 rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm">
                  {result.error ? (
                    <span className="text-red-600 flex items-center gap-1"><XCircle size={16} /> {result.error}</span>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-medium">
                        {result.payments != null && <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={16} /> {result.payments} payments</span>}
                        {result.receipts != null && <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={16} /> {result.receipts} receipts</span>}
                        {result.ok != null && <span className="text-green-600 flex items-center gap-1"><CheckCircle2 size={16} /> {result.ok} imported</span>}
                        {result.duplicates > 0 && <span className="text-slate-500">{result.duplicates} already imported</span>}
                        {result.skipped > 0 && <span className="text-amber-600">{result.skipped} skipped</span>}
                        {result.fail > 0 && <span className="text-red-600 flex items-center gap-1"><XCircle size={16} /> {result.fail} failed</span>}
                      </div>
                      {(result.vendors || result.customers || result.accounts) ? (
                        <p className="text-xs text-slate-500 mt-1">created: {result.vendors || 0} vendors · {result.customers || 0} customers · {result.accounts || 0} bank accounts</p>
                      ) : null}
                      {result.errors?.length > 0 && (
                        <ul className="mt-2 text-xs text-slate-500 list-disc pl-5 space-y-0.5">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-4 sm:px-5 py-4 border-t border-slate-200">
              <button onClick={close} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Close</button>
              {modal === 'excel' && <button disabled={busy || !file} onClick={runUpload} className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{busy ? 'Importing…' : 'Import file'}</button>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
