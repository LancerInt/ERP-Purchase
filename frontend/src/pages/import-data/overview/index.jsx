import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Inbox, ScanLine, CreditCard, Download, BookOpen } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';

// Import Data · Overview — a light landing dashboard: how many documents are
// waiting in the Ledger triage inbox, and quick links into each import flow.
// Slice 4: the inbox count is live (from /api/import/inbox/); the rest are
// navigation tiles into the existing flows.
export default function ImportOverview() {
  const navigate = useNavigate();
  const [inboxCount, setInboxCount] = useState(null);

  useEffect(() => {
    apiClient.get('/api/import/inbox/')
      .then((r) => setInboxCount(r.data.count ?? 0))
      .catch(() => setInboxCount(null));
  }, []);

  const Tile = ({ icon: Icon, label, sub, to, accent = 'slate' }) => (
    <button onClick={() => navigate(to)}
      className="text-left bg-white rounded-xl border border-slate-200 p-4 hover:border-indigo-300 hover:shadow-sm transition">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className="text-slate-400" />
        <span className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">{label}</span>
      </div>
      <div className={`text-lg font-bold text-${accent}-700`}>{sub}</div>
    </button>
  );

  return (
    <MainLayout>
      <PageHeader title="Import Overview" subtitle="Everything coming into the ERP — triage, scan, payments and Tally imports" />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile icon={Inbox} label="Triage inbox" accent="rose"
          sub={inboxCount === null ? '—' : `${inboxCount} waiting`} to="/import/scan" />
        <Tile icon={ScanLine} label="Scan Inbox" sub="Upload invoices" to="/import/scan" />
        <Tile icon={CreditCard} label="Payments" sub="Bank / Day Book" to="/import/payments" />
        <Tile icon={Download} label="Purchase Tally" sub="Bills · TDS" to="/import/purchase-tally" />
        <Tile icon={Download} label="Sales Tally" sub="Invoices · receipts" to="/import/sales-tally" />
        <Tile icon={BookOpen} label="Ledger" sub="Party statements" to="/import/ledgers" />
      </div>

      <p className="text-[11px] text-slate-400 mt-3">
        The <b>Ledger</b> is the master party statement; every “view ledger” link lands here. Document <b>triage</b> (Inbox + Pending Approval) now lives in the <b>Scan Inbox</b> tabs.
      </p>
    </MainLayout>
  );
}
