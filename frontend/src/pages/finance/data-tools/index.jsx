import { useEffect, useState } from 'react';
import {
  Database, Upload, Trash2, Download, Loader2, AlertTriangle, FileSpreadsheet,
} from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '@/components/layout/MainLayout';
import PageHeader from '@/components/common/PageHeader';
import { confirm } from '@/components/common/confirm';
import apiClient from '@/utils/api.js';

const BASE = '/api/finance/data-tools';

export default function FinanceDataTools() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');        // which action is running
  const [output, setOutput] = useState('');    // last command output
  const [file, setFile] = useState(null);

  const loadStatus = async () => {
    try {
      const { data } = await apiClient.get(`${BASE}/status/`);
      setStatus(data.seeded);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not load status.');
    }
  };
  useEffect(() => { loadStatus(); }, []);

  const show = (data) => {
    setOutput([data.output, data.warnings].filter(Boolean).join('\n').trim());
    if (data.seeded) setStatus(data.seeded);
  };

  const importExcel = async () => {
    if (!file) { toast.error('Choose an .xlsx file first.'); return; }
    setBusy('import');
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await apiClient.post(`${BASE}/import/`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      show(data);
      toast.success('Opening balances imported.');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Import failed.');
    } finally {
      setBusy('');
    }
  };

  const downloadTemplate = async () => {
    setBusy('template');
    try {
      const res = await apiClient.get(`${BASE}/template/`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'finance_opening_balances_template.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not download template.');
    } finally {
      setBusy('');
    }
  };

  const purge = async () => {
    const ok = await confirm({
      title: 'Clear imported data',
      message: 'This deletes every receivable, payable and ledger entry created by '
        + 'this importer. Documents you entered normally are NOT touched. Continue?',
      isDangerous: true,
      confirmLabel: 'Clear imported data',
    });
    if (!ok) return;
    setBusy('purge');
    try {
      const { data } = await apiClient.post(`${BASE}/purge/`);
      show(data);
      toast.success('Imported data cleared.');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Purge failed.');
    } finally {
      setBusy('');
    }
  };

  const importedTotal = status ? (status.receivables + status.payables) : 0;
  const spin = (k) => busy === k;

  return (
    <MainLayout>
      <PageHeader
        title="Import Opening Balances"
        subtitle="Load real outstanding receivables & payables from your books / Tally"
        breadcrumbs={[{ label: 'Finance', path: '/finance/dashboard' }, { label: 'Import Data' }]}
      />

      {/* current status */}
      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 flex items-center gap-3">
        <Database className="w-5 h-5 text-slate-400" />
        <div className="text-sm text-slate-600">
          Imported so far:{' '}
          <span className="font-semibold text-slate-900">{status ? status.receivables : '—'}</span> receivables,{' '}
          <span className="font-semibold text-slate-900">{status ? status.payables : '—'}</span> payables
        </div>
      </div>

      {/* Import opening balances — primary action */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800 mb-1">
          <Upload className="w-4 h-4 text-emerald-500" /> Upload your outstanding
        </h2>
        <p className="text-sm text-slate-500 mb-5 max-w-2xl">
          Download the template, fill the <span className="font-medium text-slate-600">Receivables</span> and{' '}
          <span className="font-medium text-slate-600">Payables</span> sheets with your real figures
          (match each party by Customer/Vendor code or exact name), then upload. A due date in the
          past lands the row in the overdue/aging buckets automatically. Your real invoice numbers
          are preserved.
        </p>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <button type="button" onClick={downloadTemplate} disabled={!!busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {spin('template') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download template
          </button>

          <div className="hidden sm:block h-6 w-px bg-slate-200" />

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 cursor-pointer hover:bg-slate-50">
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
              {file ? file.name : 'Choose .xlsx file'}
              <input type="file" accept=".xlsx,.xlsm" className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
            <button type="button" onClick={importExcel} disabled={!!busy || !file}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
              {spin('import') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Import
            </button>
          </div>
        </div>
      </section>

      {/* output */}
      {output && (
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-900 p-4">
          <pre className="whitespace-pre-wrap text-xs leading-relaxed text-slate-100">{output}</pre>
        </div>
      )}

      {/* danger zone */}
      <section className="mt-5 rounded-xl border border-rose-200 bg-rose-50/50 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-rose-700 mb-1">
          <AlertTriangle className="w-4 h-4" /> Clear imported data
        </h2>
        <p className="text-sm text-rose-600/80 mb-4">
          Removes only what this importer created ({importedTotal} rows). Documents you entered
          normally are never affected — use this to re-import after a correction.
        </p>
        <button type="button" onClick={purge} disabled={!!busy || importedTotal === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-rose-600 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50">
          {spin('purge') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Clear imported data
        </button>
      </section>
    </MainLayout>
  );
}
