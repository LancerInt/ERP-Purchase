import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import toast from 'react-hot-toast';
import { Loader2, PieChart, ChevronRight } from 'lucide-react';
import './expense-proto.css';

/* The expense ledger values come from the Purchase side: the same endpoint the
   Purchase > By-Category "Expenses" drawer uses. We read the group that matches
   this page (DIRECT or INDIRECT) and render its sub-categories (heads) with the
   prototype's look. No mock data — every figure is live.

   Response shape (see purchase.category_views.PurchaseByCategoryView):
     expenses.groups[] = { key:'DIRECT'|'INDIRECT', label, value, tally,
                           subcategories:[{ sub, value, count, tally }] } */

const fmt = (n) => '₹' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-IN');
const fmtL = (n) => {
  const v = Number(n) || 0;
  return Math.abs(v) >= 1e5
    ? '₹' + (v / 1e5).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L'
    : fmt(v);
};

export default function ExpenseGroupView({ group }) {
  const navigate = useNavigate();
  const accent = group === 'DIRECT' ? 'dir' : 'ind';

  const { options: companyOptions } = useLookup('/api/companies/');
  const [companyId, setCompanyId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);   // group block expanded/collapsed
  const [gstMode, setGstMode] = useState('incl');   // 'incl' | 'excl' — billed basis

  // default to the first company once the lookup resolves
  useEffect(() => {
    if (!companyId && companyOptions.length) setCompanyId(companyOptions[0].value);
  }, [companyOptions, companyId]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setLoading(true);
    const params = { company: companyId };
    if (from) params.from = from;
    if (to) params.to = to;
    apiClient.get('/api/purchase/by-category/', { params })
      .then((res) => { if (!cancelled) setData(res.data || null); })
      .catch(() => { if (!cancelled) toast.error('Could not load expense data.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, from, to]);

  const grp = useMemo(() => {
    const groups = data?.expenses?.groups || [];
    return groups.find((g) => g.key === group) || null;
  }, [data, group]);

  // Headline = sum of the ERP expense BILLS in this group (not the Tally
  // snapshot). Billed flips between incl-GST (total_amount) and ex-GST (subtotal)
  // via the toggle; paid/outstanding come from the bills (amount_paid).
  const billedOf = (r) => Number(gstMode === 'incl' ? r.value_incl : r.value) || 0;
  const subs = (grp?.subcategories || []).slice().sort((a, b) => billedOf(b) - billedOf(a));
  const billed = grp ? billedOf(grp) : 0;
  const paid = grp ? (Number(grp.paid) || 0) : 0;
  const outstanding = grp ? (Number(grp.outstanding) || 0) : 0;
  const billCount = grp ? (Number(grp.count) || 0) : 0;
  const maxSub = subs.reduce((m, r) => Math.max(m, billedOf(r)), 0) || 1;
  const hasTally = !!data?.expenses?.has_tally;

  const openBills = (sub) => {
    const q = new URLSearchParams();
    if (companyId) q.set('company', companyId);
    q.set('expense_group', group);
    q.set('expense_subcategory', sub);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    navigate(`/purchase/bills?${q.toString()}`);
  };

  const groupLabel = group === 'DIRECT' ? 'Direct Expenses' : 'Indirect Expenses';

  return (
    <div className="xp-root">
      {/* filter bar */}
      <div className="xp-filterbar">
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="xp-lbl">Company</span>
          <select className="xp-input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            {companyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="xp-lbl">From</span>
          <input className="xp-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span className="xp-lbl">To</span>
          <input className="xp-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="xp-btn sm ghost" onClick={() => { setFrom(''); setTo(''); }}>All Time</button>
        {/* incl / excl GST toggle — drives the Billed figures */}
        <div className="xp-seg" style={{ marginLeft: 'auto' }}>
          {['incl', 'excl'].map((m) => (
            <button key={m} className={gstMode === m ? 'on' : ''} onClick={() => setGstMode(m)}>
              {m === 'incl' ? 'Incl GST' : 'Excl GST'}
            </button>
          ))}
        </div>
      </div>

      {/* summary cards — Total Expense · Billed · Paid · Outstanding */}
      <div className="xp-cardgrid">
        <div className={`xp-stat ${accent}`}>
          <div className="lbl">{group === 'DIRECT' ? 'Total direct expense' : 'Total indirect expense'}</div>
          <div className="val">{fmtL(billed)}</div>
        </div>
        <div className="xp-stat">
          <div className="lbl">Billed ({gstMode === 'incl' ? 'incl GST' : 'excl GST'})</div>
          <div className="val">{fmtL(billed)}</div>
        </div>
        <div className="xp-stat good"><div className="lbl">Paid</div><div className="val">{fmtL(paid)}</div></div>
        <div className="xp-stat alert"><div className="lbl">Outstanding</div><div className="val">{fmtL(outstanding)}</div></div>
      </div>

      {/* collapsible group block (same expand/collapse UI as Purchase > By-Category) */}
      <div className="xp-panel">
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0', color: 'var(--xp-faint)' }}>
            <Loader2 className="xp-spin" size={22} />
          </div>
        ) : !subs.length ? (
          <div style={{ padding: '44px 0', textAlign: 'center', color: 'var(--xp-faint)' }}>
            <PieChart size={26} style={{ margin: '0 auto 8px', opacity: 0.4 }} />
            No {group === 'DIRECT' ? 'direct' : 'indirect'} expense bills for this company / period.
          </div>
        ) : (
          <>
            {/* group header row — click to expand / collapse */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setOpen((v) => !v)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
              className="xp-grouphead"
            >
              <ChevronRight size={15} className={`xp-chev ${open ? 'open' : ''}`} />
              <span className={`xp-dot ${accent}`} />
              <span className={`xp-groupname ${accent}`}>{groupLabel}</span>
              <span className="xp-chip dim">{subs.length} heads · {billCount} bills</span>
              <span className="xp-grouptotal">{fmt(billed)}</span>
            </div>

            {open && (
              <div className="xp-pb flush">
                <table className="xp-table">
                  <thead>
                    <tr>
                      <th>Head</th>
                      <th className="num">Bills</th>
                      <th className="num">Billed</th>
                      <th className="num">Paid</th>
                      <th className="num">Outstanding</th>
                      {hasTally && <th className="num">Tally</th>}
                      <th style={{ width: '22%' }}>Share</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((r, i) => {
                      const b = billedOf(r);
                      const p = Number(r.paid) || 0;
                      const o = Number(r.outstanding) || 0;
                      const tal = r.tally != null ? Number(r.tally) : null;
                      const pct = (b / maxSub) * 100;
                      return (
                        <tr key={i}>
                          <td>{r.sub}</td>
                          <td className="num">{r.count || 0}</td>
                          <td className="num">{fmt(b)}</td>
                          <td className="num">{fmt(p)}</td>
                          <td className={`num ${o > 1 ? 'amount-neg' : ''}`}>{fmt(o)}</td>
                          {hasTally && (
                            <td className="num" style={{ color: 'var(--xp-faint)' }}>{tal != null ? fmt(tal) : '—'}</td>
                          )}
                          <td>
                            <div className="xp-sharebar"><div className={`xp-sharefill ${accent}`} style={{ width: `${pct}%` }} /></div>
                          </td>
                          <td>
                            {r.count > 0 && (
                              <a className="xp-headlink" onClick={() => openBills(r.sub)}>bills →</a>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="totrow">
                      <td>Total</td>
                      <td className="num">{billCount}</td>
                      <td className="num">{fmt(billed)}</td>
                      <td className="num">{fmt(paid)}</td>
                      <td className="num">{fmt(outstanding)}</td>
                      {hasTally && <td className="num">{fmt(Number(grp?.tally) || 0)}</td>}
                      <td /><td />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
