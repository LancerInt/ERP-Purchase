import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Printer, Save, Loader2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '@/utils/formatters';

// Inline-editable field styles (same convention as the PO document). On
// screen they carry a faint dashed underline so the operator can see what's
// editable; in print the borders vanish and only the text remains, so the
// paper looks like a clean Quotation.
const editCls =
  'w-full bg-transparent px-1 py-0.5 border-b border-dashed border-slate-300 ' +
  'focus:outline-none focus:border-primary-500 print:border-0 print:px-0';
const editAreaCls =
  'w-full bg-transparent px-1 py-0.5 border border-dashed border-slate-300 rounded ' +
  'focus:outline-none focus:border-primary-500 print:border-0 print:px-0 resize-none';
// Variants for fields sitting on the accent-coloured sidebar — white text,
// translucent-white dashed underline that also disappears in print. Kept
// colour-neutral so they read well over whatever accent the operator picks.
const tealEditCls =
  'w-full bg-transparent px-1 py-0.5 border-b border-dashed border-white/50 ' +
  'text-white placeholder-white/60 focus:outline-none focus:border-white ' +
  'print:border-0 print:px-0';
const tealEditAreaCls =
  'w-full bg-transparent px-1 py-0.5 border border-dashed border-white/50 rounded ' +
  'text-white placeholder-white/60 focus:outline-none focus:border-white ' +
  'print:border-0 print:px-0 resize-none';

