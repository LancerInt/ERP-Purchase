/**
 * Status pill used across every list/detail page. Premium clean look:
 * soft tinted background + matching text and a subtle border (Linear/
 * Stripe style), consistent with the design-system Badge.
 */
const STATUS_COLORS = {
  DRAFT:              'bg-slate-100 text-slate-700 border-slate-200',
  ACTIVE:             'bg-emerald-50 text-emerald-700 border-emerald-200',
  ARCHIVED:           'bg-slate-100 text-slate-600 border-slate-200',
  INACTIVE:           'bg-slate-100 text-slate-500 border-slate-200',
  EDITED:             'bg-blue-50 text-blue-700 border-blue-200',
  PENDING:            'bg-amber-50 text-amber-700 border-amber-200',
  PENDING_APPROVAL:   'bg-amber-50 text-amber-700 border-amber-200',
  PARTIALLY_APPROVED: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED:           'bg-emerald-50 text-emerald-700 border-emerald-200',
  REJECTED:           'bg-red-50 text-red-700 border-red-200',
  ISSUED:             'bg-indigo-50 text-indigo-700 border-indigo-200',
  IN_PROGRESS:        'bg-blue-50 text-blue-700 border-blue-200',
  PARTIALLY_RECEIVED: 'bg-amber-50 text-amber-700 border-amber-200',
  RECEIVED:           'bg-emerald-50 text-emerald-700 border-emerald-200',
  CLOSED:             'bg-slate-100 text-slate-600 border-slate-200',
  PAID:               'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELLED:          'bg-red-50 text-red-700 border-red-200',
  // SPLIT — a PO that was reorganised into N child DRAFT POs via
  // the Split-into-batches action. Purple to visually separate from
  // Cancelled; the obligation lives on the child POs.
  SPLIT:              'bg-purple-50 text-purple-700 border-purple-200',
  COMPLETED:          'bg-emerald-50 text-emerald-700 border-emerald-200',
  FAILED:             'bg-red-50 text-red-700 border-red-200',
};

const DEFAULT_COLOR = 'bg-slate-100 text-slate-600 border-slate-200';

// Human-readable display labels for codes that aren't friendly as-is.
const STATUS_LABELS = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
  INACTIVE: 'Inactive',
  PARTIALLY_RECEIVED: 'Partially Received',
  PENDING: 'Pending',
  PENDING_APPROVAL: 'Pending Approval',
  PARTIALLY_APPROVED: 'Partially Approved',
  IN_PROGRESS: 'In Progress',
};

export default function StatusBadge({ status, label = null }) {
  // Tolerate both the raw enum ("PAID") and the human display ("Paid")
  // — DRF serializers usually surface get_<field>_display() which is
  // title-case, while raw API status fields come through upper-snake.
  const key = typeof status === 'string'
    ? (STATUS_COLORS[status]
        ? status
        : STATUS_COLORS[status.toUpperCase().replace(/\s+/g, '_')]
          ? status.toUpperCase().replace(/\s+/g, '_')
          : null)
    : null;
  const cls = (key && STATUS_COLORS[key]) || DEFAULT_COLOR;
  const displayLabel = label || STATUS_LABELS[status] || status;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${cls}`}
    >
      {displayLabel}
    </span>
  );
}
