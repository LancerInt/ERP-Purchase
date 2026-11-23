/**
 * Login landing page — branded panel + sign-in card. JWT auth logic is
 * unchanged. Internal tool: users already know what Lancer ERP does, so the
 * left panel is just identity (logo/name), not a marketing pitch.
 */

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { loginUser, verifyMfa, verifyMfaWebAuthn } from '../store/slices/authSlice.js';
import apiClient from '../utils/api.js';
import { Eye, EyeOff, Fingerprint } from 'lucide-react';
import { Button } from '../components/ui';

export default function Login() {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  // Live validation: `onChange` re-runs each field's rules on every keystroke,
  // so the "at least 8 characters" error appears (and clears) as the user types
  // rather than only after they press Sign In. Note the password's *correctness*
  // can't be checked client-side — only the server knows it — so a wrong
  // password is still reported after submit.
  const { register, handleSubmit, formState: { errors } } = useForm({ mode: 'onChange' });

  const isAuthenticated = useSelector((state) => !!state.auth.token);
  const isLoading = useSelector((state) => state.auth.isLoading);
  const error = useSelector((state) => state.auth.error);

  const [showPassword, setShowPassword] = useState(false);
  const year = new Date().getFullYear();

  // Two-factor login: a correct password alone isn't a completed sign-in
  // when the account has a confirmed second factor — loginUser resolves
  // with mfaRequired instead of tokens, and this page switches to asking
  // for the code (or a backup code) rather than navigating away. Nothing
  // is stored/authenticated until verifyMfa also succeeds.
  // Explain an idle sign-out instead of just reappearing at the login
  // screen — an unexplained logout reads as a bug or a lost session, and
  // the first instinct is to assume work was lost.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('reason') === 'idle') {
      toast('You were signed out after a period of inactivity.', { icon: '⏱️' });
    }
    // Once per arrival; re-firing on every render would stack toasts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [mfaState, setMfaState] = useState(null); // { mfaToken, methods, email, remember } | null
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  // Which screen to show is dynamic per-account, not one-size-fits-all: an
  // account with only a registered biometric device (no authenticator app)
  // must never be shown a 6-digit code field it has no way to fill in.
  const hasTotp = !!mfaState?.methods.includes('totp');
  const hasWebAuthn = !!mfaState?.methods.includes('webauthn') && browserSupportsWebAuthn();

  useEffect(() => {
    if (isAuthenticated) navigate('/home');
  }, [isAuthenticated, navigate]);

  const onSubmit = async (data) => {
    const result = await dispatch(loginUser({
      email: data.username,
      password: data.password,
      remember: !!data.remember,
    }));

    if (result.payload?.mfaRequired) {
      setMfaState({
        mfaToken: result.payload.mfaToken,
        methods: result.payload.methods,
        email: data.username,
        remember: !!data.remember,
      });
    } else if (result.payload?.token) {
      toast.success('Login successful!');
      navigate('/home');
    } else {
      // result.payload, not the `error` selector above - that's bound to
      // whatever state.auth.error was when THIS closure was created (the
      // previous attempt's message), not this dispatch's own result. With a
      // static message the mismatch was invisible; once the message started
      // counting down remaining attempts, the toast and the inline banner
      // visibly disagreed by one attempt.
      toast.error(result.payload || 'Login failed. Please check your credentials.');
    }
  };

  const onSubmitMfa = async (e) => {
    e.preventDefault();
    if (!mfaCode.trim()) return;
    const result = await dispatch(verifyMfa({
      mfaToken: mfaState.mfaToken,
      method: useBackupCode ? 'backup_code' : 'totp',
      code: mfaCode.trim(),
      email: mfaState.email,
      remember: mfaState.remember,
    }));
    if (result.payload?.token) {
      toast.success('Login successful!');
      navigate('/home');
    } else {
      // Same stale-closure reason as onSubmit above — use this dispatch's
      // own result, not the `error` selector from whenever this closure
      // was created.
      toast.error(result.payload || 'Incorrect code. Please try again.');
    }
  };

  // Biometric second factor: fetch a challenge scoped to this user's
  // registered devices, let the browser's own prompt (Windows Hello,
  // Touch ID, a security key…) sign it, then hand the signed response to
  // verifyMfaWebAuthn the same way onSubmitMfa hands over a typed code.
  const [biometricBusy, setBiometricBusy] = useState(false);

  const onUseBiometric = async () => {
    setBiometricBusy(true);
    try {
      const { data: options } = await apiClient.post('/api/mfa/webauthn/login/begin/', {
        mfa_token: mfaState.mfaToken,
      });
      const credential = await startAuthentication({ optionsJSON: options });
      const result = await dispatch(verifyMfaWebAuthn({
        mfaToken: mfaState.mfaToken,
        credential,
        email: mfaState.email,
        remember: mfaState.remember,
      }));
      if (result.payload?.token) {
        toast.success('Login successful!');
        navigate('/home');
      } else {
        toast.error(result.payload || 'Could not verify with that device. Please try again.');
      }
    } catch (err) {
      // The browser itself throws when the user cancels the prompt, the
      // device doesn't match, or WebAuthn isn't supported here — not
      // something the backend ever sees.
      if (err?.name !== 'NotAllowedError') {
        toast.error('Could not use that device. Please try again or use your authenticator code.');
      }
    } finally {
      setBiometricBusy(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center relative overflow-hidden bg-gradient-to-br from-primary-600 to-primary-900 px-4 py-10">
      <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-white/5" />
      <div className="absolute -bottom-32 -left-16 w-96 h-96 rounded-full bg-white/5" />

      <div className="relative w-full max-w-md">
        <div className="flex flex-col items-center text-center mb-7">
          <div className="w-14 h-14 rounded-2xl bg-white/15 backdrop-blur grid place-items-center font-bold text-2xl text-white">L</div>
          <span className="mt-4 text-xl font-semibold tracking-tight text-white">Lancer ERP</span>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-7 sm:p-8">
          {mfaState ? (
            hasTotp ? (
            <>
              <h2 className="text-2xl font-bold text-slate-900">Verify it's you</h2>
              <p className="text-slate-500 mt-1 text-sm">
                {useBackupCode
                  ? 'Enter one of your saved backup codes.'
                  : 'Enter the 6-digit code from your authenticator app.'}
              </p>

              <form onSubmit={onSubmitMfa} className="mt-6 space-y-4">
                {error && (
                  <div className="bg-danger-50 border border-danger-300 text-danger-700 px-4 py-3 rounded-lg text-sm">
                    {error}
                  </div>
                )}
                <div>
                  <label htmlFor="mfa-code" className="block text-sm font-medium text-slate-700 mb-1">
                    {useBackupCode ? 'Backup code' : 'Authentication code'}
                  </label>
                  <input
                    id="mfa-code"
                    type="text"
                    inputMode={useBackupCode ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    autoFocus
                    placeholder={useBackupCode ? 'e.g. 3f9a21b0c4' : '123456'}
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 tracking-widest"
                    disabled={isLoading}
                  />
                </div>

                <Button type="submit" size="lg" loading={isLoading} className="w-full justify-center">
                  {isLoading ? 'Verifying…' : 'Verify'}
                </Button>

                {hasWebAuthn && (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    loading={biometricBusy}
                    onClick={onUseBiometric}
                    disabled={isLoading}
                    className="w-full justify-center gap-2"
                  >
                    <Fingerprint size={18} />
                    {biometricBusy ? 'Waiting for device…' : 'Use biometric instead'}
                  </Button>
                )}

                <div className="flex items-center justify-between text-sm pt-1">
                  <button
                    type="button"
                    onClick={() => { setUseBackupCode((v) => !v); setMfaCode(''); }}
                    className="text-primary-600 hover:underline"
                  >
                    {useBackupCode ? 'Use authenticator code instead' : 'Use a backup code instead'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMfaState(null); setMfaCode(''); setUseBackupCode(false); }}
                    className="text-slate-500 hover:underline"
                  >
                    Back
                  </button>
                </div>
              </form>
            </>
            ) : hasWebAuthn ? (
            <>
              <h2 className="text-2xl font-bold text-slate-900">Verify it's you</h2>
              <p className="text-slate-500 mt-1 text-sm">
                Use this device's fingerprint, face unlock, or security key to finish signing in.
              </p>

              <div className="mt-6 space-y-4">
                {error && (
                  <div className="bg-danger-50 border border-danger-300 text-danger-700 px-4 py-3 rounded-lg text-sm">
                    {error}
                  </div>
                )}

                <Button
                  type="button"
                  size="lg"
                  loading={biometricBusy}
                  onClick={onUseBiometric}
                  className="w-full justify-center gap-2"
                >
                  <Fingerprint size={18} />
                  {biometricBusy ? 'Waiting for device…' : 'Verify with biometrics'}
                </Button>

                <div className="flex justify-end text-sm pt-1">
                  <button
                    type="button"
                    onClick={() => { setMfaState(null); setMfaCode(''); setUseBackupCode(false); }}
                    className="text-slate-500 hover:underline"
                  >
                    Back
                  </button>
                </div>
              </div>
            </>
            ) : (
            <>
              <h2 className="text-2xl font-bold text-slate-900">Verify it's you</h2>
              <p className="text-slate-500 mt-1 text-sm">
                This device doesn't support the sign-in method set up for your account. Try a
                different device or browser, or ask an admin for help.
              </p>
              <div className="mt-6 flex justify-end text-sm">
                <button
                  type="button"
                  onClick={() => { setMfaState(null); setMfaCode(''); setUseBackupCode(false); }}
                  className="text-slate-500 hover:underline"
                >
                  Back
                </button>
              </div>
            </>
            )
          ) : (
          <>
          <h2 className="text-2xl font-bold text-slate-900">Sign in</h2>
          <p className="text-slate-500 mt-1 text-sm">Welcome back — enter your credentials to continue.</p>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
            {error && (
              <div className="bg-danger-50 border border-danger-300 text-danger-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="username" className="block text-sm font-medium text-slate-700 mb-1">Username</label>
              <input
                id="username"
                type="text"
                placeholder="Enter your username"
                autoComplete="username"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                {...register('username', { required: 'Username is required' })}
                className={`w-full px-4 py-2.5 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 ${errors.username ? 'border-danger-500' : 'border-slate-300'}`}
                disabled={isLoading}
              />
              {errors.username && <p className="text-danger-600 text-sm mt-1">{errors.username.message}</p>}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              {/* Sign-in only checks the field isn't empty. Length/complexity rules
                  belong on registration / password-change (where a new password is
                  set against a policy), not here — enforcing a minimum on login would
                  lock out any account whose real password is shorter, and leaks the
                  policy. Whether the password is correct is the server's job. */}
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  {...register('password', {
                    required: 'Password is required',
                  })}
                  className={`w-full px-4 py-2.5 pr-10 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 ${errors.password ? 'border-danger-500' : 'border-slate-300'}`}
                  disabled={isLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {errors.password && <p className="text-danger-600 text-sm mt-1">{errors.password.message}</p>}
            </div>

            <div className="flex items-center text-sm">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  disabled={isLoading}
                  {...register('remember')}
                />
                <span className="ml-2 text-slate-700">Remember me</span>
              </label>
            </div>

            <Button type="submit" size="lg" loading={isLoading} className="w-full justify-center">
              {isLoading ? 'Signing in…' : 'Sign In'}
            </Button>
          </form>
          </>
          )}
        </div>

        <p className="text-center text-xs text-primary-200/70 mt-6">© {year} Lancer International · v1.0.0</p>
      </div>
    </div>
  );
}
