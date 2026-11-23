import { useState } from 'react';
import toast from 'react-hot-toast';
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';

// Crypto-backed, 14 chars (comfortably over the 12-char policy minimum).
// Excludes visually ambiguous characters (0/O, 1/l/I) so an admin can
// dictate it over a call / WhatsApp without confusion.
export function generateStrongPassword(len = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const cryptoObj = typeof window !== 'undefined' && window.crypto;
  const bytes = new Uint32Array(len);
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/**
 * Shared admin password field: masked input + show/hide, Generate (strong
 * random) and Copy-to-clipboard. Controlled — pass `value` and `onChange(next)`
 * (onChange receives the new string, not an event). Used by the user create,
 * edit, and reset flows so they can't drift apart.
 */
export default function PasswordField({
  value,
  onChange,
  name = 'password',
  placeholder = '••••••••',
  autoComplete = 'new-password',
  hint,
}) {
  const [show, setShow] = useState(false);

  const handleGenerate = () => {
    onChange(generateStrongPassword());
    setShow(true);
    toast.success('Strong password generated — copy it before saving');
  };

  const handleCopy = async () => {
    if (!value) {
      toast.error('No password to copy. Type one or click Generate.');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Password copied to clipboard');
    } catch {
      toast.error('Copy failed — select the field and press Ctrl+C');
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            name={name}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete={autoComplete}
            placeholder={placeholder}
            className="w-full px-3 py-2 pr-10 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 font-mono"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-400 hover:text-slate-600"
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          title="Generate a strong random password"
          className="px-3 py-2 inline-flex items-center gap-1.5 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 shrink-0"
        >
          <RefreshCw size={14} />
          Generate
        </button>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy the typed/generated password so you can send it to the user"
          className="px-3 py-2 inline-flex items-center gap-1.5 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 shrink-0"
        >
          <Copy size={14} />
          Copy
        </button>
      </div>
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}
