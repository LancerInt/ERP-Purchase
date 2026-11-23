/**
 * Payment / collection calendar bucketing — pure-logic test.
 *
 * The repo has no JS test runner, so this is a standalone Node script that
 * mirrors payDaysUntilDue + PAY_BUCKETS + payBucketKey from ./index.jsx and
 * asserts them. Run it directly:
 *
 *     node src/pages/reports/summary/paycal_bucket.test.mjs
 *
 * It pins the bucket boundaries (Overdue / Today / Next 7 / 15 / 30 / Later)
 * and the undated-row fix: a bill/invoice with no usable due date must land in
 * "Later", NOT in "Today" — daysOverdue(null) used to return 0, which wrongly
 * reported an undated item as due today. Keep this file in sync with index.jsx
 * if the buckets change.
 */
import assert from 'node:assert';

const PAY_BUCKETS = [
  { k: 'over',  test: (dd) => dd !== null && dd < 0 },
  { k: 'today', test: (dd) => dd === 0 },
  { k: 'd7',    test: (dd) => dd !== null && dd >= 1 && dd <= 7 },
  { k: 'd15',   test: (dd) => dd !== null && dd >= 8 && dd <= 15 },
  { k: 'd30',   test: (dd) => dd !== null && dd >= 16 && dd <= 30 },
  { k: 'later', test: (dd) => dd === null || dd > 30 },
];
function payDaysUntilDue(iso, today) {
  if (!iso) return null;
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return null;
  return Math.round((d - today) / 86400000);
}
function payBucketKey(dd) { const b = PAY_BUCKETS.find((x) => x.test(dd)); return b ? b.k : 'later'; }

const TODAY = new Date('2026-11-18T00:00:00');
const bucketOf = (iso) => payBucketKey(payDaysUntilDue(iso, TODAY));

let n = 0; const ok = (name, cond) => { n++; assert.ok(cond, name); console.log('ok  -', name); };

// the bug this fixes: an undated row must land in Later, NOT Today
ok('null iso -> dd null', payDaysUntilDue(null, TODAY) === null);
ok('empty iso -> dd null', payDaysUntilDue('', TODAY) === null);
ok('garbage iso -> dd null', payDaysUntilDue('not-a-date', TODAY) === null);
ok('undated -> Later (not Today)', bucketOf(null) === 'later');
ok('garbage date -> Later (not Today)', bucketOf('not-a-date') === 'later');

// boundaries
ok('due today -> today', bucketOf('2026-11-18') === 'today');
ok('due yesterday -> overdue', bucketOf('2026-11-17') === 'over');
ok('30d ago -> overdue', bucketOf('2026-10-19') === 'over');
ok('in 1 day -> d7', bucketOf('2026-11-19') === 'd7');
ok('in 7 days -> d7 (upper edge)', bucketOf('2026-11-25') === 'd7');
ok('in 8 days -> d15 (lower edge)', bucketOf('2026-11-26') === 'd15');
ok('in 15 days -> d15 (upper edge)', bucketOf('2026-12-03') === 'd15');
ok('in 16 days -> d30 (lower edge)', bucketOf('2026-12-04') === 'd30');
ok('in 30 days -> d30 (upper edge)', bucketOf('2026-12-18') === 'd30');
ok('in 31 days -> later (lower edge)', bucketOf('2026-12-19') === 'later');
ok('in 120 days -> later', bucketOf('2027-03-18') === 'later');

// every real dd lands in exactly one bucket (partition)
for (let dd = -400; dd <= 400; dd++) {
  const hits = PAY_BUCKETS.filter((b) => b.test(dd)).length;
  assert.strictEqual(hits, 1, `dd=${dd} must hit exactly one bucket, hit ${hits}`);
}
ok('every dd in [-400,400] hits exactly one bucket', true);
ok('null hits exactly one bucket', PAY_BUCKETS.filter((b) => b.test(null)).length === 1);

// ── opening-balance carrier detection (excluded from ageing/calendar) ──
// Mirrors isOpeningCarrier() in index.jsx. Opening carriers must be recognised
// so they don't sit in "what's still owed" at their full opening amount — their
// real settlement lives in the vendor running ledger (on-account payments).
function isOpeningCarrier(r) {
  const inv = String(r.vendor_invoice_no || r.invoice_no || '').toUpperCase();
  const guid = String(r.tally_guid || '').toUpperCase();
  return inv === 'OPENING' || inv.startsWith('OPEN-') || guid.startsWith('OPENING');
}
ok('OPENING invoice_no is a carrier', isOpeningCarrier({ vendor_invoice_no: 'OPENING' }) === true);
ok('OPEN- prefix is a carrier', isOpeningCarrier({ vendor_invoice_no: 'OPEN-001' }) === true);
ok('OPENING tally_guid is a carrier', isOpeningCarrier({ tally_guid: 'OPENING-abc-123' }) === true);
ok('lowercase opening still caught', isOpeningCarrier({ vendor_invoice_no: 'opening' }) === true);
ok('sales invoice_no OPENING caught', isOpeningCarrier({ invoice_no: 'OPENING' }) === true);
ok('a real bill is NOT a carrier', isOpeningCarrier({ vendor_invoice_no: 'UAI-027', tally_guid: 'abc-def' }) === false);
ok('blank row is NOT a carrier', isOpeningCarrier({}) === false);
ok('OPEN substring mid-string is NOT a carrier', isOpeningCarrier({ vendor_invoice_no: 'REOPENED-5' }) === false);

console.log(`\nPASS — ${n} assertions`);
