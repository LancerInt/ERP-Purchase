import React, { useMemo, useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatsCard from '../../../components/common/StatsCard';
import { TrendingUp, Receipt, Clock, TriangleAlert, ChevronLeft, ChevronRight } from 'lucide-react';
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
const EMPTY = { q: '', company: '', bank_account_code: '', payment_mode: '', reconciliation_status: '', date_from: '', date_to: '' };

export default function ReceiptRegister() {
  const { canCreate } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/bank/receipts/');
  const receipts = data || [];

  const [showFilters, setShowFilters] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const set = (k, v) => { setF((p) => ({ ...p, [k]: v })); setPage(1); };
  const reset = () => { setF(EMPTY); setPage(1); };

  const filtered = useMemo(() => receipts.filter((r) => {
    if (f.q) { const q = f.q.toLowerCase(); const hay = `${r.voucher_no} ${r.customer_name} ${r.against_invoice} ${r.reference_no}`.toLowerCase(); if (!hay.includes(q)) return false; }
    if (f.company && String(r.company) !== f.company) return false;
    if (f.bank_account_code && r.bank_account_code !== f.bank_account_code) return false;
    if (f.payment_mode && r.payment_mode !== f.payment_mode) return false;
    if (f.reconciliation_status && r.reconciliation_status !== f.reconciliation_status) return false;
    if (f.date_from && r.receipt_date < f.date_from) return false;
    if (f.date_to && r.receipt_date > f.date_to) return false;
    return true;
  }), [receipts, f]);

  const bankOptions = useMemo(() => {
    const seen = new Map();
    receipts.forEach((r) => { if (r.bank_account_code && !seen.has(r.bank_account_code)) seen.set(r.bank_account_code, r.bank_account_label || r.bank_account_code); });
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [receipts]);

  const companyOptions = useMemo(() => {
    const seen = new Map();
    receipts.forEach((r) => { if (r.company && !seen.has(r.company)) seen.set(r.company, r.company_name || r.company); });
    return [...seen].map(([value, label]) => ({ value: String(value), label }));
  }, [receipts]);

  const totalReceived = filtered.reduce((s, r) => s + Number(r.amount || 0), 0);
  const chequesPending = filtered.filter((r) => r.payment_mode === 'CHEQUE' && r.clearing_status === 'PENDING').length;
  const bounced = filtered.filter((r) => r.clearing_status === 'BOUNCED').length;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  usePagerKeys({   // ← / → page the vouchers
    enabled: totalPages > 1,
    onPrev: () => setPage(Math.max(1, safePage - 1)),
    onNext: () => setPage(Math.min(totalPages, safePage + 1)),
  });

  const exportRows = () => [
    ['Voucher No', 'Date', 'Customer', 'Against Invoice', 'Bank Account', 'Mode', 'Amount', 'Clearing', 'Reconciliation'],
    ...filtered.map((r) => [r.voucher_no, r.receipt_date, r.customer_name, r.against_invoice, r.bank_account_code, r.payment_mode, r.amount, r.clearing_status, r.reconciliation_status]),
  ];

  const breadcrumbs = [{ label: 'Bank', href: '/bank/dashboard' }, { label: 'Sales · Receipts' }];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="Sales · Receipts"
          breadcrumbs={breadcrumbs}
          actions={{
            right: <BankImports entity="receipts" exportRows={exportRows} exportName="bank-receipts.csv" onImported={refetch} />,
            onFilter: () => setShowFilters((v) => !v),
            ...(canCreate('Bank Receipt') ? { createLink: '/bank/receipts/new', createLabel: 'New Receipt' } : {}),
          }}
        />
        {companyOptions.length > 0 && (
          <BankCompanyChips options={companyOptions} value={f.company} onChange={(v) => set('company', v)} />
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatsCard icon={TrendingUp} label="Received" value={lakh(totalReceived)} />
          <StatsCard icon={Receipt} label="Receipts" value={filtered.length} />
          <StatsCard icon={Clock} label="Cheques Pending" value={chequesPending} />
          <StatsCard icon={TriangleAlert} label="Bounced" value={bounced} />
        </div>

        {showFilters && (
          <BankFilterBar
            values={f} set={set} reset={reset}
            searchPlaceholder="Voucher, customer, invoice, UTR…"
            selects={[
              { key: 'bank_account_code', label: 'Bank Account', options: bankOptions },
              { key: 'payment_mode', label: 'Mode', options: ['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD', 'CASH'] },
              { key: 'reconciliation_status', label: 'Reconciliation', options: [{ value: 'UNRECONCILED', label: 'Unreconciled' }, { value: 'RECONCILED', label: 'Reconciled' }] },
            ]}
          />
        )}

        {isLoading && <div className="text-center py-8 text-slate-500">Loading...</div>}
        {error && <div className="text-center py-8 text-red-500">Failed to load receipts</div>}

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
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500 text-sm">{receipts.length ? 'No receipts match the filters' : 'No receipts yet'}</td></tr>
                )}
                {pageItems.map((r) => (
                  <React.Fragment key={r.id}>
                    <tr className="border-t border-slate-200">
                      <td className="px-4 py-2.5 text-sm text-slate-600 align-top">{fmtDate(r.receipt_date)}</td>
                      <td className="px-4 py-2.5 text-sm align-top">
                        <span className="font-medium text-slate-900">{r.bank_account_label || r.bank_account_code}</span>
                        <span className="text-[10px] text-slate-400 font-semibold"> Dr</span>
                      </td>
                      <td className="px-4 py-2.5 align-top"><span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs font-medium">Receipt</span></td>
                      <td className="px-4 py-2.5 text-sm text-slate-500 align-top">{r.voucher_no}</td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-900 font-medium">{fmt(r.amount)}</td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-300"></td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 align-top"></td>
                      <td className="px-4 py-2.5 text-sm align-top">
                        <span className="pl-6 text-slate-500">To {r.customer_name}</span>
                        {r.against_invoice && <span className="text-[10px] text-blue-600"> ({r.against_invoice})</span>}
                      </td>
                      <td className="px-4 py-2.5 align-top"></td>
                      <td className="px-4 py-2.5 align-top"></td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-300"></td>
                      <td className="px-4 py-2.5 text-sm text-right tabular-nums text-slate-900 font-medium">{fmt(r.amount)}</td>
                    </tr>
                  </React.Fragment>
                ))}
                {filtered.length > 0 && (
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-900">
                    <td className="px-4 py-3 text-sm" colSpan={4}>Grand Total ({filtered.length})</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums">{fmt(totalReceived)}</td>
                    <td className="px-4 py-3 text-sm text-right tabular-nums">{fmt(totalReceived)}</td>
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
