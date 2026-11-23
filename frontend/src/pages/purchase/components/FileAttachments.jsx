import { useState, useEffect, useRef } from 'react';
import { Paperclip, Upload, Trash2, FileText, Image, File, Loader2 } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import toast from 'react-hot-toast';
import { confirm } from '@/components/common/confirm';

const FILE_ICONS = {
  pdf: FileText, jpg: Image, jpeg: Image, png: Image,
  docx: FileText, xlsx: FileText, doc: FileText, xls: FileText,
};

function getFileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const Icon = FILE_ICONS[ext] || File;
  return Icon;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Reusable file attachment component for all purchase module pages.
 *
 * Props:
 *   module          - 'PR' | 'RFQ' | 'QUOTE' | 'PO' | 'RECEIPT' | 'BILL' | etc.
 *   recordId        - UUID of the record (null for new records — files upload after save)
 *   readOnly        - if true, only show existing files, no upload/delete
 *   deferUntilSave  - if true, files are queued in pending state even when recordId exists
 *                     (parent must call uploadPendingFiles after saving)
 */
export default function FileAttachments({ module, recordId, readOnly = false, onPendingChange, deferUntilSave = false, presetPendingFiles, className = '', compact = false, showPreview = false }) {
  const [files, setFiles] = useState([]);
  // Opt-in inline preview of the first image/PDF attachment — e.g. the scanned
  // bill on the Vendor Bill page, so a reviewer can compare it with the booked
  // figures without opening a separate tab.
  const [preview, setPreview] = useState(null);   // { url, name, isPdf }
  const [previewOpen, setPreviewOpen] = useState(true);
  const [pendingFiles, setPendingFiles] = useState([]); // files to upload (for new records)
  const pendingRef = useRef([]); // ref to always hold the latest pending files
  const absorbedRef = useRef(new Set()); // preset files already pulled in (avoid re-adding)
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef(null);

  // Absorb caller-supplied pending files (e.g. a recorded voice note) into the
  // pending list so they show here and upload with everything else on save.
  useEffect(() => {
    const incoming = (presetPendingFiles || []).filter(Boolean);
    if (incoming.length === 0) return;
    const keyOf = (f) => `${f.name}::${f.size}`;
    setPendingFiles((prev) => {
      let merged = prev;
      for (const f of incoming) {
        const k = keyOf(f);
        if (absorbedRef.current.has(k)) continue;
        absorbedRef.current.add(k);
        if (!merged.some((p) => keyOf(p) === k)) merged = [...merged, f];
      }
      if (merged !== prev) {
        pendingRef.current = merged;
        onPendingChange?.(merged);
      }
      return merged;
    });
  }, [presetPendingFiles]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Load existing attachments
  useEffect(() => {
    if (!recordId) return;
    setIsLoading(true);
    apiClient.get('/api/purchase/attachments/', { params: { module, record_id: recordId } })
      .then(res => setFiles(res.data?.results || res.data || []))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [module, recordId]);

  // Mint a signed URL for the first previewable attachment (image / PDF) so it
  // can render inline. Runs only when the caller opts in (showPreview).
  useEffect(() => {
    if (!showPreview) { setPreview(null); return; }
    const previewable = files.find((f) => /\.(pdf|jpe?g|png|webp)$/i.test(f.file_name || ''));
    if (!previewable) { setPreview(null); return; }
    let alive = true;
    apiClient.get(`/api/purchase/attachments/${previewable.id}/signed-url/`)
      .then((res) => {
        if (!alive) return;
        const url = res.data?.url;
        if (url) setPreview({ url, name: previewable.file_name, isPdf: /\.pdf$/i.test(previewable.file_name || '') });
      })
      .catch(() => { if (alive) setPreview(null); });
    return () => { alive = false; };
  }, [showPreview, files]);

  // Upload files
  const handleFileSelect = async (e) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;

    if (!recordId || deferUntilSave) {
      // No record yet OR parent wants to defer until Save — store locally
      const updated = [...pendingRef.current, ...selected];
      pendingRef.current = updated;
      setPendingFiles(updated);
      onPendingChange?.(updated);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setIsUploading(true);
    let uploaded = 0;
    for (const file of selected) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('module', module);
        fd.append('record_id', recordId);
        const res = await apiClient.post('/api/purchase/attachments/', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        setFiles(prev => [res.data, ...prev]);
        uploaded++;
      } catch (err) {
        toast.error(`Failed to upload ${file.name}`);
      }
    }
    if (uploaded > 0) toast.success(`${uploaded} file(s) uploaded`);
    setIsUploading(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  // Delete
  const handleDelete = async (attachment) => {
    if (!(await confirm({ message: `Delete ${attachment.file_name}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/attachments/${attachment.id}/`);
      setFiles(prev => prev.filter(f => f.id !== attachment.id));
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  };

  // Remove pending file
  const removePending = (idx) => {
    const updated = pendingRef.current.filter((_, i) => i !== idx);
    pendingRef.current = updated;
    setPendingFiles(updated);
    onPendingChange?.(updated);
  };

  // Open an uploaded attachment by minting a FRESH signed URL on click — the URL
  // embedded in the list is a presigned R2 link that expires after an hour, so a
  // later click fails with "Failed to load PDF". Pending (not-yet-uploaded) files
  // open from a local object URL.
  const openFile = async (file) => {
    if (file.source === 'pending') { window.open(URL.createObjectURL(file.rawFile), '_blank'); return; }
    const win = window.open('', '_blank');   // open synchronously so it isn't popup-blocked
    try {
      const res = await apiClient.get(`/api/purchase/attachments/${file.id}/signed-url/`);
      const url = res.data?.url;
      if (!url) throw new Error('no url');
      if (win) win.location.href = url; else window.open(url, '_blank');
    } catch {
      if (win) win.close();
      toast.error('Could not open the file. Try again.');
    }
  };

  const allFiles = [
    ...files.map(f => ({ ...f, source: 'server' })),
    ...pendingFiles.map((f, i) => ({ id: `pending-${i}`, file_name: f.name, file_size: f.size, source: 'pending', rawFile: f })),
  ];

  return (
    <div className={`bg-white rounded-lg border border-slate-200 ${compact ? 'p-2' : 'p-3.5 sm:p-5'} ${className || (compact ? '' : 'mt-4 sm:mt-6')}`}>
      <div className={`flex items-center justify-between ${compact ? 'mb-1.5' : 'mb-3'}`}>
        {compact ? (
          <span className="text-[11px] text-slate-400">{allFiles.length > 0 ? `${allFiles.length} file(s)` : ''}</span>
        ) : (
          <div className="flex items-center gap-2">
            <Paperclip size={16} className="text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-800">
              Attachments {allFiles.length > 0 && `(${allFiles.length})`}
            </h3>
          </div>
        )}
        {!readOnly && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.doc,.xls,.csv"
              className="hidden"
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={isUploading}
              className={`flex items-center gap-1.5 font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 transition disabled:opacity-50 ${compact ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'}`}
            >
              {isUploading ? <Loader2 size={compact ? 12 : 14} className="animate-spin" /> : <Upload size={compact ? 12 : 14} />}
              {isUploading ? 'Uploading...' : (compact ? 'Upload' : 'Upload Files')}
            </button>
          </>
        )}
      </div>

      {/* Inline preview of the scanned bill — compare against the figures. */}
      {showPreview && preview && (
        <div className="mb-3 rounded-lg border border-slate-200 overflow-hidden">
          <button type="button" onClick={() => setPreviewOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-3 py-1.5 bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600 hover:bg-slate-100">
            <span className="truncate">Scanned bill — {preview.name}</span>
            <span className="text-slate-400">{previewOpen ? 'Hide' : 'Show'}</span>
          </button>
          {previewOpen && (
            preview.isPdf ? (
              <iframe title="Scanned bill" src={`${preview.url}#toolbar=0&navpanes=0`}
                className="w-full h-[60vh] bg-slate-100" />
            ) : (
              <div className="max-h-[60vh] overflow-auto bg-slate-100 flex justify-center">
                <img src={preview.url} alt="Scanned bill" className="max-w-full h-auto" />
              </div>
            )
          )}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-4 sm:py-6">
          <Loader2 size={20} className="animate-spin text-slate-400" />
        </div>
      ) : allFiles.length === 0 ? (
        <p className={`text-xs text-slate-400 text-center ${compact ? 'py-1.5' : 'py-4'}`}>No attachments</p>
      ) : (
        <div className="space-y-2">
          {allFiles.map((file) => {
            const Icon = getFileIcon(file.file_name);
            const isPending = file.source === 'pending';
            return (
              <div
                key={file.id}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-sm ${
                  isPending ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <Icon size={16} className={isPending ? 'text-amber-500' : 'text-slate-500'} />
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openFile(file)}>
                  <p className="text-sm font-medium text-primary-600 hover:text-primary-800 hover:underline truncate">{file.file_name}</p>
                  <p className="text-xs text-slate-400">
                    {formatBytes(file.file_size)}
                    {isPending && ' — pending upload'}
                    {file.uploaded_by_name && ` — ${file.uploaded_by_name}`}
                  </p>
                </div>
                {(file.file || isPending) && (
                  <button
                    type="button"
                    onClick={() => openFile(file)}
                    className="text-xs text-primary-600 hover:underline flex-shrink-0"
                  >
                    View
                  </button>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => isPending ? removePending(pendingFiles.indexOf(pendingFiles.find((_, i) => `pending-${i}` === file.id))) : handleDelete(file)}
                    className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Upload pending files for a newly created record.
 * Call this after saving the record and getting the ID.
 */
export async function uploadPendingFiles(module, recordId, pendingFiles) {
  if (!pendingFiles || pendingFiles.length === 0) return 0;
  let uploaded = 0;
  const failed = [];
  for (const file of pendingFiles) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('module', module);
      fd.append('record_id', recordId);
      await apiClient.post('/api/purchase/attachments/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      uploaded++;
    } catch (err) {
      console.error(`Failed to upload ${file.name}:`, err);
      failed.push(file.name);
    }
  }
  // Notify user of results
  const toast = (await import('react-hot-toast')).default;
  if (uploaded > 0) toast.success(`${uploaded} file(s) uploaded`);
  if (failed.length > 0) toast.error(`Failed to upload: ${failed.join(', ')}`);
  return uploaded;
}
