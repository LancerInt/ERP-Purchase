import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Address Field Component for Sales Module
 * Format: Raw Address, State, District, Pincode, Country
 */

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim',
  'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
];

// State aliases — handle the printed-address variants we see most
// commonly in imported customer master rows (no-space squashes like
// "TAMILNADU", abbreviations like "TN", and the consistent typo
// "Tamilnadi"). Keys are stored UPPER-CASE / NO-SPACE for a single
// uniform lookup; the value is the canonical INDIAN_STATES entry.
const STATE_ALIASES = {
  // Tamil Nadu
  TAMILNADU: 'Tamil Nadu', TAMILNADI: 'Tamil Nadu', TN: 'Tamil Nadu',
  // Karnataka
  KARNATAKA: 'Karnataka', KA: 'Karnataka',
  // Kerala
  KERALA: 'Kerala', KL: 'Kerala',
  // Maharashtra
  MAHARASHTRA: 'Maharashtra', MH: 'Maharashtra',
  // Andhra / Telangana
  ANDHRAPRADESH: 'Andhra Pradesh', AP: 'Andhra Pradesh',
  TELANGANA: 'Telangana', TS: 'Telangana', TG: 'Telangana',
  // Gujarat / Rajasthan / MP
  GUJARAT: 'Gujarat', GJ: 'Gujarat',
  RAJASTHAN: 'Rajasthan', RJ: 'Rajasthan',
  MADHYAPRADESH: 'Madhya Pradesh', MP: 'Madhya Pradesh',
  // North-east / east
  WESTBENGAL: 'West Bengal', WB: 'West Bengal',
  UTTARPRADESH: 'Uttar Pradesh', UP: 'Uttar Pradesh',
  UTTARAKHAND: 'Uttarakhand', UK: 'Uttarakhand', UT: 'Uttarakhand',
  PUNJAB: 'Punjab', PB: 'Punjab',
  HARYANA: 'Haryana', HR: 'Haryana',
  BIHAR: 'Bihar', BR: 'Bihar',
  ODISHA: 'Odisha', OR: 'Odisha', ORISSA: 'Odisha',
  JHARKHAND: 'Jharkhand', JH: 'Jharkhand',
  CHHATTISGARH: 'Chhattisgarh', CG: 'Chhattisgarh', CHATTISGARH: 'Chhattisgarh',
  HIMACHALPRADESH: 'Himachal Pradesh', HP: 'Himachal Pradesh',
  JAMMU: 'Jammu and Kashmir', JAMMUKASHMIR: 'Jammu and Kashmir', JK: 'Jammu and Kashmir',
  // Smaller states / UTs
  DELHI: 'Delhi', DL: 'Delhi', NEWDELHI: 'Delhi',
  GOA: 'Goa', GA: 'Goa',
  ASSAM: 'Assam', AS: 'Assam',
  ARUNACHALPRADESH: 'Arunachal Pradesh', AR: 'Arunachal Pradesh',
  MANIPUR: 'Manipur', MN: 'Manipur',
  MEGHALAYA: 'Meghalaya', ML: 'Meghalaya',
  MIZORAM: 'Mizoram', MZ: 'Mizoram',
  NAGALAND: 'Nagaland', NL: 'Nagaland',
  SIKKIM: 'Sikkim', SK: 'Sikkim',
  TRIPURA: 'Tripura', TR: 'Tripura',
  PUDUCHERRY: 'Puducherry', PY: 'Puducherry', PONDICHERRY: 'Puducherry',
  CHANDIGARH: 'Chandigarh', CH: 'Chandigarh',
  LADAKH: 'Ladakh', LA: 'Ladakh',
};

