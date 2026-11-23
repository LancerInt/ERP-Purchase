import { useRef, useState, useEffect, useCallback } from 'react';
import { X, Camera, Crop as CropIcon } from 'lucide-react';

// A camera photo is multi-megapixel; uploading it raw over a phone connection
// is what makes the AI scan "load forever". We crop to the document and
// downscale to keep the upload small (and OCR sharper). Tune here:
const MAX_DIM = 1800;       // longest output edge in px — still sharp for Gemini OCR
const JPEG_QUALITY = 0.72;  // ~100-180 KB typical — uploads even on a weak link
const HANDLE_HIT = 24;      // px radius for grabbing a corner on touch

/**
 * Full-screen crop + compress sheet for a freshly-captured photo.
 *
 * Lets the user drag a crop rectangle (move it, resize from any corner, or
 * draw a fresh one) over the captured image, then exports a cropped,
 * downscaled JPEG via canvas — no third-party library.
 *
 * Props:
 *   file        the captured image File
 *   onConfirm   (processedFile) => void  — receives the cropped/compressed JPEG
 *   onCancel    () => void               — discard & close
 *   onRetake    () => void               — discard & reopen the camera (optional)
 */
export default function ImageCropModal({ file, onConfirm, onCancel, onRetake }) {
  const [url, setUrl] = useState('');
  const imgRef = useRef(null);
  const overlayRef = useRef(null);
  const drag = useRef(null);                 // { mode, corner, start, startSel }
  const [box, setBox] = useState(null);      // displayed image size { w, h }
  const [sel, setSel] = useState(null);      // selection in display px { x, y, w, h }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Measure the rendered image and seed a 90%-centred selection.
  const measure = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    setBox({ w: r.width, h: r.height });
    const insetX = r.width * 0.05;
    const insetY = r.height * 0.05;
    setSel({ x: insetX, y: insetY, w: r.width - 2 * insetX, h: r.height - 2 * insetY });
  }, []);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [measure]);

  const pointAt = (e) => {
    const r = overlayRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
    };
  };

  const cornerAt = (p) => {
    if (!sel) return null;
    const corners = {
      nw: { x: sel.x, y: sel.y },
      ne: { x: sel.x + sel.w, y: sel.y },
      sw: { x: sel.x, y: sel.y + sel.h },
      se: { x: sel.x + sel.w, y: sel.y + sel.h },
    };
    for (const k of Object.keys(corners)) {
      if (Math.hypot(p.x - corners[k].x, p.y - corners[k].y) <= HANDLE_HIT) return k;
    }
    return null;
  };

  const inside = (p) =>
    sel && p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h;

  const onDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = pointAt(e);
    const corner = cornerAt(p);
    if (corner) {
      drag.current = { mode: 'resize', corner, start: p, startSel: { ...sel } };
    } else if (inside(p)) {
      drag.current = { mode: 'move', start: p, startSel: { ...sel } };
    } else {
      drag.current = { mode: 'draw', start: p, startSel: null };
      setSel({ x: p.x, y: p.y, w: 0, h: 0 });
    }
  };

  const onMove = (e) => {
    if (!drag.current || !box) return;
    const p = pointAt(e);
    const d = drag.current;
    if (d.mode === 'move') {
      const nx = Math.max(0, Math.min(box.w - d.startSel.w, d.startSel.x + (p.x - d.start.x)));
      const ny = Math.max(0, Math.min(box.h - d.startSel.h, d.startSel.y + (p.y - d.start.y)));
      setSel({ ...d.startSel, x: nx, y: ny });
    } else if (d.mode === 'draw') {
      setSel({
        x: Math.min(d.start.x, p.x),
        y: Math.min(d.start.y, p.y),
        w: Math.abs(p.x - d.start.x),
        h: Math.abs(p.y - d.start.y),
      });
    } else if (d.mode === 'resize') {
      let x = d.startSel.x, y = d.startSel.y;
      let x2 = x + d.startSel.w, y2 = y + d.startSel.h;
      if (d.corner.includes('n')) y = Math.min(p.y, y2 - 16);
      if (d.corner.includes('s')) y2 = Math.max(p.y, y + 16);
      if (d.corner.includes('w')) x = Math.min(p.x, x2 - 16);
      if (d.corner.includes('e')) x2 = Math.max(p.x, x + 16);
      setSel({ x, y, w: x2 - x, h: y2 - y });
    }
  };

  const onUp = () => {
    // A stray tiny drag = "didn't mean to" → restore the full-frame selection.
    if (drag.current?.mode === 'draw' && sel && (sel.w < 24 || sel.h < 24)) measure();
    drag.current = null;
  };

  const exportFile = useCallback(async (useCrop) => {
    const img = imgRef.current;
    if (!img || !box) return;
    setBusy(true);
    try {
      const scaleX = img.naturalWidth / box.w;
      const scaleY = img.naturalHeight / box.h;
      let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
      if (useCrop && sel && sel.w > 10 && sel.h > 10) {
        sx = sel.x * scaleX;
        sy = sel.y * scaleY;
        sw = sel.w * scaleX;
        sh = sel.h * scaleY;
      }
      let ow = sw, oh = sh;
      const longest = Math.max(sw, sh);
      if (longest > MAX_DIM) {
        const r = MAX_DIM / longest;
        ow = Math.round(sw * r);
        oh = Math.round(sh * r);
      }
      const canvas = document.createElement('canvas');
      canvas.width = ow;
      canvas.height = oh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, ow, oh);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
      if (!blob) throw new Error('toBlob failed');
      const base = (file?.name || 'scan').replace(/\.[^.]+$/, '') || 'scan';
      onConfirm(new File([blob], `${base}.jpg`, { type: 'image/jpeg' }));
    } catch {
      // Canvas failed (rare) — fall back to the original file so the scan still runs.
      onConfirm(file);
    } finally {
      setBusy(false);
    }
  }, [box, sel, file, onConfirm]);

  return (
    <div className="fixed inset-0 z-[70] bg-black/90 flex flex-col" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-sm font-medium">Crop photo</span>
        <button type="button" onClick={onCancel} disabled={busy} className="p-1 rounded hover:bg-white/10" aria-label="Close">
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center overflow-hidden px-2">
        <div className="relative inline-block">
          <img
            ref={imgRef}
            src={url}
            alt="Captured document"
            onLoad={measure}
            draggable={false}
            className="block max-w-full max-h-[66dvh] select-none"
          />
          {sel && box && (
            <div
              ref={overlayRef}
              className="absolute inset-0 touch-none cursor-crosshair"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              {/* Dimmed mask outside the selection */}
              <div className="absolute bg-black/50" style={{ left: 0, top: 0, width: '100%', height: sel.y }} />
              <div className="absolute bg-black/50" style={{ left: 0, top: sel.y + sel.h, width: '100%', bottom: 0 }} />
              <div className="absolute bg-black/50" style={{ left: 0, top: sel.y, width: sel.x, height: sel.h }} />
              <div className="absolute bg-black/50" style={{ left: sel.x + sel.w, top: sel.y, right: 0, height: sel.h }} />
              {/* Selection border */}
              <div className="absolute border-2 border-white pointer-events-none" style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
              {/* Corner handles */}
              {['nw', 'ne', 'sw', 'se'].map((k) => {
                const cx = k.includes('w') ? sel.x : sel.x + sel.w;
                const cy = k.includes('n') ? sel.y : sel.y + sel.h;
                return (
                  <div
                    key={k}
                    className="absolute w-4 h-4 bg-white rounded-sm border border-slate-400 pointer-events-none"
                    style={{ left: cx - 8, top: cy - 8 }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-3 flex items-center gap-2 bg-black/40">
        <p className="hidden sm:block text-[11px] text-white/60 mr-auto">Drag the box or its corners to frame the document.</p>
        {onRetake && (
          <button type="button" onClick={onRetake} disabled={busy} className="px-3 py-2 text-sm text-white border border-white/40 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            <Camera size={15} /> Retake
          </button>
        )}
        <button type="button" onClick={() => exportFile(false)} disabled={busy} className="px-3 py-2 text-sm text-white border border-white/40 rounded-lg disabled:opacity-50 ml-auto">
          Use full photo
        </button>
        <button type="button" onClick={() => exportFile(true)} disabled={busy} className="px-4 py-2 text-sm font-semibold bg-primary-600 text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50">
          {busy ? 'Processing…' : (<><CropIcon size={15} /> Crop &amp; use</>)}
        </button>
      </div>
    </div>
  );
}
