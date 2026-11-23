import { useRef, useState, useEffect } from 'react';
import { Camera } from 'lucide-react';
import ImageCropModal from './ImageCropModal';

// Show the camera button on devices that can actually take a photo — phones &
// tablets — and hide it on mouse-only desktops (where capture just reopens the
// file picker, duplicating the upload control).
//
// We use (ANY-pointer: coarse) OR maxTouchPoints, NOT (pointer: coarse): the
// latter checks only the PRIMARY pointer, which some Android webviews report
// as "fine" even on a phone — wrongly hiding the button. any-pointer is true
// whenever a touchscreen exists; maxTouchPoints is the belt-and-braces check.
const coarsePointerQuery = '(any-pointer: coarse)';
const detectTouch = () => {
  if (typeof window === 'undefined') return false;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia(coarsePointerQuery).matches;
  const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
  return coarse || touch;
};

/**
 * "Take Photo" button for AI document scans on phones & tablets.
 *
 * Renders a hidden <input type="file" capture="environment"> so that on
 * mobile / tablet the rear camera opens directly; on desktop browsers the
 * `capture` hint is ignored and it falls back to the normal file picker.
 *
 * This PAIRS WITH (does not replace) the page's existing upload control —
 * the user can still drag-drop or browse for an existing file. The captured
 * File is handed back via onCapture(file), so callers reuse whatever
 * processing they already run on an uploaded file.
 *
 * Props:
 *   onCapture(file)  required — called with the captured/picked File
 *   disabled         optional — disables the button (e.g. while parsing)
 *   label            optional — button text (default "Take Photo")
 *   accept           optional — file accept filter (default "image/*")
 *   className        optional — override button styling
 */
export default function ScanCaptureButton({
  onCapture,
  disabled = false,
  label = 'Take Photo',
  accept = 'image/*',
  className = '',
}) {
  const inputRef = useRef(null);
  const [isTouch, setIsTouch] = useState(detectTouch);
  const [captured, setCaptured] = useState(null);   // image awaiting crop/compress

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(coarsePointerQuery);
    const onChange = () => setIsTouch(detectTouch());
    // addEventListener is the modern API; addListener is the Safari fallback.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    // Reset so re-capturing the same shot (identical name/size) still fires onChange.
    e.target.value = '';
    if (!file) return;
    // This is the camera-only control (accept="image/*" + capture), so every
    // result is a photo — ALWAYS send it through the crop + compress sheet.
    // (We can't gate on file.type: many Android cameras return an empty or
    // non-standard MIME type, which previously skipped the crop step and
    // uploaded the raw multi-MB photo — the "no crop + endless load" bug.)
    setCaptured(file);
  };

  // Desktop / mouse devices: hide entirely — the existing upload control covers them.
  if (!isTouch) return null;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
        className={
          className ||
          'inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed'
        }
      >
        <Camera className="h-4 w-4" /> {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture="environment"
        onChange={handleChange}
        className="hidden"
      />
      {captured && (
        <ImageCropModal
          file={captured}
          onConfirm={(processed) => { setCaptured(null); onCapture(processed); }}
          onCancel={() => setCaptured(null)}
          onRetake={() => { setCaptured(null); setTimeout(() => inputRef.current?.click(), 0); }}
        />
      )}
    </>
  );
}
