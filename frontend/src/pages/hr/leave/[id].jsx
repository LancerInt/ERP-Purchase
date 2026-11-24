import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, X as XIcon, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatDateTime } from '@/utils/formatters';

const LEAVE_TYPE_LABELS = {
  FULL_DAY: 'Full Day',
  HALF_DAY: 'Half Day',
  PERMISSION: 'Permission',
};

const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtDateTime = (v) =>
  v ? formatDateTime(v) : '-';

export default function LeaveRequestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canApprove } = usePermissions();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get(`/api/hr/leave/${id}/`);
      setRecord(res.data);
    } catch (err) {
      if (err.response?.status !== 404) toast.error(getApiErrorMessage(err) || 'Failed to load leave request');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleAction = async (kind) => {
    if (!(await confirm({ message: `${kind === 'approve' ? 'Approve' : 'Reject'} this leave request?` }))) return;
    setActioning(true);
    try {
      await apiClient.post(`/api/hr/leave/${id}/${kind}/`);
      toast.success(kind === 'approve' ? 'Leave approved.' : 'Leave rejected.');
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || `Failed to ${kind}.`);
    } finally {
      setActioning(false);
    }
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="text-center py-12 text-slate-500">Loading…</div>
      </MainLayout>
    );
  }

  if (!record) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Leave request not found.</p>
          <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/hr/leave')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Leave
          </button>
        </div>
      </MainLayout>
    );
  }

  const isPending = record.status === 'PENDING';

  return (
    <MainLayout>
      <PageHeader
        title={`Leave Request ${record.request_no || ''}`}
        subtitle={`${record.staff_name || '-'} • ${LEAVE_TYPE_LABELS[record.leave_type] || record.leave_type}`}
        breadcrumbs={[
          { label: 'HR', href: '/hr' },
          { label: 'Leave Requests', href: '/hr/leave' },
          { label: record.request_no || 'Detail' },
        ]}
      />
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/hr/leave')}
          className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800"
        >
          <ArrowLeft size={16} /> Back to list
        </button>
        {canApprove('Leave') && isPending && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleAction('reject')}
              disabled={actioning}
              className="flex items-center gap-2 px-4 py-2 border border-red-300 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
            >
              <XIcon size={16} /> Reject
            </button>
            <button
              onClick={() => handleAction('approve')}
              disabled={actioning}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check size={16} /> Approve
            </button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 space-y-4 sm:space-y-5">
        {/* Status banner */}
        <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
          <StatusBadge status={record.status} />
          {record.approver_name && (
            <span className="text-sm text-slate-500">
              {record.status === 'APPROVED' ? 'Approved by ' : record.status === 'REJECTED' ? 'Rejected by ' : 'Reviewed by '}
              <span className="font-medium text-slate-700">{record.approver_name}</span>
              {record.approval_date && <> on {fmtDateTime(record.approval_date)}</>}
            </span>
          )}
        </div>

        {/* Staff + dates */}
        <Section title="Request Details">
          <Field label="Request No" value={record.request_no} mono />
          <Field label="Staff" value={`${record.staff_name || '-'} (${record.staff_id_display || '-'})`} />
          <Field label="Leave Type" value={LEAVE_TYPE_LABELS[record.leave_type] || record.leave_type} />
          <Field label="Start Date" value={fmtDate(record.start_date)} />
          <Field label="End Date" value={fmtDate(record.end_date)} />
          <Field label="Days Requested" value={record.days_requested} />
          <Field
            label="Duration (hours)"
            value={record.duration_hours != null ? Number(record.duration_hours).toFixed(2) : '-'}
          />
          <Field label="Submitted On" value={fmtDateTime(record.created_at)} />
        </Section>

        {Number(record.lop_days || 0) > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex items-start gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 flex-shrink-0">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
              <line x1="12" x2="12" y1="9" y2="13"></line>
              <line x1="12" x2="12.01" y1="17" y2="17"></line>
            </svg>
            <div>
              <p className="font-semibold mb-0.5">Loss of Pay applied</p>
              <p className="text-xs">
                <strong>{record.lop_days}</strong> day(s) of this leave exceeded the annual
                quota and will be deducted from the next payroll run as
                <em> Loss of Pay</em>. The deduction amount is the staff&apos;s Salary Per Day × {record.lop_days}.
              </p>
            </div>
          </div>
        )}

        <Section title="Reason">
          <p className="col-span-full text-sm text-slate-700 whitespace-pre-wrap">
            {record.reason || <span className="text-slate-400 italic">No reason provided.</span>}
          </p>
        </Section>

        {record.attachment && (
          <Section title="Attachment">
            <a
              href={record.attachment}
              target="_blank"
              rel="noreferrer"
              className="col-span-full inline-flex items-center gap-2 text-blue-600 hover:underline text-sm"
            >
              <Download size={14} /> View attachment
            </a>
          </Section>
        )}
      </div>
    </MainLayout>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-700 mb-3">{title}</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className={`text-sm text-slate-800 ${mono ? 'font-mono' : 'font-medium'}`}>{value || '-'}</p>
    </div>
  );
}
