/**
 * "Reconcile from File" — a SEPARATE button that does exactly what
 * `ReconcileButton` (Reconcile with Tally) does, EXCEPT the Tally side comes from
 * an uploaded **Purchase Register XML file** instead of the live gateway.
 *
 * Why: TallyPrime EDU can't serve a complete purchase export over the gateway
 * (it truncates / crashes), so the live reconcile compares against an incomplete
 * Tally list. A Purchase Register export is purchase-only, so it's small and
 * complete. This uploads that file to /api/purchase/zoho/reconcile-file/ and
 * renders the identical three tabs. The apply actions (create_from_tally /
 * apply_overrides / apply_date_overrides) are the SAME endpoints — they're keyed
 * by zoho_id/bill_id, independent of how Tally was fetched.
 *
 * This file does NOT modify the existing "Reconcile with Tally" feature.
 */
import { useEffect, useState } from 'react';
import { Loader2, X, Scale, FileUp, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import { fmtINRfull, MapControl } from './shared.jsx';

// Spend categories for the vendor tagger (matches VendorBill.PURCHASE_CATEGORY_CHOICES).
const CATS = [
  ['RM', 'RM Purchase'],
  ['PACKING', 'Packing Material'],
  ['FREIGHT', 'Freight / Transport'],
  ['EXPENSES', 'Expenses'],
  ['MACHINERY', 'Machinery / Capital'],
];

export function ReconcileFromFileButton({ f, label, onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [file, setFile] = useState(null);           // the Purchase Register XML
  const [company, setCompany] = useState('');        // Tally company (auto-filled from the file)
  const [from, setFrom] = useState(f?.from || '');
  const [to, setTo] = useState(f?.to || '');
  const [sel, setSel] = useState({});   // tally_only key -> selected (true) to create
  const [keep, setKeep] = useState({});
  const [keepDate, setKeepDate] = useState({});
  const [doneDates, setDoneDates] = useState(() => new Set());
  const [vmap, setVmap] = useState({});
  const [pmap, setPmap] = useState({});
  const [q, setQ] = useState('');
  const [coFilter, setCoFilter] = useState('');
  const [tab, setTab] = useState('missing');
  const [align, setAlign] = useState(null);   // header-split (Ex-GST/GST) differences vs Tally
  const [masterFile, setMasterFile] = useState(null);  // Tally Master/Ledger XML (vendor linking)
  const [linkData, setLinkData] = useState(null);      // vendor↔Tally link dry-run result
  const [vtypeFile, setVtypeFile] = useState(null);    // Tally Voucher Type master / Purchase Vouchers XML
  const [vtypeData, setVtypeData] = useState(null);    // purchase voucher-type set (real class) dry-run
  const [tagData, setTagData] = useState(null);        // Unclassified-vendor list (vendor tagger)
  const [tagPicks, setTagPicks] = useState({});        // vendor_id -> chosen category
  const [tagCompany, setTagCompany] = useState('');    // company code (from picker / server)
  const [guidData, setGuidData] = useState(null);      // GUID-sync (stamp Tally ID) dry-run
  const [missData, setMissData] = useState(null);      // bills in Tally, missing from ERP (create)
  const [clsData, setClsData] = useState(null);        // per-bill category from the Tally ledger
  const [extraData, setExtraData] = useState(null);    // ERP bills with no matching Tally voucher (extras)
  const [dupData, setDupData] = useState(null);        // duplicate bills in the ERP (cancel extras)
  const [dupCompany, setDupCompany] = useState('');    // company code (from picker / server)
  const [photo, setPhoto] = useState(null);
  const openPhoto = async (billId, kind) => {
    setPhoto({ billId, kind, url: null, loading: true, error: null });
    try {
      const res = await apiClient.get(`/api/purchase/bills/${billId}/zoho-photo/?kind=${kind || 'invoice'}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      setPhoto((p) => (p && p.billId === billId ? { ...p, url, loading: false } : p));
    } catch (e) {
      let msg = 'Could not load the photo from Zoho.';
      try {
        const blob = e?.response?.data;
        if (blob?.text) { const j = JSON.parse(await blob.text()); if (j?.detail) msg = j.detail; }
      } catch { /* keep the generic message */ }
      setPhoto((p) => (p && p.billId === billId ? { ...p, loading: false, error: msg } : p));
    }
  };
  const closePhoto = () => setPhoto((p) => { if (p?.url) URL.revokeObjectURL(p.url); return null; });
  // Namespaced DIFFERENTLY from the live reconcile so the two never collide.
  const picksKey = `reconcile-file-picks:${(company || '').trim().toLowerCase() || 'default'}`;
  useEffect(() => {
    if (!open || !data) return;
    try { localStorage.setItem(picksKey, JSON.stringify({ sel, vmap, pmap, keep, keepDate })); } catch { /* quota / private mode */ }
  }, [sel, vmap, pmap, keep, keepDate, open, data, picksKey]);

  const run = async () => {
    if (!file && !masterFile && !vtypeFile) { toast.error('Choose the Purchase Register, Master, and/or Voucher Types XML first.'); return; }
    setBusy(true); setData(null); setAlign(null); setGuidData(null); setMissData(null); setClsData(null); setExtraData(null); setDoneDates(new Set());
    if (masterFile) setLinkData(null);
    if (vtypeFile) setVtypeData(null);
    let tc = company;
    try {
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        if (from) fd.append('from', from);
        if (to) fd.append('to', to);
        if (company) fd.append('tally_company', company);
        const r = await apiClient.post('/api/purchase/zoho/reconcile-file/', fd,
          { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
        setData(r.data); setQ(''); setCoFilter('');
        if (r.data?.tally_company && !company) setCompany(r.data.tally_company);
        tc = r.data?.tally_company || company;
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(`reconcile-file-picks:${(r.data?.tally_company || company || '').trim().toLowerCase() || 'default'}`) || '{}'); } catch { saved = {}; }
        setSel(saved.sel || {}); setVmap(saved.vmap || {}); setPmap(saved.pmap || {});
        const _ms = r.data?.mismatches || []; const _to = r.data?.tally_only || [];
        const _dm = r.data?.date_mismatches || [];
        const _k = {}; _ms.forEach((m) => { _k[m.zoho_id] = saved.keep?.[m.zoho_id] || 'zoho'; }); setKeep(_k);
        const _kd = {}; _dm.forEach((m) => { _kd[m.zoho_id] = saved.keepDate?.[m.zoho_id] || 'zoho'; }); setKeepDate(_kd);
        setTab(_to.length > 0 || (_ms.length === 0 && _dm.length === 0) ? 'missing' : (_ms.length ? 'diff' : 'date'));
        // Ex-GST/GST header SPLIT from the SAME file (Tally as base).
        try {
          const fda = new FormData();
          fda.append('file', file);
          if (from) fda.append('from', from);
          if (to) fda.append('to', to);
          if (tc) fda.append('tally_company', tc);
          if (r.data?.company_id) fda.append('company', r.data.company_id);
          const ra = await apiClient.post('/api/purchase/zoho/align-file/', fda,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
          setAlign(ra.data);
        } catch { setAlign(null); }
        // Stamp-Tally-ID (GUID sync) dry-run from the SAME file.
        try {
          const fdg = new FormData();
          fdg.append('file', file);
          if (from) fdg.append('from', from);
          if (to) fdg.append('to', to);
          if (tc) fdg.append('tally_company', tc);
          if (r.data?.company_id) fdg.append('company', r.data.company_id);
          const rg = await apiClient.post('/api/purchase/zoho/guid-sync-file/', fdg,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
          setGuidData(rg.data);
        } catch { setGuidData(null); }
        // Bills that are in Tally but missing from the ERP (create as source=TALLY).
        try {
          const fdm = new FormData();
          fdm.append('file', file);
          if (from) fdm.append('from', from);
          if (to) fdm.append('to', to);
          if (tc) fdm.append('tally_company', tc);
          if (r.data?.company_id) fdm.append('company', r.data.company_id);
          const rm = await apiClient.post('/api/purchase/zoho/missing-bills-file/', fdm,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
          setMissData(rm.data);
        } catch { setMissData(null); }
        // Per-bill spend category from each voucher's Tally ledger (splits mixed vendors).
        try {
          const fdc = new FormData();
          fdc.append('file', file);
          if (from) fdc.append('from', from);
          if (to) fdc.append('to', to);
          if (tc) fdc.append('tally_company', tc);
          if (r.data?.company_id) fdc.append('company', r.data.company_id);
          const rc = await apiClient.post('/api/purchase/zoho/classify-ledger-file/', fdc,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
          setClsData(rc.data);
        } catch { setClsData(null); }
        // Extra bills: ERP bills with no matching Tally voucher (over-adds / twins).
        try {
          const fde = new FormData();
          fde.append('file', file);
          if (from) fde.append('from', from);
          if (to) fde.append('to', to);
          if (tc) fde.append('tally_company', tc);
          if (r.data?.company_id) fde.append('company', r.data.company_id);
          const rx = await apiClient.post('/api/purchase/zoho/extra-bills-file/', fde,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
          setExtraData(rx.data);
        } catch { setExtraData(null); }
      }
      // Vendor↔Tally linking from the Master file, if uploaded (GSTIN then name).
      if (masterFile) {
        try {
          const fdm = new FormData();
          fdm.append('file', masterFile);
          if (tc) fdm.append('tally_company', tc);
          const rl = await apiClient.post('/api/purchase/zoho/link-vendors-file/', fdm,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
          setLinkData(rl.data);
          if (!file) setTab('vendors');
        } catch (e) { setLinkData({ ok: false, detail: e?.response?.data?.detail || e.message }); }
      }
      // Real purchase voucher types from the Voucher Type master / Purchase report.
      if (vtypeFile) {
        try {
          const fdv = new FormData();
          fdv.append('file', vtypeFile);
          if (tc) fdv.append('tally_company', tc);
          const rv = await apiClient.post('/api/purchase/zoho/purchase-vtypes-file/', fdv,
            { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
          setVtypeData(rv.data);
          if (!file && !masterFile) setTab('vtypes');
        } catch (e) { setVtypeData({ ok: false, detail: e?.response?.data?.detail || e.message }); }
      }
    } catch (e) {
      setData({ tally_available: false, mismatches: [], tally_only: [], detail: e?.response?.data?.detail || e.message });
    } finally { setBusy(false); }
  };
  // Write the vendor↔Tally links from the Master file (GSTIN first, name second).
  const applyLinks = async () => {
    if (!masterFile) { toast.error('Upload the Master XML first.'); return; }
    const n = linkData?.changed || 0;
    if (!n) { toast('No vendor links to apply.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Link ${n} vendor(s) to their Tally ledgers (by GSTIN, then name)?\n\nOnly the vendor→Tally link is set — no bills touched. Reversible.`)) return;
    setBusy(true);
    const t = toast.loading('Linking vendors to Tally…');
    try {
      const fdm = new FormData();
      fdm.append('file', masterFile);
      const tc = company;
      if (tc) fdm.append('tally_company', tc);
      const rl = await apiClient.post('/api/purchase/zoho/link-vendors-file-apply/', fdm,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(rl.data?.detail || 'Linked.', { id: t });
      setLinkData(rl.data);
      onDone?.();
      setBusy(false);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Link failed.', { id: t }); setBusy(false); }
  };
  // Find bills the ERP holds more than once for the same vendor+invoice (the
  // duplicate pile that pushes "billed" above Tally). No file needed — reads the DB.
  const loadDuplicates = async (co) => {
    setBusy(true); setDupData(null);
    try {
      const body = {};
      const c = co || dupCompany;
      if (c) body.company = c;
      if (company) body.tally_company = company;
      const r = await apiClient.post('/api/purchase/zoho/duplicate-bills/', body, { timeout: 600000 });
      setDupData(r.data);
      if (r.data?.company) setDupCompany(r.data.company);
      setTab('dupes');
    } catch (e) {
      setDupData({ ok: false, detail: e?.response?.data?.detail || e.message });
      setTab('dupes');
    } finally { setBusy(false); }
  };
  // Cancel the extra copies (keeps the best one per group). status-only, reversible.
  const cancelDuplicates = async () => {
    const n = dupData?.total_extra_bills || 0;
    if (!n) { toast('No duplicates to cancel.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Cancel ${n} duplicate bill(s)?\n\nThe best copy of each is kept (Tally-linked / oldest); the extras are cancelled — status-only, reversible. No amounts change on the kept bills.`)) return;
    setBusy(true);
    const t = toast.loading('Cancelling duplicates…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/duplicate-bills-apply/',
        { company: dupCompany || dupData?.company, tally_company: company }, { timeout: 600000 });
      toast.success(r.data?.detail || 'Cancelled.', { id: t });
      onDone?.();
      await loadDuplicates(dupCompany || dupData?.company);   // refresh — cancelled ones drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Cancel failed.', { id: t }); setBusy(false); }
  };
  // Save the real purchase voucher-type set (so is_purchase uses Tally's class,
  // not the word 'purchase'). Reads from the uploaded Voucher Type master / report.
  const applyVtypes = async () => {
    if (!vtypeFile) { toast.error('Upload the Voucher Types / Purchase Vouchers XML first.'); return; }
    const n = vtypeData?.count || 0;
    if (!n) { toast('No purchase types read.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Save ${n} purchase voucher type(s) for this company?\n\nThe ERP will then decide "is this a purchase?" from Tally's real class instead of the word "purchase". Reversible — re-import any time.`)) return;
    setBusy(true);
    const t = toast.loading('Saving purchase types…');
    try {
      const fd = new FormData();
      fd.append('file', vtypeFile);
      const tc = company;
      if (tc) fd.append('tally_company', tc);
      const r = await apiClient.post('/api/purchase/zoho/purchase-vtypes-file-apply/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data?.detail || 'Saved.', { id: t });
      setVtypeData(r.data);
      onDone?.();
      setBusy(false);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Save failed.', { id: t }); setBusy(false); }
  };
  // Load the vendors whose bills Tally left ungrouped (classify's "Unclassified"
  // pile) so they can be tagged by hand. No file needed — reads the DB.
  const loadTagVendors = async (co) => {
    setBusy(true); setTagData(null);
    try {
      const body = {};
      const c = co || tagCompany;
      if (c) body.company = c;
      if (company) body.tally_company = company;   // Tally name auto-detected from a file
      const r = await apiClient.post('/api/purchase/zoho/unclassified-vendors/', body, { timeout: 600000 });
      setTagData(r.data);
      if (r.data?.company) setTagCompany(r.data.company);
      if (r.data?.vendors) {   // pre-fill each dropdown with the server's name-hint
        const seed = {};
        r.data.vendors.forEach((v) => { if (v.suggested) seed[v.vendor_id] = v.suggested; });
        setTagPicks(seed);
      }
      setTab('tag');
    } catch (e) {
      setTagData({ ok: false, detail: e?.response?.data?.detail || e.message });
      setTab('tag');
    } finally { setBusy(false); }
  };
  // Write the chosen category onto every Unclassified bill of each picked vendor
  // (stored as manual — a re-classify never overrides it). No amounts change.
  const applyTags = async () => {
    const assignments = Object.entries(tagPicks)
      .filter(([, cat]) => cat)
      .map(([vendor_id, category]) => ({ vendor_id, category }));
    if (!assignments.length) { toast('Pick a category for at least one vendor.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Tag ${assignments.length} vendor(s) with the chosen category?\n\nEvery Unclassified bill of each vendor gets that category (manual — a re-classify won't override it). No amounts change.`)) return;
    setBusy(true);
    const t = toast.loading('Tagging vendors…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/tag-vendors-apply/',
        { company: tagCompany || tagData?.company, tally_company: company, assignments }, { timeout: 600000 });
      toast.success(r.data?.detail || 'Tagged.', { id: t });
      onDone?.();
      await loadTagVendors(tagCompany || tagData?.company);   // refresh — tagged vendors drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Tag failed.', { id: t }); setBusy(false); }
  };
  const ms = data?.mismatches || [];
  const dms = (data?.date_mismatches || []).filter((m) => !doneDates.has(m.zoho_id));
  const tonly = data?.tally_only || [];
  const qn = q.trim().toLowerCase();
  const coOptions = [...new Set(tonly.map((t) => t.company_label).filter(Boolean))];
  const shown = tonly.filter((t) =>
    (!coFilter || t.company_label === coFilter)
    && (!qn || `${t.vendor_name} ${t.invoice_no}`.toLowerCase().includes(qn)));
  const setAllShown = (v) => setSel((p) => { const n = { ...p }; shown.forEach((t) => { n[t.key] = v; }); return n; });
  const nCreate = tonly.filter((t) => sel[t.key]).length;
  const nTally = ms.filter((m) => keep[m.zoho_id] === 'tally').length;
  const adiffs = align?.differences || [];   // Ex-GST/GST split differences vs Tally
  const nSplit = adiffs.length;
  const tagVendors = tagData?.vendors || [];
  const nTag = tagVendors.filter((v) => tagPicks[v.vendor_id]).length;   // vendors with a category chosen
  const gsum = guidData?.summary || null;
  const nGuid = gsum?.to_stamp || 0;   // bills that would get a Tally ID stamped
  const gstampRows = guidData?.to_stamp || [];
  const gclashRows = guidData?.conflicts || [];
  const msum = missData?.summary || null;
  const nMiss = msum?.to_create || 0;   // bills in Tally, missing from ERP, safe to create
  const missCreateRows = missData?.to_create || [];
  const missDupRows = missData?.likely_dups || [];
  const dupGroups = dupData?.groups || [];
  const nDup = dupData?.total_extra_bills || 0;   // extra bills that would be cancelled
  const clsSum = clsData?.summary || null;
  const nCls = clsSum?.to_change || 0;            // bills that would get a ledger category
  const clsRows = clsData?.changes || [];
  const extraRows = extraData?.extras || [];
  const nExtra = extraData?.total_extra || 0;     // ERP bills with no matching Tally voucher
  const vtypes = vtypeData?.types || [];
  const nVtype = vtypeData?.count || 0;           // real purchase voucher types read
  const applyDates = async () => {
    const overrides = {};
    dms.forEach((m) => { overrides[m.zoho_id] = keepDate[m.zoho_id] === 'tally' ? m.tally_date : m.zoho_date; });
    if (!Object.keys(overrides).length) { toast('Nothing to apply.', { icon: 'ℹ️' }); return; }
    setBusy(true);
    const t = toast.loading('Updating bill dates…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'apply_date_overrides', overrides });
      toast.success(r.data?.detail || 'Updated.', { id: t });
      onDone?.();
      const ids = Object.keys(overrides);
      setDoneDates((prev) => new Set([...prev, ...ids]));
      setKeepDate((prev) => { const n = { ...prev }; ids.forEach((id) => delete n[id]); return n; });
      setBusy(false);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Update failed.', { id: t }); setBusy(false); }
  };
  const applyChosen = async () => {
    const overrides = {};
    ms.forEach((m) => { if (keep[m.zoho_id] === 'tally') overrides[m.zoho_id] = m.tally.amount; });
    if (!Object.keys(overrides).length) { toast('No bill set to Tally — nothing to change.', { icon: 'ℹ️' }); return; }
    setBusy(true);
    const t = toast.loading('Updating bill amounts…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'apply_overrides', overrides });
      toast.success(r.data?.detail || 'Updated.', { id: t });
      onDone?.();
      await run();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Update failed.', { id: t }); setBusy(false); }
  };
  // One click: set EVERY amount + date difference to the Tally value (overrides
  // Zoho on those bills). This is the "make ERP match Tally" shortcut.
  const applyAllToTally = async () => {
    if (!file) { toast.error('Upload the file first.'); return; }
    const nA = (data?.mismatches || []).length;
    const nD = (data?.date_mismatches || []).length;
    if (!nA && !nD) { toast('No amount/date differences to apply.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Set ALL ${nA} amount + ${nD} date difference(s) to the Tally value?\n\nThis overrides Zoho on those bills so the ERP matches Tally.`)) return;
    setBusy(true);
    const t = toast.loading('Setting all amounts + dates to Tally…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (from) fd.append('from', from);
      if (to) fd.append('to', to);
      if (company) fd.append('tally_company', company);
      const r = await apiClient.post('/api/purchase/zoho/reconcile-file-apply-all/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data?.detail || 'Applied.', { id: t });
      onDone?.();
      await run();   // refresh — the applied bills now agree and drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Apply failed.', { id: t }); setBusy(false); }
  };
  // One click: set the Ex-GST/GST SPLIT of every differing bill to Tally's. Only
  // the header split moves — the total and the product lines are untouched. This
  // is the ₹40,844-type fix: totals already tie, but Zoho split goods/tax
  // differently than Tally. Reversible (logged in each bill's notes).
  const applySplits = async () => {
    if (!file) { toast.error('Upload the file first.'); return; }
    if (!nSplit) { toast('No split differences to apply.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Set the Ex-GST/GST split of ${nSplit} bill(s) to Tally?\n\nOnly the header split changes — the total and the product lines are untouched. Reversible (logged in each bill's notes).`)) return;
    setBusy(true);
    const t = toast.loading('Aligning splits to Tally…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (from) fd.append('from', from);
      if (to) fd.append('to', to);
      const tc = align?.tally_company || company;
      if (tc) fd.append('tally_company', tc);
      const r = await apiClient.post('/api/purchase/zoho/align-file-apply/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data?.detail || 'Aligned.', { id: t });
      onDone?.();
      await run();   // refresh — aligned bills now agree and drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Align failed.', { id: t }); setBusy(false); }
  };
  // One click: stamp Tally's voucher ID onto every matched bill that has none.
  // Only the identity field is written (no amounts, no products); never
  // overwrites a bill that already carries a different ID. Reversible (notes).
  const applyGuidSync = async () => {
    if (!file) { toast.error('Upload the Day Book / Purchase Register first.'); return; }
    const n = guidData?.summary?.to_stamp || 0;
    if (!n) { toast('No bills need a Tally ID — all matched bills are already linked.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Stamp Tally's ID onto ${n} bill(s)?\n\nOnly the Tally-ID link is written — no amounts, no products change. Bills that already carry a different ID are left alone. Reversible (logged in each bill's notes).`)) return;
    setBusy(true);
    const t = toast.loading('Stamping Tally IDs…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (from) fd.append('from', from);
      if (to) fd.append('to', to);
      const tc = guidData?.tally_company || company;
      if (tc) fd.append('tally_company', tc);
      const r = await apiClient.post('/api/purchase/zoho/guid-sync-file-apply/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data?.detail || 'Stamped.', { id: t });
      onDone?.();
      await run();   // refresh — stamped bills now show as already-linked
    } catch (e) { toast.error(e?.response?.data?.detail || 'Stamp failed.', { id: t }); setBusy(false); }
  };
  // One click: create the bills that are in Tally but missing from the ERP, as
  // source=TALLY. Likely-duplicates (an existing bill under a different invoice
  // spelling) are NEVER created — so this can't push Total Purchase over Tally.
  const applyMissing = async () => {
    if (!file) { toast.error('Upload the Day Book / Purchase Register first.'); return; }
    const n = missData?.summary?.to_create || 0;
    if (!n) { toast('No missing bills to create.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Create ${n} bill(s) from Tally?\n\nThey are added as source=TALLY (clearly not scanned), with Tally's amounts and voucher ID. Bills that look like an existing one under a different invoice number are skipped, so nothing is double-counted.`)) return;
    setBusy(true);
    const t = toast.loading('Creating bills from Tally…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (from) fd.append('from', from);
      if (to) fd.append('to', to);
      const tc = missData?.tally_company || company;
      if (tc) fd.append('tally_company', tc);
      const r = await apiClient.post('/api/purchase/zoho/missing-bills-file-apply/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data?.detail || 'Created.', { id: t });
      onDone?.();
      await run();   // refresh — the created bills now exist and drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Create failed.', { id: t }); setBusy(false); }
  };
  // One click: set each bill's spend category from its Tally ledger (splits mixed
  // vendors per-bill). Only the category changes — no amounts. Hand-set (manual)
  // categories are kept.
  const applyClassify = async () => {
    if (!file) { toast.error('Upload the Day Book / Purchase Register first.'); return; }
    const n = clsData?.summary?.to_change || 0;
    if (!n) { toast('No categories to set.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Set the category of ${n} bill(s) from their Tally ledger?\n\nEach bill gets Packing / RM / Freight / Expenses / Machinery from its own voucher — so mixed vendors split correctly. Only the category changes; no amounts. Manual tags are kept.`)) return;
    setBusy(true);
    const t = toast.loading('Classifying from Tally ledger…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (from) fd.append('from', from);
      if (to) fd.append('to', to);
      const tc = clsData?.tally_company || company;
      if (tc) fd.append('tally_company', tc);
      const r = await apiClient.post('/api/purchase/zoho/classify-ledger-file-apply/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data?.detail || 'Classified.', { id: t });
      onDone?.();
      await run();   // refresh — the classified bills now agree and drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Classify failed.', { id: t }); setBusy(false); }
  };
  // One click: cancel the ERP bills that no Tally voucher backs (over-adds / twins).
  // status-only, reversible; keeps one bill per Tally voucher.
  const applyExtras = async () => {
    if (!file) { toast.error('Upload the Day Book / Purchase Register first.'); return; }
    const n = extraData?.total_extra || 0;
    if (!n) { toast('No extra bills to cancel.', { icon: 'ℹ️' }); return; }
    if (!window.confirm(`Cancel ${n} extra bill(s) that no Tally voucher backs?\n\nThese are duplicates/over-adds the ERP has beyond Tally. Cancel is status-only and reversible; one bill per Tally voucher is kept. No amounts change on the kept bills.`)) return;
    setBusy(true);
    const t = toast.loading('Cancelling extra bills…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (from) fd.append('from', from);
      if (to) fd.append('to', to);
      const tc = extraData?.tally_company || company;
      if (tc) fd.append('tally_company', tc);
      if (data?.company_id) fd.append('company', data.company_id);
      const r = await apiClient.post('/api/purchase/zoho/extra-bills-file-apply/', fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      toast.success(r.data?.detail || 'Cancelled.', { id: t });
      onDone?.();
      await run();   // refresh — cancelled extras drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Cancel failed.', { id: t }); setBusy(false); }
  };
  const createFromTally = async () => {
    const items = tonly.filter((t) => sel[t.key]).map((t) => ({ ...t }));
    if (!items.length) { toast('Select a bill first.', { icon: 'ℹ️' }); return; }
    const decisions = [
      ...Object.entries(vmap).filter(([, d]) => d?.action)
        .map(([name, d]) => ({ name, kind: 'vendor', action: d.action, target_id: d.id, company_id: data?.company_id })),
      ...Object.entries(pmap).filter(([, d]) => d?.action && d.action !== 'create')
        .map(([name, d]) => ({ name, kind: 'product', action: d.action, target_id: d.id, company_id: data?.company_id })),
    ];
    setBusy(true);
    const t = toast.loading(`Creating ${items.length} bill(s) from Tally…`);
    try {
      if (decisions.length) {
        await apiClient.post('/api/purchase/zoho/import/', { action: 'resolve', decisions }, { timeout: 600000 });
      }
      // OFFLINE create — dedicated file endpoint, never touches the Tally gateway
      // (so EDU can't crash). Bills come from the file data + your ERP masters.
      const r = await apiClient.post('/api/purchase/zoho/reconcile-file-create/',
        { items, tally_company: company || undefined }, { timeout: 600000 });
      toast.success(r.data?.detail || 'Created.', { id: t });
      try { localStorage.removeItem(picksKey); } catch { /* ignore */ }
      onDone?.();
      await run();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Create failed.', { id: t }); setBusy(false); }
  };
  return (
    <>
      <button onClick={() => { setOpen(true); setData(null); }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
        <FileUp size={15} /> {label || 'Reconcile from File'}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">Reconcile from File</h3>
              <button onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-700"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Same as Reconcile with Tally, but reads Tally from an uploaded <b>Purchase Register</b> XML (Tally → Purchase Register → Alt+E → XML) — complete and never truncated on EDU. Bills <b>in Tally but not in Zoho</b> can be created; amount/date differences are yours to choose.</p>
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <label className="block text-xs font-medium text-slate-600 mb-1">Purchase Register XML file</label>
              <input type="file" accept=".xml" onChange={(e) => { setFile(e.target.files?.[0] || null); setData(null); }}
                className="w-full text-sm file:mr-2 file:rounded file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-white file:text-xs" />
              {company && <p className="text-[11px] text-slate-500 mt-1">Company: <b>{company}</b> (auto-detected from the file)</p>}
              <label className="block text-xs font-medium text-slate-600 mb-1 mt-3">Tally Master / Ledger XML <span className="font-normal text-slate-400">(optional — links vendors to Tally by GSTIN)</span></label>
              <input type="file" accept=".xml" onChange={(e) => { setMasterFile(e.target.files?.[0] || null); setLinkData(null); }}
                className="w-full text-sm file:mr-2 file:rounded file:border-0 file:bg-slate-600 file:px-3 file:py-1.5 file:text-white file:text-xs" />
              <label className="block text-xs font-medium text-slate-600 mb-1 mt-3">Tally Voucher Types XML <span className="font-normal text-slate-400">(optional — teaches the real purchase types)</span></label>
              <input type="file" accept=".xml" onChange={(e) => { setVtypeFile(e.target.files?.[0] || null); setVtypeData(null); }}
                className="w-full text-sm file:mr-2 file:rounded file:border-0 file:bg-slate-500 file:px-3 file:py-1.5 file:text-white file:text-xs" />
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">From date</label>
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">To date</label>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[11px] text-slate-400">Export the <b>Purchase Register</b> (not the Day Book) for the range, then upload it here.</span>
                <button onClick={run} disabled={busy || (!file && !masterFile && !vtypeFile)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Scale size={14} />} Check from File
                </button>
              </div>
              <div className="mt-2 pt-2 border-t border-slate-200 flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-400">Or categorise the suppliers Tally left ungrouped — no file needed.</span>
                <button onClick={() => loadTagVendors()} disabled={busy}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  🏷️ Tag unclassified vendors
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-400">Or find bills entered twice (same vendor + invoice) — no file needed.</span>
                <button onClick={() => loadDuplicates()} disabled={busy}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  🔎 Find duplicate bills
                </button>
              </div>
            </div>
            {busy && <div className="py-10 text-center text-slate-500"><Loader2 className="animate-spin inline mr-2" size={18} /> Comparing the file against your Zoho bills…</div>}
            {!busy && data && !data.tally_available && (
              <div className="py-8 text-center text-amber-600 text-sm">
                Could not read the file.
                {data.detail && <div className="mt-2 text-[11px] text-slate-500 break-words">Details: {data.detail}</div>}
              </div>
            )}
            {!busy && ((data && data.tally_available && (ms.length > 0 || dms.length > 0 || tonly.length > 0 || nSplit > 0)) || linkData || tagData || guidData || missData || clsData || extraData || dupData || vtypeData) && (
              <div className="flex flex-wrap gap-0.5 mb-3 bg-slate-100 rounded-lg p-0.5">
                {data && data.tally_available && (<>
                  <button type="button" onClick={() => setTab('missing')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'missing' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    In Tally, not in Zoho ({tonly.length})
                  </button>
                  <button type="button" onClick={() => setTab('diff')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'diff' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    Amount differences ({ms.length})
                  </button>
                  <button type="button" onClick={() => setTab('date')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'date' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    Date differences ({dms.length})
                  </button>
                  <button type="button" onClick={() => setTab('split')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'split' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    Ex-GST/GST split ({nSplit})
                  </button>
                  {guidData && (
                    <button type="button" onClick={() => setTab('guid')}
                      className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'guid' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                      Stamp Tally ID ({nGuid})
                    </button>
                  )}
                  {missData && (
                    <button type="button" onClick={() => setTab('missing2')}
                      className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'missing2' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                      Add from Tally ({nMiss})
                    </button>
                  )}
                  {clsData && (
                    <button type="button" onClick={() => setTab('classify')}
                      className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'classify' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                      Classify ({nCls})
                    </button>
                  )}
                  {extraData && (
                    <button type="button" onClick={() => setTab('extra')}
                      className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'extra' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                      Extra vs Tally ({nExtra})
                    </button>
                  )}
                </>)}
                {linkData && (
                  <button type="button" onClick={() => setTab('vendors')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'vendors' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    Vendors → Tally ({linkData.changed || 0})
                  </button>
                )}
                {tagData && (
                  <button type="button" onClick={() => setTab('tag')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'tag' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    Tag vendors ({tagData.total_vendors ?? tagVendors.length})
                  </button>
                )}
                {dupData && (
                  <button type="button" onClick={() => setTab('dupes')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'dupes' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    Duplicates ({dupData.total_extra_bills ?? nDup})
                  </button>
                )}
                {vtypeData && (
                  <button type="button" onClick={() => setTab('vtypes')}
                    className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'vtypes' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                    Purchase types ({vtypeData.count ?? nVtype})
                  </button>
                )}
              </div>
            )}
            {!busy && tab === 'vendors' && linkData && (
              linkData.ok === false ? (
                <div className="py-4 text-center text-amber-600 text-sm">Could not link vendors.
                  {linkData.detail && <div className="mt-1 text-[11px] text-slate-500 break-words">{linkData.detail}</div>}
                </div>
              ) : (
                <>
                  <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-emerald-800">
                      {linkData.applied ? 'Linked' : 'Would link'} <b>{linkData.changed || 0}</b> vendor(s) to Tally —
                      {' '}{linkData.by_gstin || 0} by GSTIN, {linkData.by_name || 0} by name, {linkData.unmatched || 0} unmatched.
                    </span>
                    {!linkData.applied && (
                      <button type="button" onClick={applyLinks} disabled={busy}
                        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                        ⚡ Link all to Tally
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Vendor ledgers in Tally</div><div className="font-semibold text-slate-800">{linkData.creditor_ledgers ?? '—'}</div></div>
                    <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">ERP vendors examined</div><div className="font-semibold text-slate-800">{linkData.vendors ?? '—'}</div></div>
                    <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Matched by GSTIN</div><div className="font-semibold text-emerald-700">{linkData.by_gstin ?? '—'}</div></div>
                    <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Matched by name</div><div className="font-semibold text-emerald-700">{linkData.by_name ?? '—'}</div></div>
                    <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Unmatched</div><div className="font-semibold text-amber-700">{linkData.unmatched ?? '—'}</div></div>
                    <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Kept manual</div><div className="font-semibold text-slate-800">{linkData.kept_manual ?? '—'}</div></div>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-2">Links only the vendor→Tally reference (by GSTIN, then exact name). No bills touched. Reversible.</p>
                </>
              )
            )}
            {!busy && tab === 'vtypes' && vtypeData && (
              vtypeData.ok === false ? (
                <div className="py-4 text-center text-amber-600 text-sm">Could not read voucher types.
                  {vtypeData.detail && <div className="mt-1 text-[11px] text-slate-500 break-words">{vtypeData.detail}</div>}
                </div>
              ) : (
                <>
                  <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-emerald-800">
                      {vtypeData.applied ? 'Saved' : 'Found'} <b>{nVtype}</b> real purchase voucher type(s) for <b>{vtypeData.company_name}</b>. The ERP will decide "is this a purchase?" from Tally's class, not the word.
                    </span>
                    {!vtypeData.applied && (
                      <button type="button" onClick={applyVtypes} disabled={busy || nVtype === 0}
                        className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                        ✅ Save purchase types
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {vtypes.map((t) => (
                      <span key={t} className="text-[11px] font-semibold rounded px-2 py-0.5 bg-slate-100 text-slate-700 border border-slate-200">{t}</span>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-2">From a Voucher Type master (class = Purchase) or a Purchase Vouchers report (all types in it are purchases). Saving replaces the set for this company. Reversible — re-import any time. If none is saved, the ERP falls back to matching the word "purchase".</p>
                </>
              )
            )}
            {!busy && tab === 'tag' && tagData && (
              tagData.ok === false ? (
                <div className="py-4 text-center text-amber-600 text-sm">Could not load vendors.
                  {tagData.detail && <div className="mt-1 text-[11px] text-slate-500 break-words">{tagData.detail}</div>}
                </div>
              ) : tagData.need_company ? (
                <div className="py-3">
                  <p className="text-sm text-slate-600 mb-2">Which company do you want to tag?</p>
                  <div className="flex flex-wrap gap-2">
                    {(tagData.companies || []).map((c) => (
                      <button key={c.code} type="button" onClick={() => loadTagVendors(c.code)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-indigo-50">
                        {c.name} <span className="text-slate-400">({c.code})</span>
                      </button>
                    ))}
                    {(tagData.companies || []).length === 0 && (
                      <span className="text-sm text-emerald-700">✓ Nothing unclassified — every purchase bill has a category.</span>
                    )}
                  </div>
                </div>
              ) : tagVendors.length === 0 ? (
                <div className="py-5 text-center text-emerald-700 text-sm">✓ No unclassified vendors for <b>{tagData.company_name}</b> — every purchase bill has a category.</div>
              ) : (
                <>
                  <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-emerald-800">
                      <b>{tagData.total_vendors}</b> vendor(s) · {tagData.total_bills} bill(s) · {fmtINRfull(Number(tagData.total_value))} still unclassified for <b>{tagData.company_name}</b>. Pick a category, then tag.
                    </span>
                    <button type="button" onClick={applyTags} disabled={busy || nTag === 0}
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                      🏷️ Tag {nTag} vendor(s)
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mb-2">Branch transfers (DC/…) are excluded — they aren't purchases. Tagging is manual: a re-classify won't override it. No amounts change.</p>
                  <div className="space-y-1.5">
                    {tagVendors.map((v) => {
                      const pick = tagPicks[v.vendor_id] || '';
                      return (
                        <div key={v.vendor_id} className={`rounded-lg border p-2 flex items-center gap-2 ${pick ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'}`}>
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-semibold text-slate-800 truncate">{v.vendor_name}</div>
                            <div className="text-[10px] text-slate-500">{v.bills} bill(s) · {fmtINRfull(Number(v.value))}{v.suggested ? ` · hint: ${v.suggested}` : ''}</div>
                          </div>
                          <select value={pick}
                            onChange={(e) => setTagPicks((p) => ({ ...p, [v.vendor_id]: e.target.value }))}
                            className={`shrink-0 border rounded-lg px-2 py-1.5 text-xs ${pick ? 'border-emerald-400 text-emerald-800 bg-white' : 'border-slate-300 text-slate-600'}`}>
                            <option value="">— skip —</option>
                            {CATS.map(([code, lbl]) => <option key={code} value={code}>{lbl}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </>
              )
            )}
            {!busy && tab === 'dupes' && dupData && (
              dupData.ok === false ? (
                <div className="py-4 text-center text-amber-600 text-sm">Could not scan for duplicates.
                  {dupData.detail && <div className="mt-1 text-[11px] text-slate-500 break-words">{dupData.detail}</div>}
                </div>
              ) : dupData.need_company ? (
                <div className="py-3">
                  <p className="text-sm text-slate-600 mb-2">Which company to scan for duplicates?</p>
                  <div className="flex flex-wrap gap-2">
                    {(dupData.companies || []).map((c) => (
                      <button key={c.code} type="button" onClick={() => loadDuplicates(c.code)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-indigo-50">
                        {c.name} <span className="text-slate-400">({c.code})</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : dupGroups.length === 0 ? (
                <div className="py-5 text-center text-emerald-700 text-sm">✓ No duplicate bills found for <b>{dupData.company_name}</b> — every vendor+invoice is unique.</div>
              ) : (
                <>
                  <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-rose-900">
                      <b>{dupData.total_groups}</b> vendor+invoice(s) entered more than once · <b>{nDup}</b> extra bill(s) worth {fmtINRfull(Number(dupData.total_extra_value))} for <b>{dupData.company_name}</b>. The best copy is kept; extras cancelled.
                    </span>
                    <button type="button" onClick={cancelDuplicates} disabled={busy || nDup === 0}
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
                      🗑 Cancel {nDup} duplicate(s)
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mb-2">Match = same vendor + same invoice number. Keeper = the Tally-linked / oldest copy. Cancel is status-only (reversible). No amounts change on the kept bill.</p>
                  <div className="space-y-2">
                    {dupGroups.slice(0, 200).map((g, gi) => (
                      <div key={gi} className="rounded-lg border border-slate-200 p-2 text-[11px]">
                        <div className="flex items-center gap-1.5 flex-wrap mb-1">
                          <span className="font-semibold text-slate-800">{g.vendor_name || '—'}</span>
                          <span className="text-slate-400">inv {g.invoice_no || '—'}</span>
                          <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-slate-200 text-slate-600">{g.count} copies</span>
                          <span className="ml-auto text-rose-600 tabular-nums">extra {fmtINRfull(Number(g.extra_value))}</span>
                        </div>
                        <div className="flex items-center gap-2 text-emerald-700">
                          <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-emerald-100">KEEP</span>
                          <span className="text-slate-700">{g.keep.bill_no}</span>
                          <span className="text-slate-500">{fmtINRfull(Number(g.keep.amount))}</span>
                          <span className="text-slate-400">{g.keep.date || '—'} · {g.keep.source || '—'}{g.keep.has_guid ? ' · linked' : ''}</span>
                        </div>
                        {g.cancel.map((c) => (
                          <div key={c.bill_id} className="flex items-center gap-2 text-rose-600">
                            <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-rose-100">CANCEL</span>
                            <span className="text-slate-700">{c.bill_no}</span>
                            <span className="text-slate-500">{fmtINRfull(Number(c.amount))}</span>
                            <span className="text-slate-400">{c.date || '—'} · {c.source || '—'}{c.has_guid ? ' · linked' : ''}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {dupData.total_groups > 200 && <div className="text-[10px] text-slate-400">…and {dupData.total_groups - 200} more group(s) (Cancel covers all).</div>}
                  </div>
                </>
              )
            )}
            {!busy && data && data.tally_available && (ms.length > 0 || dms.length > 0) && (
              <div className="mb-3 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                <span className="text-[11px] text-emerald-800">Make the ERP match Tally in one click — sets all {ms.length} amount + {dms.length} date difference(s) to Tally (overrides Zoho on those bills).</span>
                <button type="button" onClick={applyAllToTally} disabled={busy}
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                  ⚡ Set ALL to Tally
                </button>
              </div>
            )}
            {!busy && data && data.tally_available && tab === 'missing' && tonly.length === 0 && (
              <div className="py-4 sm:py-5 text-center text-slate-500 text-sm">No Tally-only bills — everything in the file is already in Zoho.</div>
            )}
            {!busy && tab === 'missing' && tonly.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor / invoice…"
                    className="flex-1 min-w-[140px] border border-slate-300 rounded px-2 py-1 text-xs" />
                  {coOptions.length > 0 && (
                    <select value={coFilter} onChange={(e) => setCoFilter(e.target.value)}
                      className="border border-slate-300 rounded px-2 py-1 text-xs">
                      <option value="">All Companies</option>
                      {coOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                  <button type="button" onClick={() => setAllShown(true)}
                    className="text-[11px] rounded px-2 py-1 border bg-white text-slate-600 border-slate-200 hover:bg-emerald-50">Select all shown</button>
                  <button type="button" onClick={() => setSel({})}
                    className="text-[11px] rounded px-2 py-1 border bg-white text-slate-500 border-slate-200 hover:bg-slate-50">Clear</button>
                </div>
                <div className="text-[10px] text-slate-400 mb-1">
                  Showing {Math.min(shown.length, 200)} of {shown.length}{qn ? ` (filtered from ${tonly.length})` : ''}
                  {shown.length > 200 ? ' — refine the search to see the rest; “Set all shown” still applies to all matches.' : ''}
                </div>
                <div className="space-y-2">
                  {shown.slice(0, 200).map((t) => {
                    const tag = sel[t.key];
                    return (
                      <div key={t.key} className={`rounded-lg border p-2 text-[11px] ${tag ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-emerald-700 mb-0.5 flex items-center gap-1.5 flex-wrap">Tally
                              {t.company_label && <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-slate-700 text-white">{t.company_label}</span>}
                              {tag && <span className="text-[10px] font-semibold rounded px-1 py-0.5 bg-emerald-600 text-white">✓ Selected</span>}</div>
                            <div className="text-slate-500">Invoice No: <span className="text-slate-800">{t.invoice_no}</span></div>
                            <div className="text-slate-500 flex items-center gap-1.5 flex-wrap">Vendor: <span className="text-slate-800">{t.vendor_name || '—'}</span>
                              {t.vendor_matched
                                ? <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-emerald-100 text-emerald-700">✓ in ERP</span>
                                : <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-amber-100 text-amber-700">new vendor</span>}
                            </div>
                            {!t.vendor_matched && (
                              <div className="mt-1 flex items-center gap-1.5">
                                <span className="text-[10px] text-slate-400 shrink-0">Map vendor:</span>
                                <MapControl dec={vmap[t.vendor_name]} onSet={(obj) => setVmap((p) => ({ ...p, [t.vendor_name]: obj }))}
                                  kind="vendor" options={t.vendor_options || []} companyId={data?.company_id} companyName={data?.company_name} />
                              </div>
                            )}
                            <div className="text-slate-500 mt-0.5">Date: <span className="text-slate-800">{t.date || '—'}</span></div>
                            <div className="text-slate-500">Amount: <span className="font-semibold text-slate-800">{fmtINRfull(t.amount)}</span></div>
                            {t.lines?.length > 0 && (
                              <div className="mt-1 space-y-1">
                                {t.lines.map((l, li) => (
                                  <div key={li} className="text-[11px]">
                                    <span className="text-slate-400">Product:</span> <span className="text-slate-700">{l.name}</span>
                                    {l.kind === 'item' && (l.product_matched
                                      ? <span className="ml-1 text-[9px] font-semibold rounded px-1 py-0.5 bg-emerald-100 text-emerald-700">✓ in ERP</span>
                                      : <span className="ml-1 text-[9px] font-semibold rounded px-1 py-0.5 bg-amber-100 text-amber-700">new</span>)}
                                    {l.kind === 'item' && !l.product_matched && (
                                      <div className="mt-0.5 flex items-center gap-1.5">
                                        <span className="text-[10px] text-slate-400 shrink-0">Map product:</span>
                                        <MapControl dec={pmap[l.name]} onSet={(obj) => setPmap((p) => ({ ...p, [l.name]: obj }))}
                                          kind="product" options={l.product_options || []} companyId={data?.company_id} companyName={data?.company_name} />
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0">
                            <button type="button"
                              onClick={() => setSel((p) => ({ ...p, [t.key]: p[t.key] ? undefined : true }))}
                              className={`text-[11px] rounded px-3 py-1 border ${tag ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{tag ? '✓ Selected' : 'Select'}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {!busy && tab === 'diff' && ms.length === 0 && data?.tally_available && (
              <div className="py-4 sm:py-5 text-center text-emerald-700 text-sm">✓ {(data.matched || 0) > 0 ? `All ${data.matched} matched bill(s) agree with Tally.` : 'No amount differences.'}</div>
            )}
            {!busy && tab === 'diff' && ms.length > 0 && (
              <>
                <p className="text-sm font-semibold text-amber-800 mb-2"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{ms.length} amount difference(s) — pick which amount the bill keeps (products always stay from Zoho):</p>
                <div className="space-y-2">
                  {ms.map((m) => {
                    const k = keep[m.zoho_id] || 'zoho';
                    return (
                      <div key={m.zoho_id} className="rounded-lg border border-slate-200 p-2">
                        {m.bill_id && (m.photos || []).length > 0 && (
                          <div className="mb-1 flex items-center gap-1.5 flex-wrap">
                            {(m.photos || []).map((ph) => (
                              <button key={ph.kind} type="button" onClick={() => openPhoto(m.bill_id, ph.kind)}
                                className="text-[10px] font-semibold rounded px-1.5 py-0.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50"> {ph.label}</button>
                            ))}
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-3 text-[11px]">
                          <div className={`rounded p-1.5 ${k === 'zoho' ? 'ring-2 ring-indigo-400 bg-indigo-50/40' : ''}`}>
                            <div className="font-semibold text-indigo-700 mb-0.5">Zoho</div>
                            <div className="text-slate-500">Bill No: <span className="text-slate-800">{m.zoho.bill_no}</span></div>
                            <div className="text-slate-500">Invoice No: <span className="text-slate-800">{m.zoho.invoice_no || '—'}</span></div>
                            <div className="text-slate-500">Amount: <span className="font-semibold text-slate-800">{fmtINRfull(m.zoho.amount)}</span></div>
                          </div>
                          <div className={`rounded p-1.5 ${k === 'tally' ? 'ring-2 ring-emerald-400 bg-emerald-50/40' : ''}`}>
                            <div className="font-semibold text-emerald-700 mb-0.5">Tally</div>
                            <div className="text-slate-500">Invoice No: <span className="text-slate-800">{m.tally.invoice_no}</span></div>
                            <div className="text-slate-500">Date: <span className="text-slate-800">{m.tally.date || '—'}</span></div>
                            <div className="text-slate-500">Amount: <span className="font-semibold text-slate-800">{fmtINRfull(m.tally.amount)}</span></div>
                          </div>
                        </div>
                        <div className="flex gap-1.5 mt-1.5">
                          {[['zoho', 'Keep Zoho amount'], ['tally', 'Use Tally amount']].map(([v, l]) => (
                            <button key={v} type="button" onClick={() => setKeep((p) => ({ ...p, [m.zoho_id]: v }))}
                              className={`text-[11px] rounded px-2 py-1 border ${k === v ? (v === 'tally' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-indigo-600 text-white border-indigo-600') : 'bg-white text-slate-600 border-slate-200'}`}>{l}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {!busy && tab === 'date' && dms.length === 0 && data?.tally_available && (
              <div className="py-4 sm:py-5 text-center text-emerald-700 text-sm">✓ {(data.matched || 0) > 0 ? `All ${data.matched} matched bill(s) have the same date as Tally.` : 'No date differences.'}</div>
            )}
            {!busy && tab === 'date' && dms.length > 0 && (
              <>
                <p className="text-sm font-semibold text-amber-800 mb-2"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{dms.length} date difference(s) — pick which date the bill keeps:</p>
                <div className="space-y-2">
                  {dms.map((m) => {
                    const k = keepDate[m.zoho_id] || 'zoho';
                    return (
                      <div key={m.zoho_id} className="rounded-lg border border-slate-200 p-2">
                        <div className="text-[11px] text-slate-500 mb-1 flex items-center gap-1.5 flex-wrap">
                          Bill: <span className="text-slate-800">{m.bill_no}</span> · Invoice: <span className="text-slate-800">{m.invoice_no || '—'}</span> · <span className="text-slate-800">{m.vendor_name || '—'}</span>
                          {m.bill_id && (m.photos || []).map((ph) => (
                            <button key={ph.kind} type="button" onClick={() => openPhoto(m.bill_id, ph.kind)}
                              className="text-[10px] font-semibold rounded px-1.5 py-0.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50"> {ph.label}</button>
                          ))}
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-[11px]">
                          <div className={`rounded p-1.5 ${k === 'zoho' ? 'ring-2 ring-indigo-400 bg-indigo-50/40' : ''}`}>
                            <div className="font-semibold text-indigo-700 mb-0.5">Zoho date</div>
                            <div className="font-semibold text-slate-800">{m.zoho_date}</div>
                          </div>
                          <div className={`rounded p-1.5 ${k === 'tally' ? 'ring-2 ring-emerald-400 bg-emerald-50/40' : ''}`}>
                            <div className="font-semibold text-emerald-700 mb-0.5">Tally date</div>
                            <div className="font-semibold text-slate-800">{m.tally_date}</div>
                          </div>
                        </div>
                        <div className="flex gap-1.5 mt-1.5">
                          {[['zoho', 'Keep Zoho date'], ['tally', 'Use Tally date']].map(([v, l]) => (
                            <button key={v} type="button" onClick={() => setKeepDate((p) => ({ ...p, [m.zoho_id]: v }))}
                              className={`text-[11px] rounded px-2 py-1 border ${k === v ? (v === 'tally' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-indigo-600 text-white border-indigo-600') : 'bg-white text-slate-600 border-slate-200'}`}>{l}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {!busy && tab === 'split' && (
              nSplit === 0 ? (
                <div className="py-4 sm:py-5 text-center text-emerald-700 text-sm">
                  ✓ {align ? "All matched bills' Ex-GST/GST split agrees with Tally." : 'Upload a file and Check to compare the split.'}
                </div>
              ) : (
                <>
                  <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-emerald-800">
                      {nSplit} bill(s) where the Ex-GST↔GST <b>split</b> differs from Tally (the total already ties). Set them all to Tally's split.
                    </span>
                    <button type="button" onClick={applySplits} disabled={busy}
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                      ⚡ Set ALL splits to Tally
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mb-2">Only the header split changes — product lines and the total are untouched. Reversible (logged in each bill's notes).</p>
                  <div className="space-y-2">
                    {adiffs.slice(0, 200).map((x) => (
                      <div key={x.bill_id} className="rounded-lg border border-slate-200 p-2 text-[11px]">
                        <div className="flex items-center gap-1.5 flex-wrap mb-1">
                          <span className="font-semibold text-slate-800">{x.vendor_name || '—'}</span>
                          <span className="text-slate-400">inv {x.invoice_no || '—'}</span>
                          <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-slate-200 text-slate-600">{x.source}</span>
                          {x.date && <span className="text-slate-400">{x.date}</span>}
                        </div>
                        <div className="space-y-0.5">
                          {x.fields.map((fld) => (
                            <div key={fld.key} className="flex items-center gap-2">
                              <span className="text-slate-500 w-16 shrink-0">{fld.label}</span>
                              <span className="text-slate-600 tabular-nums">{fmtINRfull(fld.erp)}</span>
                              <span className="text-slate-300">→</span>
                              <span className="font-semibold text-emerald-700 tabular-nums">{fmtINRfull(fld.tally)}</span>
                              <span className={`ml-auto tabular-nums ${Number(fld.delta) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>({fmtINRfull(fld.delta)})</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {nSplit > 200 && <div className="text-[10px] text-slate-400">…and {nSplit - 200} more (Apply covers all).</div>}
                  </div>
                </>
              )
            )}
            {!busy && tab === 'guid' && guidData && (
              <>
                <div className="mb-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-indigo-900">
                    Give each ERP bill Tally's own voucher ID, so ERP and Tally are locked together (no more guessing, no duplicates).
                    {' '}<b>{gsum?.to_stamp || 0}</b> bill(s) would get an ID · {gsum?.already || 0} already linked.
                  </span>
                  <button type="button" onClick={applyGuidSync} disabled={busy || nGuid === 0}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                    🔗 Stamp {nGuid} Tally ID(s)
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px] mb-2">
                  <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Would stamp</div><div className="font-semibold text-indigo-700">{gsum?.to_stamp ?? '—'}</div></div>
                  <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Already linked</div><div className="font-semibold text-emerald-700">{gsum?.already ?? '—'}</div></div>
                  <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Conflicts</div><div className="font-semibold text-amber-700">{gsum?.conflicts ?? '—'}</div></div>
                  <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Matched, no Tally ID</div><div className="font-semibold text-slate-700">{gsum?.no_guid ?? '—'}</div></div>
                  <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">Duplicate ERP bills</div><div className="font-semibold text-slate-700">{gsum?.dup_bills ?? '—'}</div></div>
                  <div className="rounded border border-slate-200 p-2"><div className="text-slate-400">In Tally, no ERP bill</div><div className="font-semibold text-slate-700">{gsum?.tally_only ?? '—'}</div></div>
                </div>
                {(gsum?.tally_only || 0) > 0 && (
                  <p className="text-[10px] text-slate-400 mb-1">{gsum.tally_only} Tally voucher(s) have no ERP bill — create those from the <b>“In Tally, not in Zoho”</b> tab. This tab only links bills that already exist.</p>
                )}
                {(gsum?.no_guid || 0) > 0 && (
                  <p className="text-[10px] text-amber-600 mb-1">{gsum.no_guid} matched bill(s) have no Tally ID in this file — export the <b>Day Book</b> (it always carries the voucher GUID) rather than a summary report.</p>
                )}
                {gclashRows.length > 0 && (
                  <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                    <p className="text-[11px] font-semibold text-amber-800 mb-1">{gclashRows.length} bill(s) already carry a DIFFERENT Tally ID — left untouched (check these):</p>
                    <div className="space-y-1">
                      {gclashRows.slice(0, 50).map((x) => (
                        <div key={x.bill_id} className="text-[10px] text-slate-600 flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-slate-800">{x.vendor_name || '—'}</span>
                          <span className="text-slate-400">inv {x.invoice_no || '—'}</span>
                          <span className="text-slate-400" title={`has ${x.current_guid} · Tally ${x.guid}`}>· has …{x.current_guid?.slice(-8)} ≠ Tally …{x.guid?.slice(-8)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {nGuid === 0 ? (
                  <div className="py-4 text-center text-emerald-700 text-sm">✓ Every matched bill already carries its Tally ID.</div>
                ) : (
                  <>
                    <p className="text-[10px] text-slate-400 mb-2">Only the Tally-ID link is written — no amounts, no products. Match is by vendor + invoice number (same as the split tab). Reversible (logged in each bill's notes).</p>
                    <div className="space-y-1.5">
                      {gstampRows.slice(0, 200).map((x) => (
                        <div key={x.bill_id} className="rounded-lg border border-slate-200 p-2 text-[11px] flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-slate-800 truncate">{x.vendor_name || '—'}</div>
                            <div className="text-slate-500">inv {x.invoice_no || '—'} · voucher {x.tally_number || '—'}{x.tally_vtype ? ` (${x.tally_vtype})` : ''}{x.date ? ` · ${x.date}` : ''}</div>
                          </div>
                          <span title={x.guid} className="shrink-0 text-[9px] font-semibold rounded px-1.5 py-0.5 bg-indigo-100 text-indigo-700">ID …{x.guid?.slice(-8)}</span>
                        </div>
                      ))}
                      {nGuid > 200 && <div className="text-[10px] text-slate-400">…and {nGuid - 200} more (Stamp covers all).</div>}
                    </div>
                  </>
                )}
              </>
            )}
            {!busy && tab === 'missing2' && missData && (
              <>
                <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-700">
                    Purchases that are in Tally but missing from the ERP. <b>{msum?.to_create || 0}</b> would be created (as <b>Tally</b> bills, not scanned) · {msum?.likely_dups || 0} skipped as likely duplicates.
                  </span>
                  <button type="button" onClick={applyMissing} disabled={busy || nMiss === 0}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-50">
                    ＋ Create {nMiss} Tally bill(s)
                  </button>
                </div>
                <p className="text-[10px] text-slate-400 mb-2">Created with Tally's amounts + voucher ID, tagged <b>source=Tally</b>. A voucher that matches an existing bill (same vendor, ~date, ~total) under a different invoice number is treated as a <b>likely duplicate</b> and never created — so this can't push Total Purchase above Tally.</p>
                {missDupRows.length > 0 && (
                  <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                    <p className="text-[11px] font-semibold text-amber-800 mb-1">{missDupRows.length} skipped — likely already in the ERP (not created):</p>
                    <div className="space-y-1">
                      {missDupRows.slice(0, 50).map((x) => (
                        <div key={x.guid} className="text-[10px] text-slate-600 flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-slate-800">{x.vendor_name || '—'}</span>
                          <span className="text-slate-400">inv {x.invoice_no || '—'} · {fmtINRfull(Number(x.gross))}</span>
                          <span className="text-slate-400">≈ existing {x.dup_bill_no}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {nMiss === 0 ? (
                  <div className="py-4 text-center text-emerald-700 text-sm">✓ Nothing to create — every Tally purchase already has an ERP bill.</div>
                ) : (
                  <div className="space-y-1.5">
                    {missCreateRows.slice(0, 200).map((x) => (
                      <div key={x.guid} className="rounded-lg border border-slate-200 p-2 text-[11px] flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-slate-800 truncate">{x.vendor_name || '—'}</div>
                          <div className="text-slate-500">inv {x.invoice_no || '—'} · voucher {x.tally_number || '—'}{x.tally_vtype ? ` (${x.tally_vtype})` : ''}{x.date ? ` · ${x.date}` : ''}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="font-semibold text-slate-800 tabular-nums">{fmtINRfull(Number(x.gross))}</div>
                          <div className="text-[9px] text-slate-400">GST {fmtINRfull(Number(x.gst))}</div>
                        </div>
                      </div>
                    ))}
                    {nMiss > 200 && <div className="text-[10px] text-slate-400">…and {nMiss - 200} more (Create covers all).</div>}
                  </div>
                )}
              </>
            )}
            {!busy && tab === 'classify' && clsData && (
              <>
                <div className="mb-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-indigo-900">
                    Set each bill's category from its <b>Tally ledger</b> (Packing Material → Packing, Machinery Maintenance → Expenses, GST Purchase → RM…) — so mixed vendors split per-bill.
                    {' '}<b>{clsSum?.to_change || 0}</b> would change · {clsSum?.skipped_manual || 0} manual kept.
                  </span>
                  <button type="button" onClick={applyClassify} disabled={busy || nCls === 0}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                    🏷️ Classify {nCls} bill(s)
                  </button>
                </div>
                {clsSum?.by_category && Object.keys(clsSum.by_category).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {Object.entries(clsSum.by_category).map(([cat, n]) => (
                      <span key={cat} className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-slate-100 text-slate-700 border border-slate-200">{cat}: {n}</span>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 mb-2">Category comes from each voucher's own goods ledger — no guessing. Only the category changes; amounts untouched. A hand-set (manual) category is kept.</p>
                {nCls === 0 ? (
                  <div className="py-4 text-center text-emerald-700 text-sm">✓ Every matched bill already has the right category.</div>
                ) : (
                  <div className="space-y-1.5">
                    {clsRows.slice(0, 200).map((x) => (
                      <div key={x.bill_id} className="rounded-lg border border-slate-200 p-2 text-[11px] flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-slate-800 truncate">{x.vendor_name || '—'}</div>
                          <div className="text-slate-500">inv {x.invoice_no || '—'}{x.date ? ` · ${x.date}` : ''}{x.ledger ? ` · ${x.ledger}` : ''}</div>
                        </div>
                        <div className="shrink-0 flex items-center gap-1.5">
                          <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-slate-100 text-slate-500">{x.from_cat || '—'}</span>
                          <span className="text-slate-300">→</span>
                          <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-indigo-100 text-indigo-700">{x.to_cat}</span>
                        </div>
                      </div>
                    ))}
                    {nCls > 200 && <div className="text-[10px] text-slate-400">…and {nCls - 200} more (Classify covers all).</div>}
                  </div>
                )}
              </>
            )}
            {!busy && tab === 'extra' && extraData && (
              extraData.ok === false ? (
                <div className="py-4 text-center text-amber-600 text-sm">Could not compare.
                  {extraData.detail && <div className="mt-1 text-[11px] text-slate-500 break-words">{extraData.detail}</div>}
                </div>
              ) : nExtra === 0 ? (
                <div className="py-5 text-center text-emerald-700 text-sm">✓ No extra bills — every ERP bill is backed by a Tally voucher.</div>
              ) : (
                <>
                  <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-rose-900">
                      <b>{nExtra}</b> ERP bill(s) worth {fmtINRfull(Number(extraData.total_value))} have <b>no matching Tally voucher</b> — over-adds / cross-channel twins. Cancel to line the ERP up to Tally.
                    </span>
                    <button type="button" onClick={applyExtras} disabled={busy || nExtra === 0}
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
                      🗑 Cancel {nExtra} extra(s)
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 mb-2">Match = vendor + amount + date. Each Tally voucher backs one bill; the rest are extras. Cancel is status-only (reversible); one bill per voucher is kept. ⚠️ If a bill here is genuinely in Tally but the amount/date differs, leave it — cancel only the true twins.</p>
                  <div className="space-y-1.5">
                    {extraRows.slice(0, 200).map((x) => (
                      <div key={x.bill_id} className="rounded-lg border border-slate-200 p-2 text-[11px] flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-slate-800 truncate">{x.vendor_name || '—'}</div>
                          <div className="text-slate-500">{x.bill_no} · inv {x.invoice_no || '—'}{x.date ? ` · ${x.date}` : ''} · {x.source || '—'}{x.has_guid ? ' · linked' : ''}</div>
                        </div>
                        <div className="shrink-0 font-semibold text-slate-800 tabular-nums">{fmtINRfull(Number(x.amount))}</div>
                      </div>
                    ))}
                    {nExtra > 200 && <div className="text-[10px] text-slate-400">…and {nExtra - 200} more (Cancel covers all).</div>}
                  </div>
                </>
              )
            )}
            <div className="flex justify-between items-center mt-3">
              <span className="text-[11px] text-slate-400">
                {tab === 'missing' && tonly.length > 0 ? `${nCreate} selected to create · products from Tally voucher` : ''}
                {tab === 'diff' && ms.length > 0 ? `${nTally} set to Tally · products always kept from Zoho` : ''}
                {tab === 'date' && dms.length > 0 ? `${dms.filter((m) => keepDate[m.zoho_id] === 'tally').length} → Tally · ${dms.filter((m) => (keepDate[m.zoho_id] || 'zoho') === 'zoho').length} → keep Zoho` : ''}
                {tab === 'split' && nSplit > 0 ? `${nSplit} bill(s) · header split → Tally · total & products untouched` : ''}
                {tab === 'tag' && tagVendors.length > 0 ? `${nTag} of ${tagVendors.length} vendor(s) set · manual · no amounts change` : ''}
                {tab === 'guid' && nGuid > 0 ? `${nGuid} bill(s) → Tally ID · identity only · no amounts change` : ''}
                {tab === 'missing2' && nMiss > 0 ? `${nMiss} new · source=Tally · ${msum?.likely_dups || 0} likely-dupes skipped` : ''}
                {tab === 'dupes' && nDup > 0 ? `${nDup} extra bill(s) · keep best · cancel reversible` : ''}
                {tab === 'classify' && nCls > 0 ? `${nCls} bill(s) · category from Tally ledger · no amounts change` : ''}
                {tab === 'extra' && nExtra > 0 ? `${nExtra} extra bill(s) · no Tally voucher · cancel reversible` : ''}
                {tab === 'vtypes' && nVtype > 0 ? `${nVtype} real purchase type(s)${vtypeData?.applied ? ' · saved' : ''}` : ''}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Close</button>
                {tab === 'missing' && tonly.length > 0 && (
                  <button onClick={createFromTally} disabled={busy || nCreate === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Create ${nCreate} bill(s) from Tally`}
                  </button>
                )}
                {tab === 'diff' && ms.length > 0 && (
                  <button onClick={applyChosen} disabled={busy || nTally === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Apply Tally amount to ${nTally} bill(s)`}
                  </button>
                )}
                {tab === 'date' && dms.length > 0 && (
                  <button onClick={applyDates} disabled={busy || dms.length === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Apply to ${dms.length} bill(s)`}
                  </button>
                )}
                {tab === 'split' && nSplit > 0 && (
                  <button onClick={applySplits} disabled={busy}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Set ${nSplit} split(s) to Tally`}
                  </button>
                )}
                {tab === 'tag' && tagVendors.length > 0 && (
                  <button onClick={applyTags} disabled={busy || nTag === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Tag ${nTag} vendor(s)`}
                  </button>
                )}
                {tab === 'guid' && guidData && (
                  <button onClick={applyGuidSync} disabled={busy || nGuid === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Stamp ${nGuid} Tally ID(s)`}
                  </button>
                )}
                {tab === 'missing2' && missData && (
                  <button onClick={applyMissing} disabled={busy || nMiss === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Create ${nMiss} bill(s) from Tally`}
                  </button>
                )}
                {tab === 'dupes' && dupData && dupGroups.length > 0 && (
                  <button onClick={cancelDuplicates} disabled={busy || nDup === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Cancel ${nDup} duplicate(s)`}
                  </button>
                )}
                {tab === 'classify' && clsData && (
                  <button onClick={applyClassify} disabled={busy || nCls === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Classify ${nCls} bill(s)`}
                  </button>
                )}
                {tab === 'extra' && extraData && extraRows.length > 0 && (
                  <button onClick={applyExtras} disabled={busy || nExtra === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Cancel ${nExtra} extra(s)`}
                  </button>
                )}
                {tab === 'vtypes' && vtypeData && !vtypeData.applied && vtypeData.ok !== false && (
                  <button onClick={applyVtypes} disabled={busy || nVtype === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Save ${nVtype} purchase type(s)`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {photo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={closePhoto}>
          <div className="relative bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[92dvh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 sticky top-0 bg-white">
              <span className="text-sm font-semibold text-slate-700">Bill photo (from Zoho)</span>
              <div className="flex items-center gap-2">
                {photo.url && <a href={photo.url} download="bill-photo.jpg" className="text-xs text-indigo-600 hover:text-indigo-800">Download</a>}
                <button onClick={closePhoto} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close photo"><X size={18} /></button>
              </div>
            </div>
            <div className="p-3 min-h-[220px] flex items-center justify-center">
              {photo.loading && <div className="text-slate-500 text-sm">Loading photo…</div>}
              {photo.error && <div className="text-amber-600 text-sm">{photo.error}</div>}
              {photo.url && <img src={photo.url} alt="Bill photo" className="max-w-full max-h-[78dvh] object-contain" />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
