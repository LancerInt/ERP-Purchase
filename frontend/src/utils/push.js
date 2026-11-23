// Web Push (native notifications) client helpers.
//
// Registers the push-only service worker on demand, subscribes the device,
// and stores the subscription server-side so notify_user can reach it even
// when the app is closed. All calls are no-ops where push is unsupported.
import apiClient from './api.js';

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// VAPID public key (base64url) → Uint8Array for pushManager.subscribe.
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration() {
  // Register (idempotent — returns the existing registration if already there).
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/** 'unsupported' | 'denied' | 'on' | 'off' */
export async function pushStatus() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Ask permission, subscribe, and persist server-side. Throws on failure. */
export async function enablePush() {
  if (!pushSupported()) {
    throw new Error('Notifications aren’t supported on this device/browser. On iPhone, install the app to the Home Screen first.');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      'Your browser blocked notifications for this site. Allow them in the browser’s site settings, then try again. '
      + '(Private / Incognito windows usually block notifications — use a normal window.)',
    );
  }
  const { data } = await apiClient.get('/api/notifications/push/vapid-key/');
  const key = data?.public_key;
  if (!key) {
    throw new Error('Push isn’t configured on the server yet (missing VAPID key).');
  }
  const reg = await getRegistration();
  const appServerKey = urlB64ToUint8Array(key);
  let sub = await reg.pushManager.getSubscription();
  // A subscription is bound to the VAPID public key it was created with. If the
  // server's key has since changed, the existing subscription can NEVER receive
  // a push (the push service rejects every send with 403). Detect that and drop
  // it so we re-subscribe with the current key — one Enable tap self-heals.
  if (sub) {
    let existing = null;
    try {
      const k = sub.options && sub.options.applicationServerKey;
      existing = k ? new Uint8Array(k) : null;
    } catch { existing = null; }
    const sameKey = existing
      && existing.length === appServerKey.length
      && existing.every((b, i) => b === appServerKey[i]);
    if (existing && !sameKey) {
      try { await sub.unsubscribe(); } catch { /* best effort */ }
      sub = null;
    }
  }
  let created = false;
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });
    created = true;
  }
  const json = sub.toJSON();
  try {
    await apiClient.post('/api/notifications/push/subscribe/', {
      endpoint: sub.endpoint,
      keys: json.keys,
      user_agent: navigator.userAgent,
    });
  } catch (err) {
    // The server didn't record the subscription — roll back the one we just
    // created so pushStatus() reports 'off' instead of a phantom 'on' that
    // notify_user can never actually reach. (Leave a pre-existing sub alone.)
    if (created) {
      try { await sub.unsubscribe(); } catch { /* best effort */ }
    }
    throw err;
  }
  return true;
}

/** Unsubscribe this device and drop it server-side. */
export async function disablePush() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      try {
        await apiClient.post('/api/notifications/push/unsubscribe/', { endpoint: sub.endpoint });
      } catch { /* server prunes dead subs anyway */ }
      await sub.unsubscribe();
    }
  } catch { /* nothing to clean up */ }
}
