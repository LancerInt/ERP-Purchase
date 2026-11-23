import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Camera, CheckCircle2, AlertTriangle, Loader2, RefreshCw, ShieldCheck, RotateCcw,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useCamera from '../../../hooks/useCamera.js';

// The angles we guide the employee through. More angles → more robust
// matching against head-pose variation at check-in.
const ANGLES = [
  { key: 'front', label: 'Look straight at the camera' },
  { key: 'left', label: 'Turn your head slightly left' },
  { key: 'right', label: 'Turn your head slightly right' },
  { key: 'up', label: 'Tilt your head up a little' },
  { key: 'down', label: 'Tilt your head down a little' },
];

export default function FaceSetup() {
  const navigate = useNavigate();
  const { videoRef, ready, error: camError, start, stop, capture } = useCamera();

  const [status, setStatus] = useState(null);   // /face/status payload
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [step, setStep] = useState(0);           // index into ANGLES
  const [shots, setShots] = useState([]);        // [{ blob, url }]
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [started, setStarted] = useState(false); // has the user begun capturing

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await apiClient.get('/api/hr/attendance/face/status/');
      setStatus(res.data);
    } catch {
      setStatus(null);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Release preview object URLs on unmount.
  useEffect(() => () => { shots.forEach((s) => URL.revokeObjectURL(s.url)); }, [shots]);

  const begin = async () => {
    setStarted(true);
    setShots([]);
    setStep(0);
    await start();
  };

  const grab = async () => {
    setCapturing(true);
    try {
      const blob = await capture();
      const url = URL.createObjectURL(blob);
      setShots((prev) => [...prev, { blob, url }]);
      setStep((s) => s + 1);
    } catch (e) {
      toast.error(e.message || 'Capture failed. Try again.');
    } finally {
      setCapturing(false);
    }
  };

  const retake = () => {
    setShots((prev) => {
      const last = prev[prev.length - 1];
      if (last) URL.revokeObjectURL(last.url);
      return prev.slice(0, -1);
    });
    setStep((s) => Math.max(0, s - 1));
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const fd = new FormData();
      shots.forEach((s, i) => fd.append('frames', s.blob, `frame_${i}.jpg`));
      const res = await apiClient.post('/api/hr/attendance/face/enroll/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      stop();
      toast.success(`Face enrolled — ${res.data.sample_count} shots saved ✓`);
      await loadStatus();
      setStarted(false);
    } catch (e) {
      // The server rejects if too few frames had a clear face — surface its
      // message so the employee knows to redo it in better light.
      toast.error(getApiErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const reEnroll = async () => {
    try {
      await apiClient.post('/api/hr/attendance/face/reset/');
    } catch { /* ignore — begin() will overwrite anyway */ }
    await begin();
  };

  const done = step >= ANGLES.length;      // all angles captured
  const current = ANGLES[Math.min(step, ANGLES.length - 1)];

  return (
    <MainLayout>
      <PageHeader
        title="Set up Face ID"
        subtitle="Enroll your face so attendance check-in can verify it's really you"
        breadcrumbs={[{ label: 'HR' }, { label: 'Attendance', href: '/hr/attendance' }, { label: 'Face ID' }]}
      />

      <div className="max-w-md mx-auto">
        {loadingStatus ? (
          <div className="flex justify-center py-16"><Loader2 className="animate-spin text-primary-600" /></div>
        ) : status && !status.linked ? (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800 flex gap-2">
            <AlertTriangle size={18} className="shrink-0" />
            <div>{status.error || 'Your login is not linked to a staff record.'} Contact HR first.</div>
          </div>
        ) : status && status.available === false ? (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800 flex gap-2">
            <AlertTriangle size={18} className="shrink-0" />
            <div>Face verification isn't set up on the server yet. You can still check in with your location. Contact admin.</div>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            {/* Already-enrolled state */}
            {!started && status?.enrolled ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-emerald-700">
                  <ShieldCheck size={20} />
                  <div>
                    <p className="font-semibold">Face ID is set up</p>
                    <p className="text-xs text-slate-500">{status.sample_count} reference shots on file</p>
                  </div>
                </div>
                <p className="text-sm text-slate-600">
                  Your check-in selfie is matched against this. If your look has changed
                  (glasses, beard, etc.) you can redo it.
                </p>
                <button
                  onClick={reEnroll}
                  className="w-full py-2.5 rounded-lg border border-slate-300 text-slate-700 font-medium inline-flex items-center justify-center gap-2 hover:bg-slate-50"
                >
                  <RotateCcw size={16} /> Re-enroll my face
                </button>
                <button
                  onClick={() => navigate('/hr/attendance/check-in')}
                  className="w-full py-2.5 rounded-lg bg-primary-600 text-white font-semibold"
                >
                  Go to Check-In
                </button>
              </div>
            ) : !started ? (
              /* Intro / start */
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  We'll take {ANGLES.length} quick shots of your face from slightly different
                  angles. Nothing but the mathematical face signature is stored — no photos
                  are kept.
                </p>
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-3 text-xs text-slate-500 space-y-1">
                  <p>• Find a well-lit spot, face the light.</p>
                  <p>• Remove masks/sunglasses; keep your whole face in frame.</p>
                  <p>• Follow the on-screen instruction for each shot.</p>
                </div>
                <button
                  onClick={begin}
                  className="w-full py-3 rounded-lg bg-primary-600 text-white font-semibold inline-flex items-center justify-center gap-2"
                >
                  <Camera size={18} /> Start
                </button>
              </div>
            ) : (
              /* Capture flow */
              <div className="space-y-4">
                {/* Progress dots */}
                <div className="flex items-center justify-center gap-1.5">
                  {ANGLES.map((a, i) => (
                    <span
                      key={a.key}
                      className={`h-2 rounded-full transition-all ${
                        i < shots.length ? 'w-6 bg-emerald-500'
                          : i === step ? 'w-6 bg-primary-500'
                            : 'w-2 bg-slate-200'
                      }`}
                    />
                  ))}
                </div>

                {/* Live camera with an oval guide */}
                <div className="relative rounded-xl overflow-hidden bg-slate-900 aspect-[3/4]">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    className="w-full h-full object-cover -scale-x-100"
                  />
                  {ready && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="w-40 h-52 border-2 border-white/70 rounded-[50%]" />
                    </div>
                  )}
                  {!ready && !camError && (
                    <div className="absolute inset-0 flex items-center justify-center text-white/80">
                      <Loader2 className="animate-spin" />
                    </div>
                  )}
                  {camError && (
                    <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-red-200">
                      {camError}
                    </div>
                  )}
                </div>

                {!done ? (
                  <>
                    <p className="text-center text-sm font-medium text-slate-700">
                      Shot {shots.length + 1} of {ANGLES.length}: {current.label}
                    </p>
                    <div className="flex gap-2">
                      {shots.length > 0 && (
                        <button
                          onClick={retake}
                          disabled={capturing}
                          className="px-3 py-3 rounded-lg border border-slate-300 text-slate-600 disabled:opacity-50"
                          title="Redo last shot"
                        >
                          <RefreshCw size={18} />
                        </button>
                      )}
                      <button
                        onClick={grab}
                        disabled={!ready || capturing}
                        className="flex-1 py-3 rounded-lg bg-primary-600 text-white font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {capturing ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />} Capture
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-center gap-2 text-emerald-700 text-sm">
                      <CheckCircle2 size={16} /> All {ANGLES.length} shots captured
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={retake}
                        disabled={submitting}
                        className="px-3 py-3 rounded-lg border border-slate-300 text-slate-600 disabled:opacity-50"
                        title="Redo last shot"
                      >
                        <RefreshCw size={18} />
                      </button>
                      <button
                        onClick={submit}
                        disabled={submitting}
                        className="flex-1 py-3 rounded-lg bg-emerald-600 text-white font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {submitting ? <Loader2 size={18} className="animate-spin" /> : <ShieldCheck size={18} />} Save Face ID
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </MainLayout>
  );
}
