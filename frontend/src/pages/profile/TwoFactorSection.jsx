import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import { ShieldCheck, ShieldOff, KeyRound, Fingerprint, X, Copy } from 'lucide-react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import apiClient from '../../utils/api.js';
import { getApiErrorMessage } from '../../utils/formHelpers.js';
import { clearMustSetupMfa } from '../../store/slices/authSlice.js';
import { Button } from '../../components/common/forms';

/**
 * Two-factor login (TOTP authenticator app) setup, inside Profile > Security.
 *
 * Three states, one at a time:
 *   'off'      — not enabled. "Set up" starts enrollment.
 *   'setup'    — QR code shown, waiting for the user to scan + confirm
 *                with one real code from their app.
 *   'on'       — enabled. Shows remaining backup codes, lets the user
 *                regenerate them or disable — both require a fresh code,
 *                same reasoning as changing a password requires the old one.
 *
 * Backup codes are shown via a separate small state (`backupCodes`) rather
 * than folded into 'on'/'setup' because they're a ONE-TIME reveal — after
 * confirm or a regenerate, not something re-fetchable from status.
 */
export default function TwoFactorSection() {
  const dispatch = useDispatch();
  const [status, setStatus] = useState(null); // { totp_enabled, backup_codes_remaining, webauthn_credentials } | null while loading
  const [mode, setMode] = useState('off');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [actionCode, setActionCode] = useState(''); // for disable / regenerate
  const [showDisable, setShowDisable] = useState(false);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [backupCodes, setBackupCodes] = useState(null);
  const [busy, setBusy] = useState(false);

  // Biometric (WebAuthn) devices — independent of the TOTP on/off state
  // above; a user can register a device with or without also using an
  // authenticator app, since either one alone satisfies the second factor.
  const [namingDevice, setNamingDevice] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  // The credential the authenticator just produced, held while the user
  // names it. Redeemed by finishDeviceRegistration below.
  const [pendingCredential, setPendingCredential] = useState(null);
  const [webauthnBusy, setWebauthnBusy] = useState(false);

  const loadStatus = async () => {
    try {
      const { data } = await apiClient.get('/api/mfa/status/');
      setStatus(data);
      setMode(data.totp_enabled ? 'on' : 'off');
      // The MOMENT any factor exists, clear the app-wide "must set up 2FA"
      // redirect directly — this component already knows the answer from
      // the call above, no reason to wait on MainLayout's own re-check.
      if (data.totp_enabled || data.webauthn_credentials?.length > 0) {
        dispatch(clearMustSetupMfa());
      }
    } catch {
      setStatus({ totp_enabled: false, backup_codes_remaining: 0, webauthn_credentials: [] });
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const startSetup = async () => {
    setBusy(true);
    try {
      const { data } = await apiClient.post('/api/mfa/totp/setup/');
      setQrCode(data.qr_code);
      setSecret(data.secret);
      setMode('setup');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async (e) => {
    e.preventDefault();
    if (!confirmCode.trim()) return;
    setBusy(true);
    try {
      const { data } = await apiClient.post('/api/mfa/totp/confirm/', { code: confirmCode.trim() });
      setBackupCodes(data.backup_codes);
      setConfirmCode('');
      await loadStatus();
      toast.success('Two-factor login is now on.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e) => {
    e.preventDefault();
    if (!actionCode.trim()) return;
    setBusy(true);
    try {
      await apiClient.post('/api/mfa/totp/disable/', { code: actionCode.trim() });
      setActionCode('');
      setShowDisable(false);
      setBackupCodes(null);
      await loadStatus();
      toast.success('Two-factor login turned off.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (e) => {
    e.preventDefault();
    if (!actionCode.trim()) return;
    setBusy(true);
    try {
      const { data } = await apiClient.post('/api/mfa/backup-codes/regenerate/', { code: actionCode.trim() });
      setBackupCodes(data.backup_codes);
      setActionCode('');
      setShowRegenerate(false);
      await loadStatus();
      toast.success('New backup codes generated — your old ones no longer work.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Ask the DEVICE first, name it second.
  //
  // This used to collect the name up front and only reach the
  // authenticator on submit — so registering an already-enrolled device
  // meant typing a name and clearing a fingerprint prompt before being
  // told it was pointless. WebAuthn deliberately gives no way to ask
  // "does this device already hold one of these credentials?" (that
  // would be a fingerprinting vector), so the refusal can only come from
  // the ceremony itself. Running the ceremony first means the dead end
  // costs one click instead of a whole form.
  //
  // The server caches the challenge for 5 minutes, so naming afterwards
  // has plenty of time before the credential has to be redeemed.
  const beginDeviceRegistration = async () => {
    setWebauthnBusy(true);
    try {
      const { data: options } = await apiClient.post('/api/mfa/webauthn/register/begin/');
      const credential = await startRegistration({ optionsJSON: options });
      setPendingCredential(credential);
      setNewDeviceName('');
      setNamingDevice(true);     // only NOW is a name worth asking for
    } catch (err) {
      if (err?.name === 'InvalidStateError') {
        // The authenticator refused because it ALREADY holds one of the
        // credentials we sent in excludeCredentials — i.e. this exact
        // device is registered. Not a failure: the state the user wanted
        // is already true, so say so rather than "try again", which can
        // never succeed on this device. The button stays available
        // because a SECOND, different device is still a valid thing to
        // add, and the server can't tell which device a browser is on.
        toast('This device is already registered.', { icon: '✅' });
      } else if (err?.name !== 'NotAllowedError') {
        // NotAllowedError means the user cancelled the browser's own
        // prompt — not worth an error toast for backing out.
        toast.error(err?.response ? getApiErrorMessage(err) : 'Could not register that device. Please try again.');
      }
    } finally {
      setWebauthnBusy(false);
    }
  };

  const finishDeviceRegistration = async (e) => {
    e.preventDefault();
    if (!pendingCredential) return;
    setWebauthnBusy(true);
    try {
      await apiClient.post('/api/mfa/webauthn/register/complete/', {
        credential: pendingCredential,
        device_name: newDeviceName.trim() || 'Registered device',
      });
      setPendingCredential(null);
      setNewDeviceName('');
      setNamingDevice(false);
      await loadStatus();
      toast.success('Device registered.');
    } catch (err) {
      toast.error(err?.response ? getApiErrorMessage(err) : 'Could not finish registering that device.');
    } finally {
      setWebauthnBusy(false);
    }
  };

  const cancelDeviceRegistration = () => {
    setPendingCredential(null);
    setNewDeviceName('');
    setNamingDevice(false);
  };

  const removeDevice = async (id) => {
    setWebauthnBusy(true);
    try {
      await apiClient.delete(`/api/mfa/webauthn/credentials/${id}/`);
      await loadStatus();
      toast.success('Device removed.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setWebauthnBusy(false);
    }
  };

  if (!status) return null;

  // A mandatory-role user (see rbac.ERPRole.mfa_required) must not be able
  // to self-disable their OWN last factor — the backend enforces this too
  // (would_leave_user_without_mfa), this just avoids offering a button that
  // would only error. Not blocked at all if the OTHER method still stands.
  const canTurnOffTotp = !status.role_requires_mfa || status.webauthn_credentials?.length > 0;
  const canRemoveDevice = (deviceId) =>
    !status.role_requires_mfa
    || status.totp_enabled
    || status.webauthn_credentials.filter((d) => d.id !== deviceId).length > 0;

  const setupOutstanding = status.role_requires_mfa
    && !status.totp_enabled
    && !(status.webauthn_credentials?.length > 0);

  return (
    <>
    {setupOutstanding && (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-800">
        Your role requires two-factor login before you can use the rest of the app. Set up an
        authenticator app or register a biometric device below to continue.
      </div>
    )}
    <div className="flex items-start gap-3 pt-3 border-t border-slate-100 mt-3">
      <span className={`shrink-0 mt-0.5 w-9 h-9 rounded-lg flex items-center justify-center ${mode === 'on' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-600'}`}>
        {mode === 'on' ? <ShieldCheck size={16} /> : <ShieldOff size={16} />}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-medium text-slate-800">Two-factor login</p>

        {backupCodes && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-[12px] font-medium text-amber-800">
              Save these backup codes now — each works once, and this is the only time they're shown.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[12px] text-slate-700">
              {backupCodes.map((c) => <span key={c}>{c}</span>)}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(backupCodes.join('\n'));
                  toast.success('Backup codes copied.');
                }}
                className="text-[12px] text-amber-700 hover:underline flex items-center gap-1"
              >
                <Copy size={12} /> Copy codes
              </button>
              <button
                type="button"
                onClick={() => setBackupCodes(null)}
                className="text-[12px] text-amber-700 hover:underline"
              >
                I've saved these
              </button>
            </div>
          </div>
        )}

        {mode === 'off' && !backupCodes && (
          <>
            <p className="text-[12px] text-slate-500">Add an authenticator app as a second step when signing in.</p>
            <Button size="sm" className="mt-2" loading={busy} onClick={startSetup}>Set up two-factor login</Button>
          </>
        )}

        {mode === 'setup' && (
          <div className="mt-2 space-y-2">
            <p className="text-[12px] text-slate-500">
              Scan this with Google Authenticator, Authy, or similar — or enter the code manually.
            </p>
            {qrCode && <img src={qrCode} alt="Authenticator QR code" className="w-40 h-40 rounded-lg border border-slate-200" />}
            <p className="text-[11px] font-mono text-slate-500 break-all">{secret}</p>
            <form onSubmit={confirmSetup} className="flex items-center gap-2">
              <input
                type="text" inputMode="numeric" placeholder="123456" autoFocus
                value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)}
                className="w-32 px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <Button type="submit" size="sm" loading={busy}>Confirm</Button>
              <button type="button" onClick={() => setMode('off')} className="text-[12px] text-slate-500 hover:underline">Cancel</button>
            </form>
          </div>
        )}

        {mode === 'on' && !backupCodes && (
          <>
            <p className="text-[12px] text-slate-500">
              On — {status.backup_codes_remaining} backup code{status.backup_codes_remaining === 1 ? '' : 's'} remaining.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => { setShowRegenerate((v) => !v); setShowDisable(false); }} className="text-[12px] text-primary-600 hover:underline flex items-center gap-1">
                <KeyRound size={12} /> Regenerate backup codes
              </button>
              {canTurnOffTotp ? (
                <button type="button" onClick={() => { setShowDisable((v) => !v); setShowRegenerate(false); }} className="text-[12px] text-danger-600 hover:underline">
                  Turn off
                </button>
              ) : (
                <span className="text-[11px] text-slate-400" title="Your role requires two-factor login">
                  Turn off — blocked (role requires 2FA)
                </span>
              )}
            </div>
            {(showRegenerate || showDisable) && (
              <form onSubmit={showDisable ? disable : regenerate} className="mt-2 flex items-center gap-2">
                <input
                  type="text" inputMode="numeric" placeholder="Current code" autoFocus
                  value={actionCode} onChange={(e) => setActionCode(e.target.value)}
                  className="w-32 px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <Button type="submit" size="sm" variant={showDisable ? 'danger' : 'primary'} loading={busy}>
                  {showDisable ? 'Confirm turn off' : 'Confirm regenerate'}
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </div>

    {browserSupportsWebAuthn() && (
      <div className="flex items-start gap-3 pt-3 border-t border-slate-100 mt-3">
        <span className="shrink-0 mt-0.5 w-9 h-9 rounded-lg flex items-center justify-center bg-slate-100 text-slate-600">
          <Fingerprint size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-medium text-slate-800">Biometric sign-in</p>
          <p className="text-[12px] text-slate-500">
            Register this device's fingerprint, face unlock, or a security key as a second step when signing in.
          </p>

          {status.webauthn_credentials?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {status.webauthn_credentials.map((d) => (
                <li key={d.id} className="flex items-center justify-between text-[12px] text-slate-600">
                  <span>{d.device_name}</span>
                  {canRemoveDevice(d.id) ? (
                    <button
                      type="button"
                      onClick={() => removeDevice(d.id)}
                      disabled={webauthnBusy}
                      className="text-slate-400 hover:text-danger-600"
                      aria-label={`Remove ${d.device_name}`}
                    >
                      <X size={14} />
                    </button>
                  ) : (
                    <span className="text-slate-300" title="Your role requires two-factor login — this is your only registered method">
                      <X size={14} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {namingDevice ? (
            <form onSubmit={finishDeviceRegistration} className="mt-2">
              <p className="text-[12px] text-slate-500 mb-1.5">
                Device verified — give it a name so you can tell it apart later.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text" placeholder="e.g. Mani's Laptop" autoFocus
                  value={newDeviceName} onChange={(e) => setNewDeviceName(e.target.value)}
                  className="w-40 px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <Button type="submit" size="sm" loading={webauthnBusy}>Save</Button>
                <button type="button" onClick={cancelDeviceRegistration} className="text-[12px] text-slate-500 hover:underline">Cancel</button>
              </div>
            </form>
          ) : (
            <Button size="sm" className="mt-2" loading={webauthnBusy} onClick={beginDeviceRegistration}>Register this device</Button>
          )}
        </div>
      </div>
    )}
    </>
  );
}
