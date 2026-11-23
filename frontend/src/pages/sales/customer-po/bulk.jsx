import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Upload, FileText, RefreshCw, Loader2, X, Eye, AlertTriangle } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { uploadPendingFiles } from '../components/FileAttachments';

// ── Bulk Customer PO upload ─────────────────────────────────────────
// Drop up to MAX_FILES PO files; each one runs through the Gemini
// /extract/ endpoint and then /create-draft-from-extraction/ to become
// a DRAFT Customer PO. Files are processed automatically as they are
// added, at most MAX_CONCURRENT at a time (the extract endpoint is
// slow — 30-120s per file — so we pipeline two while the rest queue).
const MAX_FILES = 15;
const MAX_CONCURRENT = 2;
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx';
const ACCEPT_EXTS = ACCEPT.split(',');

const STATUS_META = {
  queued:     { label: 'Queued',              cls: 'bg-slate-100 text-slate-600' },
  extracting: { label: 'Extracting…',         cls: 'bg-blue-100 text-blue-700' },
  creating:   { label: 'Creating draft…',     cls: 'bg-blue-100 text-blue-700' },
  created:    { label: 'Draft created',       cls: 'bg-green-100 text-green-700' },
  unresolved: { label: 'Customer unresolved', cls: 'bg-amber-100 text-amber-700' },
  duplicate:  { label: 'Duplicate',           cls: 'bg-slate-100 text-slate-600' },
  failed:     { label: 'Failed',              cls: 'bg-red-100 text-red-700' },
  interrupted:{ label: 'Interrupted',         cls: 'bg-amber-100 text-amber-700' },
};

const TERMINAL = new Set(['created', 'unresolved', 'duplicate', 'failed', 'interrupted']);

// Persist the queue across navigation so leaving to Review a draft and
// coming Back doesn't wipe the batch's statuses. The File objects can't be
// serialised, so we store everything else (statuses, results, the
// extraction needed for manual review) keyed by name/size; on restore a
// row has no File, so it's display-only (Retry needs the original file).
const STORAGE_KEY = 'bulk_po_queue';

const persistRows = (rows) => {
  try {
    if (!rows.length) { sessionStorage.removeItem(STORAGE_KEY); return; }
    const serialisable = rows.map(({ file, ...r }) => r); // drop the File
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(serialisable));
  } catch { /* quota / disabled storage — persistence is best-effort */ }
};

const restoreRows = () => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    // A row mid-flight when the page unmounted can't resume (no File).
    // Mark it 'interrupted' — NOT 'failed': the draft may well have been
    // created on the backend already. Re-uploading reconciles safely
    // because the create endpoint dedupes on (customer, po_number) and
    // returns the existing draft as a 'duplicate' link, never a 2nd copy.
    return saved.map(r => (
      TERMINAL.has(r.status)
        ? { ...r, file: null }
        : { ...r, file: null, status: 'interrupted',
            error: 'Interrupted before the result was confirmed — the draft may already have saved. '
                 + 'Re-upload this file to reconcile: you’ll get the new draft, or a “Duplicate” '
                 + 'link if it already saved (never a double entry).' }
    ));
  } catch { return []; }
};

const formatBytes = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const fileKey = (f) => `${f.name}::${f.size}`;

