import { confirm } from '@/components/common/confirm';
import { useState, useEffect, useRef } from 'react';
import { Paperclip, Upload, Trash2, FileText, Image, File, Loader2, Download, X, ChevronLeft, ChevronRight, Eye, ImageOff, ExternalLink } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import toast from 'react-hot-toast';

const FILE_ICONS = {
  pdf: FileText, jpg: Image, jpeg: Image, png: Image, gif: Image, webp: Image,
  docx: FileText, xlsx: FileText, doc: FileText, xls: FileText, csv: FileText,
};

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];

function getExt(name) {
  return (name || '').split('.').pop().toLowerCase();
}

function getFileIcon(name) {
  return FILE_ICONS[getExt(name)] || File;
}

function isImage(name) {
  return IMAGE_EXTS.includes(getExt(name));
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileColor(name) {
  const ext = getExt(name);
  const map = { pdf: 'red', doc: 'blue', docx: 'blue', xls: 'green', xlsx: 'green', csv: 'green' };
  return map[ext] || 'slate';
}

/**
 * Zoho Creator-style file attachment component.
 */
export default function FileAttachments({ module, recordId, readOnly = false, deferUpload = false, onPendingChange, presetPendingFiles, baseUrl = '/api/sales/attachments/' }) {
  const [files, setFiles] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [lightbox, setLightbox] = useState(null); // index into imageFiles
  // Image URLs that already failed to load. Used to swap the grid +
  // lightbox <img> for an inline file-type fallback so the user never
  // sees the browser's broken-image glyph.
  const [failedImageIds, setFailedImageIds] = useState(new Set());
  const markImageFailed = (id) => setFailedImageIds(prev => new Set(prev).add(id));
  const inputRef = useRef(null);
  const dropRef = useRef(null);
  // Tracks files we've already absorbed from presetPendingFiles so a
  // re-render of the parent doesn't keep re-adding the same file. Holds
  // the `name::size` keys.
  const seededKeysRef = useRef(new Set());

  useEffect(() => {
    if (!recordId) return;
    setIsLoading(true);
    apiClient.get(baseUrl, { params: { module, record_id: recordId } })
      .then(res => setFiles(res.data?.results || res.data || []))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [module, recordId, baseUrl]);

  // Auto-seed pending files from the parent. Used by the Customer PO
  // Auto Extractor to attach the uploaded PO without forcing the user to
  // pick it again from disk. We track previously-seeded files so a
  // re-upload (parent swaps the preset) removes the prior preset file
  // and adds the new one, instead of piling up both.
  useEffect(() => {
    const incoming = (presetPendingFiles || []).filter(Boolean);
    const incomingKeys = new Set(incoming.map(f => `${f.name}::${f.size}`));
    const prevKeys = seededKeysRef.current;
    // Remove previously-seeded files that aren't in the new preset.
    const toRemove = new Set();
    prevKeys.forEach(k => { if (!incomingKeys.has(k)) toRemove.add(k); });
    // Add new files that aren't already pending (whether from a previous
    // seed or from manual user action).
    setPendingFiles(prev => {
      const survivingKeys = new Set(prev.map(f => `${f.name}::${f.size}`));
      const filtered = prev.filter(f => !toRemove.has(`${f.name}::${f.size}`));
      const additions = incoming.filter(f => !survivingKeys.has(`${f.name}::${f.size}`));
      if (additions.length === 0 && filtered.length === prev.length) {
        return prev;  // no-op, avoid re-render loop
      }
      const merged = [...filtered, ...additions];
      onPendingChange?.(merged);
      return merged;
    });
    seededKeysRef.current = incomingKeys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetPendingFiles]);

  const isDuplicate = (file) => {
    return files.some(f => f.file_name === file.name && f.file_size === file.size)
      || pendingFiles.some(f => f.name === file.name && f.size === file.size);
  };

  const processFiles = async (selected) => {
    if (selected.length === 0) return;
    const duplicates = selected.filter(f => isDuplicate(f));
    const unique = selected.filter(f => !isDuplicate(f));
    if (duplicates.length > 0) toast.error(`Duplicate${duplicates.length > 1 ? 's' : ''} skipped: ${duplicates.map(f => f.name).join(', ')}`);
    if (unique.length === 0) return;

    if (!recordId || deferUpload) {
      setPendingFiles(prev => { const u = [...prev, ...unique]; onPendingChange?.(u); return u; });
      return;
    }

    setIsUploading(true);
    let uploaded = 0;
    for (const file of unique) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('module', module);
        fd.append('record_id', recordId);
        const res = await apiClient.post(baseUrl, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        setFiles(prev => [res.data, ...prev]);
        uploaded++;
      } catch { toast.error(`Failed to upload ${file.name}`); }
    }
    if (uploaded > 0) toast.success(`${uploaded} file(s) uploaded`);
    setIsUploading(false);
  };

  const handleFileSelect = (e) => {
    processFiles(Array.from(e.target.files || []));
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (readOnly) return;
    processFiles(Array.from(e.dataTransfer.files || []));
  };

  const handleDragOver = (e) => { e.preventDefault(); if (!readOnly) setIsDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); setIsDragging(false); };

  const handleDelete = async (attachment) => {
    if (!(await confirm({ message: `Delete ${attachment.file_name}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`${baseUrl}${attachment.id}/`);
      setFiles(prev => prev.filter(f => f.id !== attachment.id));
      toast.success('File deleted');
    } catch { toast.error('Failed to delete file'); }
  };

  const removePending = (idx) => {
    setPendingFiles(prev => { const u = prev.filter((_, i) => i !== idx); onPendingChange?.(u); return u; });
  };

  const allFiles = [
    ...files.map(f => ({ ...f, source: 'server' })),
    ...pendingFiles.map((f, i) => ({ id: `pending-${i}`, file_name: f.name, file_size: f.size, source: 'pending', rawFile: f })),
  ];

  const imageFiles = allFiles.filter(f => isImage(f.file_name));
  const docFiles = allFiles.filter(f => !isImage(f.file_name));

  const getSrc = (file) => file.source === 'pending' ? URL.createObjectURL(file.rawFile) : file.file;

  const handleRemoveFile = (file) => {
    if (file.source === 'pending') {
      const idx = pendingFiles.findIndex((_, i) => `pending-${i}` === file.id);
      if (idx >= 0) removePending(idx);
    } else {
      handleDelete(file);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 mt-4 sm:mt-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Paperclip size={18} className="text-slate-500" />
          <h3 className="text-base font-semibold text-slate-800">
            Attachments {allFiles.length > 0 && <span className="text-slate-400 font-normal text-sm">({allFiles.length})</span>}
          </h3>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
          >
            {isUploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {isUploading ? 'Uploading...' : 'Upload'}
          </button>
        )}
      </div>

      <input ref={inputRef} type="file" multiple onChange={handleFileSelect} accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.docx,.xlsx,.doc,.xls,.csv" className="hidden" />

      {/* Drop zone (non-readOnly) */}
      {!readOnly && (
        <div
          ref={dropRef}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
          className={`mb-4 border-2 border-dashed rounded-lg p-4 sm:p-6 text-center cursor-pointer transition
            ${isDragging ? 'border-blue-400 bg-blue-50' : 'border-slate-300 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/50'}`}
        >
          <Upload size={28} className={`mx-auto mb-2 ${isDragging ? 'text-blue-500' : 'text-slate-400'}`} />
          <p className="text-sm font-medium text-slate-600">
            {isDragging ? 'Drop files here' : 'Drag & drop files here or click to browse'}
          </p>
          <p className="text-xs text-slate-400 mt-1">PDF, Images, Word, Excel, CSV</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin text-slate-400" />
        </div>
      ) : allFiles.length === 0 ? (
        <div className="text-center py-8">
          <File size={32} className="mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-400">No attachments yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Image Gallery */}
          {imageFiles.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Images ({imageFiles.length})</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {imageFiles.map((file, idx) => {
                  const isPending = file.source === 'pending';
                  const src = getSrc(file);
                  const broken = failedImageIds.has(file.id);
                  return (
                    <div key={file.id} className={`relative group rounded-lg overflow-hidden border ${isPending ? 'border-amber-300' : 'border-slate-200'} bg-white shadow-sm hover:shadow-md transition`}>
                      <div
                        className="aspect-square overflow-hidden bg-slate-100 flex items-center justify-center cursor-pointer"
                        onClick={() => setLightbox(idx)}
                        title={broken ? `${file.file_name} — preview unavailable, click to open` : file.file_name}
                      >
                        {broken ? (
                          // Fallback panel when the URL fails to load
                          // (CORS, expired signed URL, deleted file).
                          // Same dimensions as the image so the grid
                          // layout doesn't reflow.
                          <div className="flex flex-col items-center justify-center text-slate-400 px-2 text-center">
                            <ImageOff size={28} className="mb-1" />
                            <span className="text-[10px] leading-tight">Preview unavailable</span>
                          </div>
                        ) : (
                          <img
                            src={src}
                            alt={file.file_name}
                            className="w-full h-full object-cover transition group-hover:scale-105"
                            onError={() => markImageFailed(file.id)}
                          />
                        )}
                      </div>
                      {/* Hover overlay */}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition flex items-center justify-center opacity-0 group-hover:opacity-100">
                        <button onClick={() => setLightbox(idx)} className="p-2 bg-white/90 rounded-full text-slate-700 hover:bg-white mr-1.5 shadow">
                          <Eye size={16} />
                        </button>
                        <a href={src} download={file.file_name} className="p-2 bg-white/90 rounded-full text-slate-700 hover:bg-white mr-1.5 shadow" onClick={e => e.stopPropagation()}>
                          <Download size={16} />
                        </a>
                        {!readOnly && (
                          <button onClick={(e) => { e.stopPropagation(); handleRemoveFile(file); }} className="p-2 bg-white/90 rounded-full text-red-600 hover:bg-red-50 shadow">
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                      {/* Name bar */}
                      <div className="px-2 py-1.5">
                        <p className="text-xs font-medium text-slate-700 truncate" title={file.file_name}>{file.file_name}</p>
                        <p className="text-[10px] text-slate-400">{formatBytes(file.file_size)}{isPending ? ' - pending' : ''}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Document Files */}
          {docFiles.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Documents ({docFiles.length})</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {docFiles.map((file) => {
                  const Icon = getFileIcon(file.file_name);
                  const isPending = file.source === 'pending';
                  const ext = getExt(file.file_name).toUpperCase();
                  const color = getFileColor(file.file_name);
                  const colorClasses = {
                    red: 'bg-red-50 text-red-600 border-red-200',
                    blue: 'bg-blue-50 text-blue-600 border-blue-200',
                    green: 'bg-green-50 text-green-600 border-green-200',
                    slate: 'bg-slate-50 text-slate-600 border-slate-200',
                  };
                  const src = getSrc(file);
                  return (
                    <div
                      key={file.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border bg-white hover:shadow-sm transition cursor-pointer group ${isPending ? 'border-amber-200' : 'border-slate-200'}`}
                      onClick={() => window.open(src, '_blank')}
                      title="Click to view"
                    >
                      <div className={`w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 border ${colorClasses[color]}`}>
                        <Icon size={20} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate group-hover:text-blue-700 transition" title={file.file_name}>{file.file_name}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {ext} &middot; {formatBytes(file.file_size)}
                          {isPending && ' &middot; pending'}
                          {file.uploaded_by_name && ` &middot; ${file.uploaded_by_name}`}
                        </p>
                      </div>
                      {/* Action buttons. View + Download always visible
                          (was hover-only — users didn't realize the row
                          was clickable to preview); Delete stays hover-
                          only so the trash icon doesn't dominate the
                          card when the user is just browsing. */}
                      <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => window.open(src, '_blank')}
                          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
                          title="View"
                        >
                          <Eye size={15} />
                        </button>
                        <a href={src} download={file.file_name} className="p-1.5 text-slate-600 hover:bg-slate-100 rounded transition" title="Download">
                          <Download size={15} />
                        </a>
                        {!readOnly && (
                          <button onClick={() => handleRemoveFile(file)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition opacity-0 group-hover:opacity-100" title="Delete">
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightbox !== null && imageFiles[lightbox] && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setLightbox(null)}>
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 p-2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition">
            <X size={24} />
          </button>
          {imageFiles.length > 1 && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); setLightbox((lightbox - 1 + imageFiles.length) % imageFiles.length); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 p-2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition"
              >
                <ChevronLeft size={28} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setLightbox((lightbox + 1) % imageFiles.length); }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition"
              >
                <ChevronRight size={28} />
              </button>
            </>
          )}
          <div className="max-w-5xl max-h-[85dvh] p-4" onClick={e => e.stopPropagation()}>
            {/* Same broken-URL fallback as the gallery: when <img>
                errors, show a clean "open in new tab" panel instead
                of letting the browser's broken-image glyph through. */}
            {failedImageIds.has(imageFiles[lightbox].id) ? (
              <div className="flex flex-col items-center justify-center text-center p-10 bg-slate-900/40 rounded-lg shadow-2xl max-w-md mx-auto">
                <ImageOff size={56} className="text-white/60 mb-4" />
                <p className="text-white text-sm font-semibold mb-1">Couldn&apos;t preview this image</p>
                <p className="text-white/60 text-xs mb-5">
                  The file is there, but the browser couldn&apos;t render it inline
                  (often a CORS or expired-link issue on the file store).
                </p>
                <a
                  href={getSrc(imageFiles[lightbox])}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-white text-slate-800 rounded-lg text-sm font-medium hover:bg-slate-100 transition"
                  onClick={e => e.stopPropagation()}
                >
                  <ExternalLink size={14} /> Open in new tab
                </a>
              </div>
            ) : (
              <img
                src={getSrc(imageFiles[lightbox])}
                alt={imageFiles[lightbox].file_name}
                className="max-w-full max-h-[80dvh] object-contain rounded-lg shadow-2xl"
                onError={() => markImageFailed(imageFiles[lightbox].id)}
              />
            )}
            <div className="text-center mt-3">
              <p className="text-white text-sm font-medium">{imageFiles[lightbox].file_name}</p>
              <p className="text-white/60 text-xs mt-0.5">{formatBytes(imageFiles[lightbox].file_size)} &middot; {lightbox + 1} of {imageFiles.length}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Upload pending files for a newly created record.
 */
export async function uploadPendingFiles(module, recordId, pendingFiles, baseUrl = '/api/sales/attachments/') {
  const seen = new Set();
  const uniqueFiles = pendingFiles.filter(f => {
    const key = `${f.name}::${f.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let uploaded = 0;
  for (const file of uniqueFiles) {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('module', module);
      fd.append('record_id', recordId);
      await apiClient.post(baseUrl, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      uploaded++;
    } catch { console.error(`Failed to upload ${file.name}`); }
  }
  return uploaded;
}
