import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  MapPin, LogIn, LogOut, CheckCircle2, AlertTriangle, Loader2, RefreshCw,
  ScanFace, ShieldCheck, ShieldAlert,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useCamera from '../../../hooks/useCamera.js';

// Haversine distance in metres — mirrors the backend geofence math so the
// screen can show the user how far they are from the site before they tap.
function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Promise wrapper over the browser geolocation API with friendly errors.
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not supported on this device/browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => {
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. Enable location access for this site and try again.'
          : err.code === err.TIMEOUT
            ? 'Getting your location timed out. Try again.'
            : 'Could not get your location. Move to an open area and try again.';
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  });
}

export default function AttendanceCheckIn() {
  const navigate = useNavigate();
  const { videoRef, ready: camReady, error: camError, start: startCam, stop: stopCam, capture } = useCamera();

  const [status, setStatus] = useState(null);   // /my_status payload
  const [face, setFace] = useState(null);        // /face/status payload
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [coords, setCoords] = useState(null);   // { lat, lon, accuracy }
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState('');
  const [loadError, setLoadError] = useState('');

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [st, fc] = await Promise.all([
        apiClient.get('/api/hr/attendance/my_status/'),
        apiClient.get('/api/hr/attendance/face/status/').catch(() => ({ data: null })),
      ]);
      setStatus(st.data);
      setFace(fc.data);
    } catch (e) {
      setStatus(null);
      setLoadError("We couldn't load your check-in status right now. Please try again in a moment.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshLocation = useCallback(async () => {
    setLocating(true);
    setLocError('');
    try {
      setCoords(await getPosition());
    } catch (e) {
      setLocError(e.message);
      setCoords(null);
    } finally {
      setLocating(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { refreshLocation(); }, [refreshLocation]);

  const wh = status?.warehouse;
  const radiusM = (status?.radius_km ?? 0.5) * 1000;
  const dist = (coords && wh?.latitude != null && wh?.longitude != null)
    ? distanceMeters(coords.lat, coords.lon, wh.latitude, wh.longitude)
    : null;
  const inRange = dist != null ? dist <= radiusM : null;

  const today = status?.today;
  const checkedIn = !!today?.check_in_time;
  const checkedOut = !!today?.check_out_time;

  const enrolled = !!face?.enrolled;
  const faceAvailable = face?.available !== false;   // undefined → assume available

  // Bring the camera up when an enrolled employee still needs to check in —
  // the selfie is grabbed from this live stream at the moment they tap.
  useEffect(() => {
    if (enrolled && faceAvailable && status?.linked && !checkedIn) {
      startCam();
    }
    return () => stopCam();
  }, [enrolled, faceAvailable, status?.linked, checkedIn, startCam, stopCam]);

  const doAction = async (kind) => {
    setActing(true);
    try {
      const p = await getPosition();      // fresh, accurate fix at the moment of action
      setCoords(p);
      const url = kind === 'in' ? '/api/hr/attendance/check_in/' : '/api/hr/attendance/check_out/';
      let res;

      if (kind === 'in' && enrolled && camReady) {
        // Capture a live selfie and send it alongside the coordinates so the
        // server can verify the face. If capture fails we fall back to a
        // GPS-only check-in rather than blocking the employee.
        let blob = null;
        try { blob = await capture(); } catch { /* fall through */ }
        if (blob) {
          const fd = new FormData();
          fd.append('latitude', p.lat);
          fd.append('longitude', p.lon);
          fd.append('entry_photo', blob, 'selfie.jpg');
          res = await apiClient.post(url, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        } else {
          res = await apiClient.post(url, { latitude: p.lat, longitude: p.lon });
        }
      } else {
        res = await apiClient.post(url, { latitude: p.lat, longitude: p.lon });
      }

      if (kind === 'in') {
        const fv = res?.data?.face_verified;
        if (fv === true) toast.success('Checked in ✓ — face verified');
        else if (fv === false) toast('Checked in — face not matched, flagged for HR review', { icon: '⚠️' });
        else toast.success('Checked in ✓');
      } else {
        toast.success('Checked out ✓');
      }
      stopCam();
      await loadStatus();
    } catch (e) {
      toast.error(e.response ? getApiErrorMessage(e) : e.message);
    } finally {
      setActing(false);
    }
  };

  const fmt = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

  // Face-verification badge for a completed check-in.
  const faceBadge = () => {
    const fv = today?.face_verified;
    if (fv === true) return <span className="inline-flex items-center gap-1 text-emerald-700"><ShieldCheck size={13} /> Face verified</span>;
    if (fv === false) return <span className="inline-flex items-center gap-1 text-amber-700"><ShieldAlert size={13} /> Face not matched (under review)</span>;
    return null;
  };

  return (
    <MainLayout>
      <PageHeader
        title="Attendance Check-In"
        subtitle="Mark your attendance from the work site"
        breadcrumbs={[{ label: 'HR' }, { label: 'Attendance', href: '/hr/attendance' }, { label: 'Check-In' }]}
      />

      <div className="max-w-md mx-auto">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="animate-spin text-primary-600" /></div>
        ) : loadError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            <div className="flex gap-2"><AlertTriangle size={18} className="shrink-0" /><div>{loadError}</div></div>
            <button
              type="button"
              onClick={loadStatus}
              className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700"
            >
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        ) : !status?.linked ? (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800 flex gap-2">
            <AlertTriangle size={18} className="shrink-0" />
            <div>{status?.error || 'Your login is not linked to a staff record.'} Contact HR to link your account before you can check in.</div>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            {/* Who + where */}
            <div>
              <p className="text-lg font-semibold text-slate-800">{status.staff?.name}</p>
              <p className="text-sm text-slate-500">
                {status.staff?.staff_id}{wh?.name ? ` · ${wh.name}` : ''}
              </p>
            </div>

            {/* Today's status */}
            <div className="rounded-lg bg-slate-50 border border-slate-100 p-3 text-sm">
              {checkedOut ? (
                <div className="flex items-center gap-2 text-emerald-700">
                  <CheckCircle2 size={16} /> Checked in {fmt(today.check_in_time)} · out {fmt(today.check_out_time)} — done for today
                </div>
              ) : checkedIn ? (
                <div className="flex items-center gap-2 text-emerald-700">
                  <CheckCircle2 size={16} /> Checked in at {fmt(today.check_in_time)}
                </div>
              ) : (
                <div className="text-slate-500">Not checked in yet today.</div>
              )}
              {checkedIn && <div className="mt-1 text-xs">{faceBadge()}</div>}
            </div>

            {/* Face ID nudge — enrolled employees get selfie verification; others
                are prompted to set it up but can still check in with GPS. */}
            {faceAvailable && !enrolled && !checkedIn && (
              <div className="rounded-lg border border-primary-200 bg-primary-50 p-3">
                <div className="flex items-start gap-2">
                  <ScanFace size={18} className="text-primary-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-primary-800">Set up Face ID</p>
                    <p className="text-xs text-primary-700/80">
                      Verify it's really you at check-in. Takes about a minute.
                    </p>
                    <button
                      onClick={() => navigate('/hr/attendance/face-setup')}
                      className="mt-2 text-xs font-semibold text-primary-700 underline"
                    >
                      Set up now →
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Live selfie preview for enrolled employees who still need to check in */}
            {enrolled && faceAvailable && !checkedIn && (
              <div>
                <div className="flex items-center gap-1 text-xs font-medium text-slate-500 mb-1">
                  <ScanFace size={13} /> Face check
                </div>
                <div className="relative rounded-xl overflow-hidden bg-slate-900 aspect-[4/3]">
                  <video ref={videoRef} playsInline muted className="w-full h-full object-cover -scale-x-100" />
                  {camReady && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="w-28 h-36 border-2 border-white/70 rounded-[50%]" />
                    </div>
                  )}
                  {!camReady && !camError && (
                    <div className="absolute inset-0 flex items-center justify-center text-white/80"><Loader2 className="animate-spin" /></div>
                  )}
                  {camError && (
                    <div className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-red-200">
                      {camError} You can still check in with your location.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Location panel */}
            <div className="rounded-lg border border-slate-100 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500 flex items-center gap-1"><MapPin size={13} /> Your location</span>
                <button
                  type="button"
                  onClick={refreshLocation}
                  disabled={locating}
                  className="text-xs text-primary-600 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw size={12} className={locating ? 'animate-spin' : ''} /> Refresh
                </button>
              </div>
              {!wh?.geofenced ? (
                <p className="mt-2 text-xs text-amber-700">Your site has no geofence coordinates set — contact admin.</p>
              ) : locating ? (
                <p className="mt-2 text-xs text-slate-500">Locating…</p>
              ) : locError ? (
                <p className="mt-2 text-xs text-red-600">{locError}</p>
              ) : dist != null ? (
                <p className={`mt-2 text-xs font-medium ${inRange ? 'text-emerald-700' : 'text-red-600'}`}>
                  {inRange ? '✓ ' : '✗ '}~{Math.round(dist)} m from {wh.name} (limit {Math.round(radiusM)} m)
                </p>
              ) : (
                <p className="mt-2 text-xs text-slate-500">Tap Refresh to check your distance.</p>
              )}
            </div>

            {/* Action button */}
            {checkedOut ? (
              <button disabled className="w-full py-3 rounded-lg bg-slate-100 text-slate-400 font-medium">All done for today</button>
            ) : checkedIn ? (
              <button
                onClick={() => doAction('out')}
                disabled={acting}
                className="w-full py-3 rounded-lg bg-slate-800 text-white font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {acting ? <Loader2 size={18} className="animate-spin" /> : <LogOut size={18} />} Check Out
              </button>
            ) : (
              <button
                onClick={() => doAction('in')}
                disabled={acting || !wh?.geofenced}
                className="w-full py-3 rounded-lg bg-primary-600 text-white font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {acting ? <Loader2 size={18} className="animate-spin" />
                  : enrolled ? <ScanFace size={18} /> : <LogIn size={18} />}
                {enrolled ? 'Check In with Face' : 'Check In'}
              </button>
            )}
            <p className="text-[11px] text-slate-400 text-center">
              Your GPS location is verified against the site on every check-in — you must be within {Math.round(radiusM)} m.
              {enrolled ? ' A quick selfie confirms your identity.' : ''}
            </p>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
