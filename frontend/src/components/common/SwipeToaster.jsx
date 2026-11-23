import { useRef, useState } from 'react';
import { Toaster, ToastBar, toast } from 'react-hot-toast';

// Wrap each toast so it can be flicked away horizontally — important on small
// screens where a stack of toasts otherwise covers the UI until it times out.
function SwipeableToast({ t }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(null);

  const begin = (x) => { startX.current = x; setDragging(true); };
  const move = (x) => { if (startX.current != null) setDx(x - startX.current); };
  const end = () => {
    setDragging(false);
    if (Math.abs(dx) > 64) toast.dismiss(t.id);  // past threshold → flick away
    setDx(0);
    startX.current = null;
  };

  return (
    <div
      onTouchStart={(e) => begin(e.touches[0].clientX)}
      onTouchMove={(e) => move(e.touches[0].clientX)}
      onTouchEnd={end}
      style={{
        transform: `translateX(${dx}px)`,
        opacity: dragging ? Math.max(0.25, 1 - Math.abs(dx) / 160) : 1,
        transition: dragging ? 'none' : 'transform .18s ease, opacity .18s ease',
        touchAction: 'pan-y',
      }}
    >
      <ToastBar toast={t} />
    </div>
  );
}

export default function SwipeToaster() {
  return (
    <Toaster
      position="top-right"
      reverseOrder={false}
      gutter={8}
      // Never let a toast (e.g. the "PO saved" confirmation) bleed into a
      // printed / Save-as-PDF document — hide the whole toast layer in print.
      containerClassName="print:hidden"
      toastOptions={{
        duration: 4000,
        // Compact footprint so it doesn't dominate a phone screen.
        style: {
          background: '#363636',
          color: '#fff',
          maxWidth: 'min(90vw, 360px)',
          fontSize: '0.875rem',
          padding: '8px 12px',
        },
        success: { style: { background: '#10b981' }, iconTheme: { primary: '#fff', secondary: '#10b981' } },
        error: { style: { background: '#ef4444' }, iconTheme: { primary: '#fff', secondary: '#ef4444' } },
      }}
    >
      {(t) => <SwipeableToast t={t} />}
    </Toaster>
  );
}
