import { useState, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, FileText, FileSpreadsheet, File, ImageOff, ExternalLink } from 'lucide-react';
import apiClient from '../../../utils/api.js';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
function getExt(name) {
  return (name || '').split('.').pop().toLowerCase();
}
function isImage(name) {
  return IMAGE_EXTS.includes(getExt(name));
}

function getFileThumb(name) {
  const ext = getExt(name);
  const label = ext.toUpperCase();
  if (ext === 'pdf') return { bg: 'bg-red-50 border-red-200', color: 'text-red-600', label, Icon: FileText };
  if (['doc', 'docx'].includes(ext)) return { bg: 'bg-blue-50 border-blue-200', color: 'text-blue-600', label, Icon: FileText };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { bg: 'bg-green-50 border-green-200', color: 'text-green-600', label, Icon: FileSpreadsheet };
  return { bg: 'bg-slate-50 border-slate-200', color: 'text-slate-500', label, Icon: File };
}

// Per-image thumbnail with an `onError` fallback. When the URL fails
// to load (broken file, missing CORS header on R2, expired signed URL,
// network blip), we swap the broken-image icon for a clean file-type
// thumbnail so the row stays presentable. Click the fallback to open
// the file in a new tab — the browser can usually fetch what `<img>`
// couldn't because the tab nav uses the user's session cookies.
function ThumbImage({ att, onPreview }) {
  const [failed, setFailed] = useState(false);
  if (failed || !att.file) {
    const { bg, color, label, Icon } = getFileThumb(att.file_name);
    return (
      <div
        className={`w-7 h-7 rounded border overflow-hidden cursor-pointer hover:shadow transition flex-shrink-0 flex flex-col items-center justify-center ${bg}`}
        onClick={() => att.file && window.open(att.file, '_blank')}
        title={`${att.file_name} — preview unavailable, click to open`}
      >
        <Icon size={11} className={color} />
        <span className={`text-[6px] font-bold leading-none mt-0.5 ${color}`}>{label || 'IMG'}</span>
      </div>
    );
  }
  return (
    <div
      className="w-10 h-10 rounded border border-slate-200 overflow-hidden cursor-pointer hover:border-blue-400 hover:shadow transition flex-shrink-0"
      onClick={onPreview}
      title={att.file_name}
    >
      <img
        src={att.file}
        alt={att.file_name}
        className="w-full h-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/**
 * Hook: fetch all attachments for a module, grouped by record_id.
 * Call once per list page, share the map across rows.
 */
export function useListAttachments(module) {
  const [map, setMap] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!module) return;
    setLoading(true);
    apiClient.get('/api/sales/attachments/', { params: { module } })
      .then(res => {
        const list = res.data?.results || res.data || [];
        const grouped = {};
        list.forEach(att => {
          const rid = att.record_id;
          if (!grouped[rid]) grouped[rid] = [];
          grouped[rid].push(att);
        });
        setMap(grouped);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [module]);

  return { attachmentMap: map, attachmentsLoading: loading };
}

/**
 * Render thumbnails for a record in the list table.
 * Images show as photo thumbnails, documents show as colored file-type icons.
 * Clicking images opens lightbox, clicking docs opens in new tab.
 */
export default function ListAttachments({ attachments }) {
  const [lightbox, setLightbox] = useState(null);
  // Track which lightbox-index images failed to load. Used to swap
  // the broken-image icon for an "open in new tab" placeholder so the
  // user can still access the file when the in-tab preview is blocked
  // (CORS on R2, expired signed URL, etc.).
  const [lightboxFailed, setLightboxFailed] = useState(new Set());
  const markLightboxFailed = (i) => setLightboxFailed(prev => new Set(prev).add(i));

  if (!attachments || attachments.length === 0) return <span className="text-slate-300 text-xs">-</span>;

  const images = attachments.filter(a => isImage(a.file_name));
  const allItems = attachments.slice(0, 4);
  const remaining = attachments.length - 4;

  return (
    <>
      <div className="flex items-center gap-1 flex-wrap" onClick={e => e.stopPropagation()}>
        {allItems.map((att) => {
          if (isImage(att.file_name)) {
            const imgIdx = images.findIndex(i => i.id === att.id);
            return (
              <ThumbImage
                key={att.id}
                att={att}
                onPreview={() => setLightbox(imgIdx)}
              />
            );
          }
          const { bg, color, label, Icon } = getFileThumb(att.file_name);
          return (
            <div
              key={att.id}
              className={`w-7 h-7 rounded border overflow-hidden cursor-pointer hover:shadow transition flex-shrink-0 flex flex-col items-center justify-center ${bg}`}
              onClick={() => window.open(att.file, '_blank')}
              title={att.file_name}
            >
              <Icon size={11} className={color} />
              <span className={`text-[6px] font-bold leading-none mt-0.5 ${color}`}>{label}</span>
            </div>
          );
        })}
        {remaining > 0 && (
          <span className="text-xs text-slate-500 font-medium ml-0.5">+{remaining}</span>
        )}
      </div>

      {/* Lightbox for images */}
      {lightbox !== null && images[lightbox] && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setLightbox(null)}>
          <button onClick={() => setLightbox(null)} className="absolute top-4 right-4 p-2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition">
            <X size={24} />
          </button>
          {images.length > 1 && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); setLightbox((lightbox - 1 + images.length) % images.length); }}
                className="absolute left-4 top-1/2 -translate-y-1/2 p-2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition"
              >
                <ChevronLeft size={28} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setLightbox((lightbox + 1) % images.length); }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full transition"
              >
                <ChevronRight size={28} />
              </button>
            </>
          )}
          <div className="max-w-5xl max-h-[85dvh] p-4" onClick={e => e.stopPropagation()}>
            {/* If `<img>` already errored on this index, render a
                fallback panel instead of the broken-image icon (the
                ugly dark-mode glyph that prompted this fix). The "Open
                in new tab" button uses the same URL — the browser tab
                can authenticate against R2 / Cloudflare in ways an
                in-page <img> can't. */}
            {lightboxFailed.has(lightbox) || !images[lightbox].file ? (
              <div className="flex flex-col items-center justify-center text-center p-10 bg-slate-900/40 rounded-lg shadow-2xl max-w-md">
                <ImageOff size={56} className="text-white/60 mb-4" />
                <p className="text-white text-sm font-semibold mb-1">Couldn&apos;t preview this image</p>
                <p className="text-white/60 text-xs mb-5">
                  The file is there, but the browser couldn&apos;t render it inline
                  (often a CORS or expired-link issue on the file store).
                </p>
                {images[lightbox].file && (
                  <a
                    href={images[lightbox].file}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white text-slate-800 rounded-lg text-sm font-medium hover:bg-slate-100 transition"
                    onClick={e => e.stopPropagation()}
                  >
                    <ExternalLink size={14} /> Open in new tab
                  </a>
                )}
              </div>
            ) : (
              <img
                src={images[lightbox].file}
                alt={images[lightbox].file_name}
                className="max-w-full max-h-[80dvh] object-contain rounded-lg shadow-2xl"
                onError={() => markLightboxFailed(lightbox)}
              />
            )}
            <div className="text-center mt-3">
              <p className="text-white text-sm font-medium">{images[lightbox].file_name}</p>
              <p className="text-white/60 text-xs mt-0.5">{lightbox + 1} of {images.length}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