// Sniffs a structured Indian address out of a free-form string —
// extracts the 6-digit PIN, matches one of the 36 states/UTs, and
// guesses the district from the comma-separated layout. Used as a
// fallback when `parseAddress` receives a plain string instead of a
// JSON-encoded object (e.g. an older Customer master record that
// stored the shipping address as one big text blob).
function _sniffFromPlainString(text) {
  const str = String(text || '');
  const out = { raw_address: str, state: '', district: '', pincode: '', country: 'India' };

  // PIN — first 6-digit token in the string.
  const pinMatch = str.match(/\b(\d{6})\b/);
  if (pinMatch) out.pincode = pinMatch[1];

  // State — first try a long-name substring match (case-insensitive)
  // against the canonical list, then fall back to scanning each
  // comma-separated segment against the alias map (handles
  // no-space squashes "TAMILNADU" / "MADHYAPRADESH", common typos
  // like "Tamilnadi", and 2-letter codes "TN" / "KA" / "MH").
  const upper = str.toUpperCase();
  for (const s of INDIAN_STATES) {
    if (upper.includes(s.toUpperCase())) {
      out.state = s;
      break;
    }
  }
  if (!out.state) {
    // Scan each token (segment between commas / spaces). Squash
    // internal whitespace before alias lookup so "TAMIL NADU" and
    // "TAMILNADU" hit the same bucket.
    const tokens = str.split(/[,/\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
    for (const t of tokens) {
      const squashed = t.replace(/\s+/g, '');
      if (STATE_ALIASES[squashed]) {
        out.state = STATE_ALIASES[squashed];
        break;
      }
    }
    // Last-ditch — scan multi-word segments against the alias map
    // with whitespace removed (catches "MADHYA PRADESH" written as
    // two separate tokens above).
    if (!out.state) {
      const squashedWhole = upper.replace(/\s+/g, '');
      for (const [alias, name] of Object.entries(STATE_ALIASES)) {
        // Only run multi-char aliases through the whole-string scan;
        // 2-letter codes (TN/KA/...) would match too aggressively
        // here (e.g. the "KA" in "KARNATAKA-bound" is a false hit).
        if (alias.length >= 4 && squashedWhole.includes(alias)) {
          out.state = name;
          break;
        }
      }
    }
  }

  // District — Indian addresses are usually printed in one of two
  // orders:
  //   …, <town>, <DISTRICT>, <pincode>, <state>, <country>
  //   …, <town>, <DISTRICT>, <state>, <pincode>, <country>
  // We split on commas, locate the segments that contain the pincode
  // and state, then take the segment immediately before whichever
  // appears first. That gives the district in both layouts.
  const segments = str.split(',').map(s => s.trim()).filter(Boolean);
  if (segments.length >= 2 && (out.pincode || out.state)) {
    const upperSeg = segments.map(s => s.toUpperCase());
    const upperSegSquashed = upperSeg.map(s => s.replace(/\s+/g, ''));
    const pinIdx = out.pincode ? upperSeg.findIndex(s => s.includes(out.pincode)) : -1;

    // Locate the state segment robustly. Try (1) the canonical
    // full-name match, (2) the squashed-name match (handles
    // "TAMILNADU" in the address when canonical is "Tamil Nadu"),
    // (3) any alias that maps to the same canonical state (catches
    // typos like "Tamilnadi" and short forms like "MP").
    let stateIdx = -1;
    if (out.state) {
      const canonUpper = out.state.toUpperCase();
      const canonSquashed = canonUpper.replace(/\s+/g, '');
      stateIdx = upperSeg.findIndex(s => s.includes(canonUpper));
      if (stateIdx === -1) {
        stateIdx = upperSegSquashed.findIndex(s => s.includes(canonSquashed));
      }
      if (stateIdx === -1) {
        for (const [alias, name] of Object.entries(STATE_ALIASES)) {
          // Skip 2-letter codes here — they false-match too easily
          // against road / village names ("AP" in "Apnagar" etc.).
          if (alias.length < 4 || name !== out.state) continue;
          const idx = upperSegSquashed.findIndex(s => s.includes(alias));
          if (idx !== -1) { stateIdx = idx; break; }
        }
      }
    }

    let anchor = -1;
    if (pinIdx === -1) anchor = stateIdx;
    else if (stateIdx === -1) anchor = pinIdx;
    else anchor = Math.min(pinIdx, stateIdx);

    if (anchor > 0) {
      const candidate = segments[anchor - 1];
      // Reject anchors that point at the state, the literal country
      // name, or a bare numeric (pincode) so we don't end up with
      // "Karnataka" / "636004" / "INDIA" in the District field.
      const candUpper = candidate.toUpperCase();
      const candSquashed = candUpper.replace(/\s+/g, '');
      const isState = out.state && (
        candUpper === out.state.toUpperCase()
        || candSquashed === out.state.toUpperCase().replace(/\s+/g, '')
        || STATE_ALIASES[candSquashed] === out.state
      );
      const isCountry = candUpper === 'INDIA' || candUpper === 'BHARAT';
      const isPin = /^\d{4,6}$/.test(candidate.replace(/\s+/g, ''));
      if (!isState && !isCountry && !isPin && candidate.length >= 2) {
        out.district = candidate;
      }
    }
  }

  return out;
}

export function parseAddress(value) {
  const defaults = {
    address_label: '', contact_person: '', contact_phone: '',
    raw_address: '', state: '', district: '', pincode: '', country: 'India',
  };
  if (!value) return defaults;
  let obj = null;
  if (typeof value === 'object' && !Array.isArray(value)) obj = value;
  else if (typeof value === 'string') {
    try { const p = JSON.parse(value); if (typeof p === 'object' && !Array.isArray(p)) obj = p; } catch {}
  }
  if (obj) {
    // Map old format (street/city/postal_code) to new format (raw_address/district/pincode).
    // `obj.full` is the shape the PO-extractor's "Add to customer master"
    // flow used to save with — accepting it here means existing rows
    // render correctly without a backend backfill.
    const raw = obj.raw_address || obj.street || obj.address_line || obj.line1 || obj.full || '';
    const district = obj.district || obj.city || '';
    const state = obj.state || '';
    const pincode = obj.pincode || obj.postal_code || obj.zip || '';
    const country = obj.country || 'India';
    // Pass-through fields used by the Company master (registered /
    // billing address cards) — they ride inside the same JSONField
    // alongside the structured address parts.
    const address_label = obj.address_label || obj.label || '';
    const contact_person = obj.contact_person || '';
    const contact_phone = obj.contact_phone || '';
    // Backstop: if any of state/district/pincode was empty on the
    // structured side, sniff it out of the raw_address. Explicit
    // values from the source object always win.
    if (!pincode || !state || !district) {
      const sniff = _sniffFromPlainString(raw || '');
      return {
        address_label, contact_person, contact_phone,
        raw_address: raw,
        state: state || sniff.state,
        district: district || sniff.district,
        pincode: pincode || sniff.pincode,
        country,
      };
    }
    return { address_label, contact_person, contact_phone, raw_address: raw, state, district, pincode, country };
  }
  return _sniffFromPlainString(value);
}

export function stringifyAddress(addr) {
  if (!addr) return '';
  return JSON.stringify(addr);
}

export function formatAddressDisplay(value) {
  const a = parseAddress(value);
  return [a.raw_address, a.district, a.state, a.pincode, a.country].filter(Boolean).join(', ');
}

export function getDistrictState(value) {
  const a = parseAddress(value);
  return [a.district, a.state].filter(Boolean).join(', ');
}

export default function AddressField({ value, onChange, label, disabled }) {
  const addr = parseAddress(value);

  const handleFieldChange = (field, val) => {
    const updated = { ...addr, [field]: val };
    onChange(stringifyAddress(updated));
  };

  return (
    <div>
      {label && <label className="block text-xs font-medium text-slate-600 mb-1.5">{label}</label>}
      <div className="space-y-2">
        <div>
          <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Address</label>
          <textarea value={addr.raw_address} onChange={(e) => handleFieldChange('raw_address', e.target.value)} disabled={disabled} rows={2} className={`${inputClass} ${disabled ? 'bg-slate-50' : ''}`} placeholder="Door No, Street, Area, Landmark" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">State</label>
            <CustomSelect value={addr.state} onChange={(e) => handleFieldChange('state', e.target.value)} disabled={disabled} className={`${inputClass} ${disabled ? 'bg-slate-50' : ''}`}>
              <option value="">Select State</option>
              {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">District</label>
            <input type="text" value={addr.district} onChange={(e) => handleFieldChange('district', e.target.value)} disabled={disabled} className={`${inputClass} ${disabled ? 'bg-slate-50' : ''}`} placeholder="District" />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Pincode</label>
            <input type="text" value={addr.pincode} onChange={(e) => handleFieldChange('pincode', e.target.value)} disabled={disabled} className={`${inputClass} ${disabled ? 'bg-slate-50' : ''}`} placeholder="Pincode" maxLength={6} />
          </div>
          <div>
            <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Country</label>
            <input type="text" value={addr.country || 'India'} onChange={(e) => handleFieldChange('country', e.target.value)} disabled={disabled} className={`${inputClass} ${disabled ? 'bg-slate-50' : ''}`} />
          </div>
        </div>
      </div>
    </div>
  );
}

export { INDIAN_STATES };