export default function CustomerPOBulkUpload() {
  const navigate = useNavigate();
  // Row shape: { key, file (File — kept for Retry + attachment upload),
  //   status, extraction, confidence, draftId, uploadId, manualReview,
  //   flags, duplicateOf, reason, error }
  const [rows, setRows] = useState(restoreRows);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);
  // Mirror every rows change into sessionStorage so the batch survives a
  // Review round-trip (and a Back navigation shows the same statuses).
  useEffect(() => { persistRows(rows); }, [rows]);
  // Keys currently being processed. Bridges the gap between kicking a
  // file off and React committing its 'extracting' status, so the pump
  // effect (and StrictMode's double-invoke) never starts a file twice.
  const inFlight = useRef(new Set());
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const updateRow = useCallback((key, patch) => {
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  // ── Adding files ───────────────────────────────────────────────────
  const addFiles = (incoming) => {
    const picked = Array.from(incoming || []);
    if (picked.length === 0) return;

    const supported = picked.filter(f =>
      ACCEPT_EXTS.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (supported.length < picked.length) {
      toast.error(`Skipped ${picked.length - supported.length} unsupported file(s). Allowed: ${ACCEPT}`);
    }

    // Dedupe by name+size against rows already on the page AND within
    // the incoming selection itself.
    const existing = new Set(rowsRef.current.map(r => r.key));
    const fresh = [];
    for (const f of supported) {
      const k = fileKey(f);
      if (existing.has(k)) continue;
      existing.add(k);
      fresh.push(f);
    }
    if (fresh.length === 0) return;

    const room = MAX_FILES - rowsRef.current.length;
    if (fresh.length > room) {
      toast.error(`Maximum ${MAX_FILES} files per batch — keeping the first ${Math.max(room, 0)}.`);
    }
    const accepted = fresh.slice(0, Math.max(room, 0));
    if (accepted.length === 0) return;

    setRows(prev => [
      ...prev,
      ...accepted.map(f => ({
        key: fileKey(f), file: f, fileName: f.name, fileSize: f.size, status: 'queued',
        extraction: null, confidence: null,
        draftId: null, uploadId: null, manualReview: false, flags: [],
        duplicateOf: null, reason: null, error: null,
      })),
    ]);
  };

  const removeRow = (key) => setRows(prev => prev.filter(r => r.key !== key));

  // ── Per-file pipeline: extract → create draft → attach file ───────
  const processRow = useCallback(async (row) => {
    const { key, file } = row;
    // A restored row (from a previous session) has no File to re-send.
    if (!file) {
      updateRow(key, { status: 'failed', error: 'File no longer in memory — remove and re-upload.' });
      inFlight.current.delete(key);
      return;
    }
    try {
      updateRow(key, { status: 'extracting', error: null });
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/api/sales/customer-po/extract/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180000,
      });
      const extraction = res.data;
      const confidence = extraction?.overall_confidence ?? null;
      // Keep the extraction on the row — the "Review manually" path for
      // unresolved customers hands it to the Create page via
      // sessionStorage.
      updateRow(key, { status: 'creating', extraction, confidence });

      const draftRes = await apiClient.post('/api/sales/customer-po/create-draft-from-extraction/', {
        extraction, file_name: file.name,
      });
      const outcome = draftRes.data || {};

      if (outcome.status === 'created') {
        // Attach the original file to the new draft. Non-fatal: the
        // draft already exists, the helper logs per-file failures.
        try { await uploadPendingFiles('CUSTOMER_PO', outcome.id, [file]); } catch { /* non-fatal */ }
        updateRow(key, {
          status: 'created', draftId: outcome.id, uploadId: outcome.upload_id,
          manualReview: !!outcome.manual_review_required, flags: outcome.flags || [],
        });
      } else if (outcome.status === 'duplicate') {
        updateRow(key, { status: 'duplicate', duplicateOf: outcome.duplicate_of || null });
      } else if (outcome.status === 'unresolved') {
        updateRow(key, { status: 'unresolved', reason: outcome.reason || 'Customer could not be matched' });
      } else {
        updateRow(key, { status: 'failed', error: outcome.reason || outcome.error || 'Unexpected server response' });
      }
    } catch (err) {
      const msg = err?.response?.data?.error || getApiErrorMessage(err) || 'Processing failed';
      updateRow(key, { status: 'failed', error: msg });
    } finally {
      inFlight.current.delete(key);
    }
  }, [updateRow]);

  // Queue pump — starts queued files whenever a slot frees up. Terminal
  // rows are never re-picked (Retry flips them back to 'queued').
  useEffect(() => {
    const slots = MAX_CONCURRENT - inFlight.current.size;
    if (slots <= 0) return;
    const next = rows.filter(r => r.status === 'queued' && !inFlight.current.has(r.key)).slice(0, slots);
    next.forEach(r => {
      inFlight.current.add(r.key);
      processRow(r);
    });
  }, [rows, processRow]);

  const retryRow = (key) => updateRow(key, {
    status: 'queued', error: null, extraction: null, confidence: null,
    draftId: null, uploadId: null, manualReview: false, flags: [], duplicateOf: null, reason: null,
  });

  const reviewUnresolved = (row) => {
    sessionStorage.setItem('bulk_po_review', JSON.stringify({ extraction: row.extraction, fileName: row.fileName || row.file?.name || '' }));
    navigate('/sales/customer-po/new?bulkReview=1');
  };

  // ── Summary strip counts ───────────────────────────────────────────
  const summary = useMemo(() => ({
    created:    rows.filter(r => r.status === 'created').length,
    needReview: rows.filter(r => r.status === 'created' && r.manualReview).length,
    unresolved: rows.filter(r => r.status === 'unresolved').length,
    duplicates: rows.filter(r => r.status === 'duplicate').length,
    failed:     rows.filter(r => r.status === 'failed').length,
    interrupted:rows.filter(r => r.status === 'interrupted').length,
  }), [rows]);
  const processing = rows.some(r => !TERMINAL.has(r.status));

  // Guard against a reload/close wiping an in-flight batch: File objects
  // can't be persisted, so a mid-flight row can't auto-resume. Warn while
  // any file is still extracting/creating.
  useEffect(() => {
    if (!processing) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [processing]);

  return (
    <MainLayout>
      <PageHeader
        title="Bulk Upload Customer POs"
        subtitle={`Upload up to ${MAX_FILES} customer PO files — each becomes a DRAFT Customer PO for review`}
        breadcrumbs={[
          { label: 'Sales', path: '/sales' },
          { label: 'Customer PO', path: '/sales/customer-po' },
          { label: 'Bulk Upload' },
        ]}
      />

      <div className="space-y-4">
        {/* Drop zone */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
          className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition
            ${isDragging ? 'border-blue-400 bg-blue-50' : 'border-slate-300 bg-white hover:border-blue-300 hover:bg-slate-50'}`}
        >
          <input
            ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
          <Upload size={28} className="mx-auto text-slate-400 mb-2" />
          <p className="text-sm font-medium text-slate-700">Drop PO files here, or click to browse</p>
          <p className="text-xs text-slate-500 mt-1">
            PDF, PNG, JPG or DOCX · up to {MAX_FILES} files per batch · {rows.length}/{MAX_FILES} added
          </p>
        </div>

        {processing && (
          <p className="text-xs text-amber-600">
            Files are still processing — keep this tab open. Opening or reviewing a draft launches a
            new tab, so the rest of the batch keeps running.
          </p>
        )}

        {/* Summary strip */}
        {rows.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 px-4 py-3 flex items-center gap-x-4 gap-y-1 flex-wrap text-sm">
            {processing && <Loader2 size={15} className="animate-spin text-blue-600" />}
            <span className="font-medium text-green-700">{summary.created} created</span>
            <span className="text-slate-300">·</span>
            <span className="font-medium text-amber-700">{summary.needReview} need review</span>
            <span className="text-slate-300">·</span>
            <span className="font-medium text-amber-700">{summary.unresolved} unresolved</span>
            <span className="text-slate-300">·</span>
            <span className="font-medium text-slate-600">{summary.duplicates} duplicates</span>
            <span className="text-slate-300">·</span>
            <span className="font-medium text-red-600">{summary.failed} failed</span>
            {summary.interrupted > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="font-medium text-amber-700">{summary.interrupted} interrupted</span>
              </>
            )}
          </div>
        )}

        {/* File queue table */}
        {rows.length > 0 && (
          <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="px-4 py-2.5">File</th>
                  <th className="px-4 py-2.5 w-24">Confidence</th>
                  <th className="px-4 py-2.5 w-40">Status</th>
                  <th className="px-4 py-2.5">Result</th>
                  <th className="px-4 py-2.5 w-40">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const meta = STATUS_META[row.status] || STATUS_META.queued;
                  const busy = row.status === 'extracting' || row.status === 'creating';
                  return (
                    <tr key={row.key} className="border-b border-slate-100 last:border-b-0 align-top">
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-2 min-w-[180px]">
                          <FileText size={16} className="text-slate-400 mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium text-slate-800 break-all">{row.fileName || row.file?.name}</p>
                            <p className="text-xs text-slate-400">{formatBytes(row.fileSize ?? row.file?.size)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                        {row.confidence != null ? `${Math.round(Number(row.confidence) * 100)}%` : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${meta.cls}`}>
                          {busy && <Loader2 size={12} className="animate-spin" />}
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {row.status === 'created' && (
                          <div className="space-y-1 min-w-[160px]">
                            <a
                              href={`/sales/customer-po/${row.draftId}`}
                              target="_blank" rel="opener"
                              className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                              title="Open this DRAFT in a new tab (keeps the batch processing)"
                            >
                              {row.uploadId}
                            </a>
                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 uppercase tracking-wide">Draft</span>
                            {row.manualReview && (
                              <div className="flex items-start gap-1.5">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 shrink-0">
                                  <AlertTriangle size={11} /> Needs review
                                </span>
                                {row.flags?.length > 0 && (
                                  <span className="text-xs text-slate-500">{row.flags.join('; ')}</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {row.status === 'unresolved' && (
                          <p className="text-xs text-amber-700 min-w-[160px]">{row.reason}</p>
                        )}
                        {row.status === 'duplicate' && (
                          <p className="text-xs text-slate-600 min-w-[160px]">
                            Duplicate of{' '}
                            {row.duplicateOf?.id ? (
                              <a
                                href={`/sales/customer-po/${row.duplicateOf.id}`}
                                target="_blank" rel="opener"
                                className="text-blue-700 hover:text-blue-900 hover:underline font-medium"
                              >
                                {row.duplicateOf.upload_id || 'existing PO'}
                              </a>
                            ) : (
                              <span className="font-medium">{row.duplicateOf?.upload_id || 'an existing PO'}</span>
                            )}
                          </p>
                        )}
                        {row.status === 'failed' && (
                          <p className="text-xs text-red-600 min-w-[160px]">{row.error}</p>
                        )}
                        {row.status === 'interrupted' && (
                          <p className="text-xs text-amber-700 min-w-[160px]">{row.error}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {row.status === 'created' && (
                            <a
                              href={`/sales/customer-po/new?draft=${row.draftId}`}
                              target="_blank" rel="opener"
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-blue-300 text-xs font-medium text-blue-700 hover:bg-blue-50 whitespace-nowrap"
                              title="Review in a new tab (keeps the batch processing)"
                            >
                              <Eye size={13} /> Review
                            </a>
                          )}
                          {row.status === 'unresolved' && (
                            <button
                              onClick={() => reviewUnresolved(row)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-300 text-xs font-medium text-amber-700 hover:bg-amber-50 whitespace-nowrap"
                            >
                              <Eye size={13} /> Review manually
                            </button>
                          )}
                          {row.status === 'failed' && row.file && (
                            <button
                              onClick={() => retryRow(row.key)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                            >
                              <RefreshCw size={13} /> Retry
                            </button>
                          )}
                          {!busy && (
                            <button
                              onClick={() => removeRow(row.key)}
                              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                              title="Remove from list" aria-label="Remove from list"
                            >
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
