import { useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import TallyImportButton from '../../../components/common/TallyImportButton';
import TallyFileImportButton from '../../../components/common/TallyFileImportButton';
import DaybookFreightImportButton from '../../../components/common/DaybookFreightImportButton';

// Import Data · Purchase Tally Import — a reachable page around the existing
// TallyImportButton (previously only a modal on the Bills page). Import tab +
// Revert tab, both reusing the proven component (purchaseBalances adds the
// Creditors / TDS tabs; action='revert' is its built-in undo).
// Revert Freight is a SEPARATE button (category='FREIGHT') so freight can be
// reverted without touching purchase bills.
export default function PurchaseTallyImport() {
  const [tab, setTab] = useState('import');   // 'import' | 'revert' | 'revert-freight'
  return (
    <MainLayout>
      <PageHeader
        title="Purchase Tally Import"
        subtitle="Import purchase bills, opening balances, creditors & TDS from a Tally Day Book" />

      <div className="flex gap-5 border-b border-slate-200 mb-4 text-sm">
        <button onClick={() => setTab('import')}
          className={`pb-2 border-b-2 ${tab === 'import' ? 'border-indigo-500 text-indigo-600 font-semibold' : 'border-transparent text-slate-400'}`}>Import</button>
        <button onClick={() => setTab('revert')}
          className={`pb-2 border-b-2 ${tab === 'revert' ? 'border-rose-500 text-rose-600 font-semibold' : 'border-transparent text-slate-400'}`}>↩ Revert import</button>
        <button onClick={() => setTab('revert-freight')}
          className={`pb-2 border-b-2 ${tab === 'revert-freight' ? 'border-amber-500 text-amber-600 font-semibold' : 'border-transparent text-slate-400'}`}>↩ Revert Freight</button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        {tab === 'import' ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-sm text-slate-600">Import purchase vouchers, opening balances, creditors and TDS:</span>
              <TallyImportButton key="import" what="purchase" purchaseBalances />
            </div>
            {/* Day Book FILE upload — imports payments (and bills) from an
                exported XML without the gateway. This is the path that captures
                each payment's funding bank account (the "Paid Through" leg), so
                it's how you tag payments that came in via the connector as
                "Untagged" (bank account not captured). Re-upload the month's
                Day Book here and the bank account fills in by voucher guid. */}
            <div className="flex items-center gap-3 pt-3 border-t border-slate-100">
              <span className="text-sm text-slate-600">Or import from a Day Book <b>XML file</b> (no gateway) — also tags each payment's bank account:</span>
              <TallyFileImportButton what="purchase" />
            </div>
            {/* Outward / Local freight from the Day Book. The live import books an
                outward/local transporter payment with no freight record (connector
                drops the LFO/LFR narration), so the Freight Outward/Local tiles read
                ~0. This creates the missing FreightAdviceOutbound / LocalFreight rows
                from the same Day Book XML, matched to the payments by voucher GUID. */}
            <div className="flex items-center gap-3 pt-3 border-t border-slate-100">
              <span className="text-sm text-slate-600">Create <b>Outward &amp; Local freight</b> records from the Day Book (LFO / LFR vouchers the live sync skips):</span>
              <DaybookFreightImportButton />
            </div>
          </div>
        ) : tab === 'revert' ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-rose-700">Undo a purchase Tally import (preview first — scanned bills are detached, not deleted):</span>
            <TallyImportButton key="revert" what="purchase" action="revert" purchaseBalances />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-amber-700">Revert only freight bills and freight advice records (purchase bills are NOT touched):</span>
            <TallyImportButton key="revert-freight" what="purchase" action="revert" defaultCategory="FREIGHT" />
          </div>
        )}
      </div>
    </MainLayout>
  );
}
