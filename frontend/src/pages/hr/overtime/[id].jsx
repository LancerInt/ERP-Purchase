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

const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtDateTime = (v) =>
  v ? formatDateTime(v) : '-';

export default function OvertimeRequestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canApprove } = usePermissions();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get(`/api/hr/overtime/${id}/`);
      setRecord(res.data);
    } catch (err) {
      if (err.response?.status !== 404) toast.error(getApiErrorMessage(err) || 'Failed to load overtime request');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const handleAction = async (kind) => {
    if (!(await confirm({ message: `${kind === 'approve' ? 'Approve' : 'Reject'} this overtime request?` }))) return;
    setActioning(true);
    try {
      await apiClient.post(`/api/hr/overtime/${id}/${kind}/`);
      toast.success(kind === 'approve' ? 'Overtime approved.' : 'Overtime rejected.');
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
          <p className="text-red-500 mb-3">Overtime request not found.</p>
          <button onClick={() => navigate('/hr/overtime')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Overtime
          </button>
        </div>
      </MainLayout>
    );
  }

  const isPending = record.approval_status === 'PENDING';

  return (
    <MainLayout>
      <PageHeader
        title={`Overtime ${record.request_no || ''}`}
        subtitle={`${record.staff_name || '-'} • ${fmtDate(record.date)} • ${Number(record.hours_worked || 0).toFixed(2)} hrs`}
        breadcrumbs={[
          { label: 'HR', href: '/hr' },
          { label: 'Overtime', href: '/hr/overtime' },
          { label: record.request_no || 'Detail' },
        ]}
      />
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => navigate('/hr/overtime')}
          className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800"
        >
          <ArrowLeft size={16} /> Back to list
        </button>
        {canApprove('Overtime') && isPending && (
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
        <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
          <StatusBadge status={record.approval_status} />
          {record.approved_by_name && (
            <span className="text-sm text-slate-500">
              {record.approval_status === 'APPROVED' ? 'Approved by ' : record.approval_status === 'REJECTED' ? 'Rejected by ' : 'Reviewed by '}
              <span className="font-medium text-slate-700">{record.approved_by_name}</span>
            </span>
          )}
          {record.wage_integration_flag && (
            <span className="ml-auto px-2.5 py-1 bg-emerald-50 text-emerald-700 text-xs font-medium rounded">
              ✓ Carried to payroll
            </span>
          )}
        </div>

        <Section title="Request Details">
          <Field label="Request No" value={record.request_no} mono />
          <Field label="Staff" value={`${record.staff_name || '-'} (${record.staff_id_display || '-'})`} />
          <Field label="Date" value={fmtDate(record.date)} />
          <Field label="Shift" value={record.shift_name || '—'} />
          <Field label="Hours Worked" value={Number(record.hours_worked || 0).toFixed(2)} />
          <Field label="Submitted On" value={fmtDateTime(record.created_at)} />
        </Section>

        <Section title="Task Description">
          <p className="col-span-full text-sm text-slate-700 whitespace-pre-wrap">
            {record.task_description || <span className="text-slate-400 italic">No description provided.</span>}
          </p>
        </Section>

        {record.supporting_evidence && (
          <Section title="Supporting Evidence">
            <a
              href={record.supporting_evidence}
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