// Browsers drop background colours in print unless told otherwise — every
// accent-filled container carries this so the printed sheet matches the screen.
const printExact = { WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' };

// House accent — the SS Biochem teal from the original Quotation sheet.
const ACCENT = '#0d9488';

// A read-only-in-print, editable-on-screen single-line text field.
//
// PRINT TWIN: an <input> clips its value to its box on paper — "Humic
// Liquid" printed as "Humic L". So the input is screen-only and a plain
// wrapped <span> with the same value renders in print instead, letting
// long content take its full width and wrap across lines.
function Field({ value, onChange, className = '', placeholder, teal = false }) {
  return (
    <>
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${teal ? tealEditCls : editCls} ${className} print:hidden`}
      />
      <span className={`hidden print:inline whitespace-pre-wrap break-words ${teal ? 'text-white' : ''}`}>
        {value ?? ''}
      </span>
    </>
  );
}

// Print twin for textareas — same clipping problem, block-level.
function PrintText({ value, className = '', style }) {
  return (
    <div style={style} className={`hidden print:block whitespace-pre-wrap break-words ${className}`}>
      {value ?? ''}
    </div>
  );
}

// Label : field row used inside the teal sidebar (bank details etc.).
function TealRow({ label, value, onChange, placeholder }) {
  return (
    <div className="flex items-baseline gap-1 text-[12px]">
      <span className="w-24 shrink-0 text-white/80">{label}</span>
      <span className="text-white/80">:</span>
      <Field teal value={value} onChange={onChange} placeholder={placeholder} />
    </div>
  );
}

// registered_address is a JSON blob (street/city/state/pincode…) but has
// been free-typed in places — flatten whatever shape shows up.
function flattenAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    return [a.street, a.raw_address, a.city, a.district, a.state, a.country, a.pincode]
      .filter(Boolean)
      .join(', ');
  }
  return String(a);
}

// Keep the saved value selectable even if it's not in the options master.
const withCurrent = (options, current) =>
  current && !options.includes(current) ? [current, ...options] : options;

export default function SalesQuoteDocument() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit } = usePermissions();
  const hasEdit = canEdit('Sales Quote');

  const [quote, setQuote] = useState(null);
  const [doc, setDoc] = useState(null);
  const [deliveryOptions, setDeliveryOptions] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const accent = ACCENT;

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/sales/quotations/${id}/`);
        const q = res.data;
        setQuote(q);

        // Company master feeds the teal sidebar; fall back to the names
        // already denormalised on the quote if the fetch fails.
        let company = null;
        if (q.company) {
          try {
            company = (await apiClient.get(`/api/companies/${q.company}/`)).data;
          } catch { /* sidebar falls back to quote fields */ }
        }

        setDoc({
          // ── Teal sidebar (all printout-only) ─────────────────────
          companyName: company?.legal_name || q.company_name || '',
          companyAddress: flattenAddress(company?.registered_address),
          companyEmail: company?.contact_email || '',
          companyGstin: company?.gstin || '',
          companyIec: '',
          bankName: '', bankBranch: '', bankBeneficiary: '',
          bankIfsc: '', bankSwift: '', bankAcNo: '', bankAcType: '',
          // ── Consignee (printout-only) ────────────────────────────
          consigneeName: q.consignee_name || q.customer_name || '',
          consigneeAddress: q.consignee_address || q.billing_address || '',
          consigneeGstin: q.consignee_gstin || q.billing_gstin || '',
          // ── Meta ─────────────────────────────────────────────────
          quoteNo: q.quote_no || '',
          quoteDate: q.quote_date || '',
          // ── Shipment details ─────────────────────────────────────
          deliveryTerms: q.delivery_terms || '',          // persists
          specialInstructions: q.special_instructions || '', // persists
          remarks: q.remarks || '',                        // persists
          // ── Table + trailing blocks (printout-only) ──────────────
          lines: (q.quotation_lines || []).map((l) => ({
            id: l.id,
            product: l.product_name || '',
            packages: [l.quantity, l.uom].filter(Boolean).join(' '),
            description: l.description || l.product_code || '',
            price: l.unit_price ?? '',
            uom: l.uom || '',
            // GST: gst_type is the picked label ("2.5+2.5", "9+9" = a
            // CGST+SGST split → shown as "GST"; "5", "18" = a single rate
            // → shown as "IGST"); gst is the effective total used for the
            // value math. Editable printout-only, like the other cells.
            gstText: (l.gst_type || (l.gst != null ? String(l.gst) : '')).trim(),
            quantity: l.quantity ?? '',
          })),
          freightNote: q.freight_terms || 'Extra Insurance and Freight Charges',
          declaration:
            'We Declare that this Invoice shows the Actual Price of the Goods ' +
            'described and that all particulars are true and correct',
          tagline: '" Go Organic ! Save Planet ! "',
        });
      } catch (err) {
        if (err.response?.status !== 404) toast.error(getApiErrorMessage(err));
      } finally {
        setIsLoading(false);
      }
    })();

    // Delivery-term options master (same source as the quote form).
    apiClient.get('/api/sales/quotations/term-options/').then((r) => {
      setDeliveryOptions((r.data || []).filter((o) => o.kind === 'DELIVERY').map((o) => o.value));
    }).catch(() => {});
  }, [id]);

  const set = (key, value) => setDoc((prev) => ({ ...prev, [key]: value }));
  const setLine = (idx, key, value) =>
    setDoc((prev) => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === idx ? { ...l, [key]: value } : l)),
    }));

  const doPrint = () => {
    // Defer so any pending state flush paints before the print snapshot.
    setTimeout(() => window.print(), 60);
  };

  // Save only — printing is its own button (same split as the PO
  // document: the combined action forced the print dialog on every save).
  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        delivery_terms: doc.deliveryTerms || '',
        remarks: doc.remarks || '',
        special_instructions: doc.specialInstructions || '',
      };
      const res = await apiClient.patch(`/api/sales/quotations/${id}/`, payload);
      setQuote(res.data);
      toast.success('Quote saved');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !doc) {
    return (
      <MainLayout>
        <div className="max-w-[820px] mx-auto space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />
          ))}
        </div>
      </MainLayout>
    );
  }

  if (!quote) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <p className="text-slate-600">Quotation not found</p>
          <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/quotes')} className="mt-4 text-blue-600 hover:text-blue-800">
            Back to Quotes
          </button>
        </div>
      </MainLayout>
    );
  }

  const priceUom = doc.lines.find((l) => l.uom)?.uom || 'Unit';

  // ── GST label + math ────────────────────────────────────────────────
  // The quote's GST option is either a CGST+SGST split written with a '+'
  // ("2.5+2.5", "9+9") — an intra-state supply, labelled plain "GST" — or
  // a single rate ("5", "18") — inter-state, labelled "IGST". The
  // effective percent is the sum of the '+' parts either way.
  const gstPctOf = (text) => {
    const parts = String(text || '').split('+').map((p) => parseFloat(p));
    if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null;
    return parts.reduce((a, b) => a + b, 0);
  };
  const gstHeaderLabel = (() => {
    const first = doc.lines.find((l) => (l.gstText || '').trim());
    if (!first) return 'GST';
    return first.gstText.includes('+') ? 'GST' : 'IGST';
  })();
  // Line total = quantity × unit price (taxable amount, before GST).
  const lineTotalOf = (l) => {
    const qty = parseFloat(l.quantity);
    const price = parseFloat(l.price);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return null;
    return qty * price;
  };
  // GST value = line total × effective % — the actual tax money.
  const gstValueOf = (l) => {
    const pct = gstPctOf(l.gstText);
    const total = lineTotalOf(l);
    if (pct == null || total == null) return null;
    return total * pct / 100;
  };
  // Document totals under the PACKING DETAILS table.
  const totals = doc.lines.reduce(
    (acc, l) => {
      acc.amount += lineTotalOf(l) || 0;
      acc.gst += gstValueOf(l) || 0;
      return acc;
    },
    { amount: 0, gst: 0 },
  );
  const inr = (n) => `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <MainLayout>
      {/* Toolbar — hidden on paper */}
      <div className="max-w-[820px] mx-auto flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden">
        <button
          onClick={() => navigate(`/sales/quotes/${id}`)}
          className="flex items-center gap-2 text-slate-600 hover:text-slate-800 text-sm font-medium"
        >
          <ArrowLeft size={18} /> Back to Quote
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {hasEdit && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 text-sm font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button
            onClick={doPrint}
            className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"
          >
            <Printer size={16} /> Print
          </button>
        </div>
      </div>

      {!hasEdit && (
        <div className="max-w-[820px] mx-auto mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 print:hidden">
          You have view-only access — the document prints with the saved values (edits won't be saved).
        </div>
      )}
      {hasEdit && (
        <div className="max-w-[820px] mx-auto mb-3 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 print:hidden">
          Only <span className="font-semibold">Terms of Delivery, Special Instructions and Remarks</span> save
          to the quote — edits to everything else (bank details, IEC, consignee, packages, descriptions,
          prices, declaration, tagline) affect only this printout.
        </div>
      )}

      {/* ── The A4 Quotation document ───────────────────────────────── */}
      <div className="max-w-[780px] print:max-w-none mx-auto bg-white text-slate-900 border border-slate-400 text-[13px] leading-snug">
        {/* Upper region: TWO vertical columns, like the original sheet.
            LEFT column = logo on white with the accent sidebar starting
            DIRECTLY beneath it (stretching to the bottom of the region);
            RIGHT column = Consignee + the flush top-right Quotation stack,
            then SHIPMENT DETAILS. */}
        <div className="flex items-stretch">
          {/* LEFT column: logo, then the sidebar */}
          <div className="w-[38%] shrink-0 flex flex-col">
            {/* Fixed h-28 so the sidebar top, the Consignee heading and the
                Quotation block bottom all sit on the same 112px line, like
                the original sheet. */}
            <div className="h-28 flex items-center px-4 sm:px-5">
              <img src="/ssb-logo.png" alt="Company logo" className="max-h-16 w-auto object-contain" />
            </div>
            <div className="flex-1 text-white p-5 space-y-1.5" style={{ ...printExact, backgroundColor: accent }}>
              <Field teal value={doc.companyName} onChange={(v) => set('companyName', v)} className="font-bold text-[14px]" />
              <textarea
                rows={3}
                value={doc.companyAddress}
                onChange={(e) => set('companyAddress', e.target.value)}
                className={`${tealEditAreaCls} text-[12px] print:hidden`}
              />
              <PrintText value={doc.companyAddress} className="text-[12px] text-white" />
              <TealRow label="Email" value={doc.companyEmail} onChange={(v) => set('companyEmail', v)} />
              <TealRow label="GSTIN" value={doc.companyGstin} onChange={(v) => set('companyGstin', v)} />
              <TealRow label="IEC No" value={doc.companyIec} onChange={(v) => set('companyIec', v)} />

              <p className="pt-3 font-bold text-[13px] tracking-wide">Bank Details</p>
              <TealRow label="Bank Name" value={doc.bankName} onChange={(v) => set('bankName', v)} />
              <TealRow label="Branch name" value={doc.bankBranch} onChange={(v) => set('bankBranch', v)} />
              <TealRow label="Beneficiary" value={doc.bankBeneficiary} onChange={(v) => set('bankBeneficiary', v)} />
              <TealRow label="IFSCode" value={doc.bankIfsc} onChange={(v) => set('bankIfsc', v)} />
              <TealRow label="Swift Code" value={doc.bankSwift} onChange={(v) => set('bankSwift', v)} />
              <TealRow label="A/C No." value={doc.bankAcNo} onChange={(v) => set('bankAcNo', v)} />
              <TealRow label="A/C Type" value={doc.bankAcType} onChange={(v) => set('bankAcType', v)} />
            </div>
          </div>

          {/* RIGHT column: [Consignee | Quotation stack] then SHIPMENT DETAILS */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex">
          {/* Consignee */}
          <div className="flex-1 min-w-0 px-4 pt-28 pb-4">
            <p className="font-bold tracking-wide" style={{ color: accent }}>Consignee</p>
            <Field
              value={doc.consigneeName}
              onChange={(v) => set('consigneeName', v)}
              className="font-bold mt-1"
              placeholder="Consignee name"
            />
            <textarea
              rows={4}
              value={doc.consigneeAddress}
              onChange={(e) => set('consigneeAddress', e.target.value)}
              placeholder="Consignee address"
              className={`${editAreaCls} mt-1 text-[12px] text-slate-700 print:hidden`}
            />
            <PrintText value={doc.consigneeAddress} className="mt-1 text-[12px] text-slate-700" />
            <div className="mt-1 text-[12px]">
              <span className="text-slate-500">GSTIN: </span>
              <Field value={doc.consigneeGstin} onChange={(v) => set('consigneeGstin', v)} className="inline w-48" />
            </div>
          </div>

          {/* Quotation column — one flush right-aligned stack: a tall accent
              block with the title sitting at its BOTTOM, then Quote Number
              chip + value and Date chip + value directly beneath it. */}
          <div className="w-56 shrink-0 text-center">
            <div className="h-28 flex items-end justify-center pb-2" style={{ ...printExact, backgroundColor: accent }}>
              <h1 className="text-xl font-bold tracking-wider text-white">Quotation</h1>
            </div>
            <div className="text-white text-[12px] font-bold py-1" style={{ ...printExact, backgroundColor: accent }}>
              Quote Number
            </div>
            <div className="bg-white border border-slate-300 py-1 font-semibold">{doc.quoteNo}</div>
            <div className="text-white text-[12px] font-bold py-1" style={{ ...printExact, backgroundColor: accent }}>
              Date
            </div>
            <div className="bg-white border border-slate-300 py-1 font-semibold">{formatDate(doc.quoteDate)}</div>
          </div>
        </div>

            {/* SHIPMENT DETAILS — inside the right column, beside the sidebar */}
            <div className="px-5 pb-5">
              <div className="text-center">
                <h2 className="inline-block text-base font-bold tracking-[0.25em] text-slate-800 border-b border-slate-400 pb-0.5">
                  SHIPMENT DETAILS
                </h2>
              </div>
              <div className="mt-2 space-y-1.5 text-[13px]">
                <div className="flex items-center gap-2">
                  <span className="w-44 shrink-0 font-semibold" style={{ color: accent }}>Terms of Delivery</span>
                  <span>:</span>
                  <div className="w-64 print:hidden">
                    <CustomSelect
                      value={doc.deliveryTerms}
                      onChange={(e) => set('deliveryTerms', e.target.value)}
                      className={editCls}
                    >
                      <option value="">—</option>
                      {withCurrent(deliveryOptions, doc.deliveryTerms).map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </CustomSelect>
                  </div>
                  <span className="hidden print:inline">{doc.deliveryTerms || '—'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-44 shrink-0 font-semibold" style={{ color: accent }}>Special Instructions</span>
                  <span>:</span>
                  <Field value={doc.specialInstructions} onChange={(v) => set('specialInstructions', v)} className="flex-1" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-44 shrink-0 font-semibold" style={{ color: accent }}>Remarks</span>
                  <span>:</span>
                  <Field value={doc.remarks} onChange={(v) => set('remarks', v)} className="flex-1" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Third band — FULL WIDTH. In the original sheet the sidebar ends
            and the PACKING DETAILS table spans the whole page beneath it;
            squeezing 7 columns into the sidebar's right column is what made
            the table overflow the printable area. */}
        <div className="px-5 pt-4">
            {/* PACKING DETAILS — product table */}
            <div className="text-center">
              <h2 className="inline-block text-base font-bold tracking-[0.25em] text-slate-800 border-b border-slate-400 pb-0.5">
                PACKING DETAILS
              </h2>
            </div>
            <table className="w-full border border-slate-300 border-collapse mt-2 text-[12px]">
              <thead>
                {/* Original layout: WHITE header row with accent-coloured
                    bold text and thin borders — not a filled band. */}
                <tr className="bg-white">
                  {['S.No', 'Product Details', 'No. & Kind of Packages', 'Description of Goods', `Price per ${priceUom}`, `${gstHeaderLabel} %`, 'Line Total'].map((h) => (
                    <th key={h} className="border border-slate-300 px-2 py-2 font-bold text-center" style={{ color: accent }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((l, idx) => (
                  <tr key={l.id || idx} className="align-top">
                    <td className="border border-slate-300 px-2 py-2 w-10 text-center">{idx + 1}</td>
                    <td className="border border-slate-300 px-2 py-2 text-center">
                      <Field value={l.product} onChange={(v) => setLine(idx, 'product', v)} className="text-center" />
                    </td>
                    <td className="border border-slate-300 px-2 py-2 text-center">
                      <Field
                        value={l.packages}
                        onChange={(v) => setLine(idx, 'packages', v)}
                        placeholder="e.g. 200Ltrs x 40 Nos = 8 Tons"
                        className="text-center"
                      />
                    </td>
                    <td className="border border-slate-300 px-2 py-2 text-center">
                      <Field value={l.description} onChange={(v) => setLine(idx, 'description', v)} className="text-center" />
                    </td>
                    <td className="border border-slate-300 px-2 py-2">
                      <div className="flex items-center justify-center gap-0.5 whitespace-nowrap">
                        <span>₹</span>
                        <input
                          type="number" step="any" min="0"
                          value={l.price}
                          onChange={(e) => setLine(idx, 'price', e.target.value)}
                          className={`${editCls} w-16 text-center print:hidden`}
                        />
                        <span className="hidden print:inline">{l.price !== '' && l.price != null ? Number(l.price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</span>
                      </div>
                    </td>
                    <td className="border border-slate-300 px-2 py-2">
                      <div className="flex items-center justify-center gap-0.5 whitespace-nowrap">
                        <Field
                          value={l.gstText}
                          onChange={(v) => setLine(idx, 'gstText', v)}
                          placeholder="2.5+2.5"
                          className="w-12 text-center"
                        />
                        <span>%</span>
                      </div>
                    </td>
                    <td className="border border-slate-300 px-2 py-2 text-center whitespace-nowrap">
                      {lineTotalOf(l) != null ? inr(lineTotalOf(l)) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Freight / insurance strip */}
            <div className="border border-t-0 border-slate-300 bg-slate-100 px-3 py-2 text-center" style={printExact}>
              <Field value={doc.freightNote} onChange={(v) => set('freightNote', v)} className="font-medium text-center" />
            </div>

            {/* Totals — taxable amount, GST/IGST money, grand total. Plain
                flex rows in a NARROW fixed-width column (not a table) so no
                inherited table styling can stretch heavy rules across the
                page — only the Grand Total gets a short, thin separator. */}
            <div className="flex justify-end mt-3">
              <div className="w-64 text-[13px]">
                <div className="flex justify-between py-0.5">
                  <span className="text-slate-600">Total Amount</span>
                  <span className="font-medium whitespace-nowrap">{inr(totals.amount)}</span>
                </div>
                <div className="flex justify-between py-0.5">
                  <span className="text-slate-600">{gstHeaderLabel} Amount</span>
                  <span className="font-medium whitespace-nowrap">{inr(totals.gst)}</span>
                </div>
                <div className="flex justify-between py-1 mt-0.5 border-t border-slate-300">
                  <span className="font-bold" style={{ color: accent }}>Grand Total</span>
                  <span className="font-bold whitespace-nowrap" style={{ color: accent }}>{inr(totals.amount + totals.gst)}</span>
                </div>
              </div>
            </div>

        </div>

        {/* Declaration + For <company> — full-width band */}
        <div className="px-5 pt-6 flex justify-between gap-4 sm:gap-5">
          <div className="w-3/5">
            <p className="font-bold">Declaration</p>
            <textarea
              rows={3}
              value={doc.declaration}
              onChange={(e) => set('declaration', e.target.value)}
              className={`${editAreaCls} mt-1 text-[12px] text-slate-700 print:hidden`}
            />
            <PrintText value={doc.declaration} className="mt-1 text-[12px] text-slate-700" />
          </div>
          <div className="w-2/5 text-right">
            <p className="font-semibold">For {doc.companyName || 'Company'}</p>
            <p className="mt-8 text-[11px] italic text-slate-500">
              This Quotation was auto-generated — seal and signature are not required.
            </p>
          </div>
        </div>

        {/* Footer tagline — full width, centered like the original */}
        <div className="px-5 py-5">
          <input
            type="text"
            value={doc.tagline}
            onChange={(e) => set('tagline', e.target.value)}
            style={{ color: accent }}
            className={`${editCls} text-center font-semibold print:hidden`}
          />
          <PrintText value={doc.tagline} className="text-center font-semibold" style={{ color: accent }} />
        </div>
      </div>
    </MainLayout>
  );
}
