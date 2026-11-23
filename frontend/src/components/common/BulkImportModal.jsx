/**
 * BulkImportModal — shared Excel-import flow for the Master module.
 *
 * Usage on any list page that's wired to a backend `BulkImportMixin`:
 *
 *   <BulkImportModal
 *      open={open}
 *      onClose={() => setOpen(false)}
 *      entityLabel="Customers"
 *      endpoint="/api/customers/"          // the ViewSet root URL
 *      onSuccess={refetch}                  // re-pull the list after import
 *   />
 *
 * The backend mixin exposes two endpoints under that root:
 *   GET  {endpoint}import-template/   – downloads a blank .xlsx template
 *   POST {endpoint}import/            – multipart upload, returns counts + errors
 *
 * The modal walks the user through:
 *   1. Download template
 *   2. Pick the filled file (drag-drop or browse)
 *   3. Upload + show a results panel with per-row errors
 */
import { useRef, useState } from 'react';
import {
  Upload, FileSpreadsheet, Download, CheckCircle, AlertTriangle, Loader2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../utils/api.js';
import Modal from '../ui/Modal';
import { clearLookupCache } from '../../hooks/useLookup.js';

export default function BulkImportModal({ open, onClose, entityLabel, endpoint, onSuccess }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);

  if (!open) return null;

  // The mixin's endpoints sit under the ViewSet root; we ensure the base
  // ends with a trailing slash so '/api/customers' and '/api/customers/'
  // both work.
  const base = endpoint.endsWith('/') ? endpoint : endpoint + '/';
  const templateUrl = `${base}import-template/`;
  const importUrl   = `${base}import/`;

  const reset = () => { setFile(null); setResult(null); };
  const handleClose = () => { reset(); onClose?.(); };

  const handlePick = (f) => {
    if (!f) return;
    if (!/\.(xlsx|xls)$/i.test(f.name)) {
      toast.error('Please upload a .xlsx file.');
      return;
    }
    setFile(f);
    setResult(null);
  };

  // Template download. We fetch via apiClient so the Authorization
  // header is attached (the route requires authentication), then
  // create a Blob URL and trigger a download.
  const downloadTemplate = async () => {
    try {
      const res = await apiClient.get(templateUrl, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${entityLabel.toLowerCase().replace(/\s+/g, '-')}-import-template.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Could not download template.');
    }
  };

  const upload = async () => {
    if (!file) { toast.error('Pick a file first.'); return; }
    setUploading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post(importUrl, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      });
      setResult(res.data);
      const created = res.data?.created || 0;
      const updated = res.data?.updated || 0;
      if (created > 0 || updated > 0) {
        const parts = [];
        if (created) parts.push(`${created} created`);
        if (updated) parts.push(`${updated} updated`);
        toast.success(`${entityLabel}: ${parts.join(', ')}.`);
        // The useLookup module cache survives SPA navigation, so a form
        // opened after this import would still serve the PRE-import
        // catalogue (e.g. freshly imported packing products missing from
        // the New PR product dropdown until a hard refresh). Imports are
        // exactly the moment master data changes in bulk — flush it all.
        clearLookupCache();
        onSuccess?.();
      } else if (res.data?.failed > 0) {
        toast.error(`All ${res.data.failed} row(s) failed — see details below.`);
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Import failed.';
      toast.error(msg);
      // The 400 path returns a structured payload (expected columns,
      // found columns). Show it so the user can fix the file.
      if (err?.response?.data) setResult({ error: msg, ...err.response.data });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={handleClose}
      title={`Import ${entityLabel} from Excel`}
      size="lg"
      footer={
        <>
          <button onClick={handleClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            Close
          </button>
          <button onClick={upload} disabled={!file || uploading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300">
            {uploading ? <><Loader2 size={14} className="animate-spin" /> Uploading…</> : <><Download size={14} /> Import</>}
          </button>
        </>
      }
    >
      <p className="-mt-1 mb-3 text-xs text-slate-500">
        Upload an .xlsx file to create multiple {entityLabel.toLowerCase()} in one shot. Existing rows are not modified.
      </p>
      <div className="space-y-4">
            {/* Step 1 — template */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Step 1 — Download the template</p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Use this blank .xlsx so the columns line up. Fill it with one row per record and save.
                  </p>
                </div>
                <button onClick={downloadTemplate}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                  <Download size={13} /> Template
                </button>
              </div>
            </div>

            {/* Step 2 — file picker */}
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-900">Step 2 — Upload the filled file</p>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); handlePick(e.dataTransfer.files?.[0]); }}
                className="rounded-xl border-2 border-dashed border-slate-300 bg-white p-4 sm:p-5 text-center hover:border-indigo-400"
              >
                {file ? (
                  <div className="flex items-center justify-center gap-3 text-sm">
                    <FileSpreadsheet size={20} className="text-emerald-600" />
                    <div className="text-left">
                      <p className="font-semibold text-slate-900">{file.name}</p>
                      <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                    <button onClick={reset} className="ml-2 text-xs text-slate-500 underline hover:text-red-600">
                      remove
                    </button>
                  </div>
                ) : (
                  <>
                    <Upload size={24} className="mx-auto text-slate-400" />
                    <p className="mt-2 text-sm text-slate-700">
                      Drag & drop the .xlsx file or{' '}
                      <button onClick={() => inputRef.current?.click()}
                        className="font-semibold text-indigo-600 hover:underline">browse</button>
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500">Only .xlsx files are accepted.</p>
                  </>
                )}
                <input ref={inputRef} type="file" hidden accept=".xlsx,.xls"
                  onChange={(e) => handlePick(e.target.files?.[0])} />
              </div>
            </div>

            {/* Step 3 — results */}
            {result && (
              <div className={`rounded-xl border p-4 text-sm ${
                result.error
                  ? 'border-red-200 bg-red-50'
                  : result.failed > 0
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-emerald-200 bg-emerald-50'
              }`}>
                <div className="mb-2 flex items-center gap-2 font-semibold">
                  {result.error ? <AlertTriangle size={15} className="text-red-700" />
                    : result.failed > 0 ? <AlertTriangle size={15} className="text-amber-700" />
                    : <CheckCircle size={15} className="text-emerald-700" />}
                  <span className={
                    result.error ? 'text-red-800'
                    : result.failed > 0 ? 'text-amber-800'
                    : 'text-emerald-800'
                  }>
                    {result.error
                      ? result.error
                      : `${result.created || 0} created · ${result.updated || 0} updated · ${result.failed || 0} failed · ${result.total_rows || 0} total`}
                  </span>
                </div>

                {Array.isArray(result.expected_columns) && (
                  <div className="text-xs text-slate-700">
                    <p className="mb-1"><strong>Expected columns:</strong> {result.expected_columns.join(', ')}</p>
                    {Array.isArray(result.found_columns) && (
                      <p><strong>Your file had:</strong> {result.found_columns.join(', ') || '(none)'}</p>
                    )}
                  </div>
                )}

                {Array.isArray(result.errors) && result.errors.length > 0 && (
                  <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                    <table className="min-w-full text-xs">
                      <thead className="bg-slate-100 text-[10px] font-semibold uppercase text-slate-500">
                        <tr>
                          <th className="px-2 py-1.5 text-left">Row</th>
                          <th className="px-2 py-1.5 text-left">Field</th>
                          <th className="px-2 py-1.5 text-left">Error</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {result.errors.flatMap((e) =>
                          Object.entries(e.errors || {}).map(([field, msg], i) => (
                            <tr key={`${e.row}-${field}-${i}`}>
                              <td className="px-2 py-1 font-mono text-slate-700">{e.row}</td>
                              <td className="px-2 py-1 text-slate-700">{field}</td>
                              <td className="px-2 py-1 text-slate-600">
                                {Array.isArray(msg) ? msg.join('; ') : String(msg)}
                              </td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
    </Modal>
  );
}
