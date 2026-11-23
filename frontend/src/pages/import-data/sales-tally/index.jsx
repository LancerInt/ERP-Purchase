import { useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import TallyImportButton from '../../../components/common/TallyImportButton';

// Import Data · Sales Tally Import — a reachable page around the existing
// TallyImportButton. Import tab + Revert tab; reuses the proven component
// (what='transactions' brings sales invoices & receipts; action='revert' undoes).
export default function SalesTallyImport() {
  const [tab, setTab] = useState('import');
  return (
    <MainLayout>
      <PageHeader
        title="Sales Tally Import"
        subtitle="Import sales invoices & receipts from a Tally Day Book" />

      <div className="flex gap-5 border-b border-slate-200 mb-4 text-sm">
        <button onClick={() => setTab('import')}
          className={`pb-2 border-b-2 ${tab === 'import' ? 'border-indigo-500 text-indigo-600 font-semibold' : 'border-transparent text-slate-400'}`}>Import</button>
        <button onClick={() => setTab('revert')}
          className={`pb-2 border-b-2 ${tab === 'revert' ? 'border-rose-500 text-rose-600 font-semibold' : 'border-transparent text-slate-400'}`}>↩ Revert import</button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        {tab === 'import' ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-600">Import sales invoices and receipts:</span>
            <TallyImportButton what="sales" />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-rose-700">Undo a sales Tally import (preview first):</span>
            <TallyImportButton what="sales" action="revert" />
          </div>
        )}
      </div>
    </MainLayout>
  );
}
