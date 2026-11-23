import React, { useMemo, useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatsCard from '../../../components/common/StatsCard';
import { TrendingDown, Banknote, ShieldAlert, FileCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import usePagerKeys from '../../../hooks/usePagerKeys.js';
import BankImports from '../BankImports.jsx';
import BankFilterBar from '../BankFilterBar.jsx';
import BankCompanyChips from '../BankCompanyChips.jsx';

const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const lakh = (n) => '₹' + (Number(n || 0) / 100000).toFixed(1) + ' L';
const PAGE_SIZE = 50;
const EMPTY = { q: '', company: '', bank_account_code: '', payment_mode: '', approval_status: '', reconciliation_status: '', date_from: '', date_to: '' };

export default function PaymentRegister() {
  const { canCreate } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/bank/payments/');
  const payments = data || [];

  const [showFilters, setShowFilters] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setPage(1); };
  const reset = () => { setF(EMPTY); setPage(1); };

  const filtered = useMemo(() => payments.filter((p) => {
    if (f.q) { const q = f.q.toLowerCase(); const hay = `${p.voucher_no} ${p.vendor_name} ${p.against_bill} ${p.reference_no}`.toLowerCase(); if (!hay.includes(q)) return false; }
    if (f.company && String(p.company) !== f.company) return false;
    if (f.bank_account_code && p.bank_account_code !== f.bank_account_code) return false;
    if (f.payment_mode && p.payment_mode !== f.payment_mode) return false;
    if (f.approval_status && p.approval_status !== f.approval_status) return false;
    if (f.reconciliation_status && p.reconciliation_status !== f.reconciliation_status) return false;
    if (f.date_from && p.payment_date < f.date_from) return false;
    if (f.date_to && p.payment_date > f.date_to) return false;
    return true;
  }), [payments, f]);

  const bankOptions = useMemo(() => {
    const seen = new Map();
    payments.forEach((p) => { if (p.bank_account_code && !seen.has(p.bank_account_code)) seen.set(p.bank_account_code, p.bank_account_label || p.bank_account_code); });
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [payments]);

  const companyOptions = useMemo(() => {
    const seen = new Map();
    payments.forEach((p) => { if (p.company && !seen.has(p.company)) seen.set(p.company, p.company_name || p.company); });
    return [...seen].map(([value, label]) => ({ value: String(value), label }));
  }, [payments]);

  const totalPaid = filtered.reduce((s, p) => s + Number(p.amount || 0), 0);
  const pendingApproval = filtered.filter((p) => p.approval_status === 'PENDING').length;
  const chequesIssued = filtered.filter((p) => p.payment_mode === 'CHEQUE' && p.cheque_status === 'ISSUED').length;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  usePagerKeys({   // ← / → page the vouchers
    enabled: totalPages > 1,
    onPrev: () => setPage(Math.max(1, safePage - 1)),
    onNext: () => setPage(Math.min(totalPages, safePage + 1)),
  });
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const exportRows = () => [
    ['Voucher No', 'Date', 'Vendor', 'Against Bill', 'Bank Account', 'Mode', 'Amount', 'Cheque Status', 'Approval', 'Reconciliation'],
    ...filtered.map((p) => [p.voucher_no, p.payment_date, p.vendor_name, p.against_bill, p.bank_account_code, p.payment_mode, p.amount, p.cheque_status, p.approval_status, p.reconciliation_status]),
  ];

  const breadcrumbs = [{ label: 'Bank', href: '/bank/dashboard' }, { label: 'Purchase · Payments' }];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="Purchase · Payments"
          breadcrumbs={breadcrumbs}
          actions={{
            right: <BankImports entity="payments" exportRows={exportRows} exportName="bank-payments.csv" onImported={refetch} />,
            onFilter: () => setShowFilters((v) => !v),
            ...(canCreate('Bank Payment') ? { createLink: '/bank/payments/new', createLabel: 'New Payment' } : {}),
          }}
        />
        {companyOptions.length > 0 && (
          <BankCompanyChips options={companyOptions} value={f.company} onChange={(v) => set('company', v)} />
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard icon={TrendingDown} label="Paid" value={lakh(totalPaid)} />
          <StatsCard icon={Banknote} label="Payments" value={filtered.length} />
          <StatsCard icon={ShieldAlert} label="Pending Approval" value={pendingApproval} />
          <StatsCard icon={FileCheck} label="Cheques Issued" value={chequesIssued} />
        </div>

        {showFilters && (
          <BankFilterBar
            values={f} set={set} reset={reset}
            searchPlaceholder="Voucher, vendor, bill, UTR…"
            selects={[
              { key: 'bank_account_code', label: 'Bank Account', options: bankOptions },
              { key: 'payment_mode', label: 'Mode', options: ['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD'] },
              { key: 'approval_status', label: 'Approval', options: [{ value: 'DRAFT', label: 'Draft' }, { value: 'PENDING', label: 'Pending Approval' }, { value: 'APPROVED', label: 'Approved' }, { value: 'PAID', label: 'Paid' }] },
              { key: 'reconciliation_status', label: 'Reconciliation', options: [{ value: 'UNRECONCILED', label: 'Unreconciled' }, { value: 'RECONCILED', label: 'Reconciled' }] },
            ]}
          />
        )}

        {isLoading && <div className="text-center py-8 text-slate-500">Loading...</div>}
        {error && <div className="text-center py-8 text-red-500">Failed to load payments</div>}

        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px]">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {['Date', 'Particulars', 'Vch Type', 'Vch No.'].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{h}</th>
                  ))}
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Debit</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Credit</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.length === 0 && !isLoading && (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500 text-sm">{payments.length ? 'No payments match the filters' : 'No payments yet'}</td></tr>
                )}
                {pageItems.map((p) => (
                  <React.Fragment key={p.id}>
                    <tr className="border-t border-slate-200">
                      <td className="px-4 py-2.5 text-sm text-slate-600 align-top">{fmtDate(p.payment_date)}</td>
                      <td className="px-4 py-2.5 text-sm align-top">
                        <span className="font-medium text-slate-900">{p.vendor_name}</span>
                        <span className="text-[10px] text-slate-400 font-semibold"> Dr</span>
                        {p.against_bill && <span className="text-[10px] text-blue-600"> ({p.against_bill})</span>}
                      </td>
                      <td className="px-4 py-2.5 align-top"><span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs font-medium">Payment</span></td>
                      <td className="px-4 py-2.5 text-sm text-slate-500 align-top">{p.voucher_no}</td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-900 font-medium">{fmt(p.amount)}</td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-300"></td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 align-top"></td>
                      <td className="px-4 py-2.5 text-sm align-top"><span className="pl-6 text-slate-500">To {p.bank_account_label || p.bank_account_code}</span></td>
                      <td className="px-4 py-2.5 align-top"></td>
                      <td className="px-4 py-2.5 align-top"></td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-300"></td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-900 font-medium">{fmt(p.amount)}</td>
                    </tr>
                  </React.Fragment>
                ))}
                {filtered.length > 0 && (
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-900">
                    <td className="px-4 py-3 text-sm" colSpan={4}>Grand Total ({filtered.length})</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums">{fmt(totalPaid)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums">{fmt(totalPaid)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {filtered.length > 0 && (
            <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
              <span>Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} vouchers</span>
              <div className="flex items-center gap-2">
                <button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} className="p-1.5 border border-slate-300 rounded-lg disabled:opacity-40 hover:bg-slate-50"><ChevronLeft size={16} /></button>
                <span>Page {safePage} / {totalPages}</span>
                <button disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)} className="p-1.5 border border-slate-300 rounded-lg disabled:opacity-40 hover:bg-slate-50"><ChevronRight size={16} /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}
