import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MapPin, Camera, Trash2 } from 'lucide-react';
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

export default function AttendanceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canDelete } = usePermissions();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete this attendance record? This cannot be undone.`, isDangerous: true }))) return;
    setDeleting(true);
    try {
      await apiClient.delete(`/api/hr/attendance/${id}/`);
      toast.success('Attendance record deleted.');
      navigate('/hr/attendance');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete attendance record.');
      setDeleting(false);
    }
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await apiClient.get(`/api/hr/attendance/${id}/`);
        setRecord(res.data);
      } catch (err) {
        if (err.response?.status !== 404) toast.error(getApiErrorMessage(err) || 'Failed to load attendance record');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

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
          <p className="text-red-500 mb-3">Attendance record not found.</p>
          <button onClick={() => navigate('/hr/attendance')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Attendance
          </button>
        </div>
      </MainLayout>
    );
  }

  const hasGeo = record.geo_latitude != null && record.geo_longitude != null;

  return (
    <MainLayout>
      <PageHeader
        title={`Attendance — ${fmtDate(record.date)}`}
        subtitle={`${record.staff_name || '-'} (${record.staff_id_display || '-'})`}
        breadcrumbs={[
          { label: 'HR', href: '/hr' },
          { label: 'Attendance', href: '/hr/attendance' },
          { label: fmtDate(record.date) },
        ]}
      />
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/hr/attendance'))}
          className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800"
        >
          <ArrowLeft size={16} /> Back to list
        </button>
        <div className="flex items-center gap-3">
          <StatusBadge status={record.attendance_status} />
          {canDelete('Attendance') && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex items-center gap-2 px-3 py-2 border border-red-300 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 size={14} /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 space-y-4 sm:space-y-5">
        <Section title="Capture Details">
          <Field label="Staff" value={`${record.staff_name || '-'} (${record.staff_id_display || '-'})`} />
          <Field label="Date" value={fmtDate(record.date)} />
          <Field label="Shift" value={record.shift_name || '—'} />
          <Field label="Check-in" value={fmtDateTime(record.check_in_time)} mono />
          <Field label="Check-out" value={fmtDateTime(record.check_out_time)} mono />
          <Field label="Duration" value={record.duration_hours != null ? `${Number(record.duration_hours).toFixed(2)} hours` : '—'} />
          <Field label="Overtime" value={Number(record.overtime_hours || 0) > 0 ? `${Number(record.overtime_hours).toFixed(2)} hours` : '—'} />
          <Field label="Device" value={record.device_id || '—'} mono />
          <Field
            label="Face Match"
            value={record.face_match_confidence != null
              ? `${(Number(record.face_match_confidence) * 100).toFixed(1)}%`
              : '—'}
          />
        </Section>

        {(record.entry_photo || record.exit_photo) && (
          <Section title="Photos">
            {record.entry_photo && (
              <div className="col-span-1">
                <p className="text-xs text-slate-500 mb-2">Entry</p>
                <a href={record.entry_photo} target="_blank" rel="noreferrer">
                  <img src={record.entry_photo} alt="Entry"
                    className="w-full rounded-lg border border-slate-200 max-h-48 object-cover" />
                </a>
              </div>
            )}
            {record.exit_photo && (
              <div className="col-span-1">
                <p className="text-xs text-slate-500 mb-2">Exit</p>
                <a href={record.exit_photo} target="_blank" rel="noreferrer">
                  <img src={record.exit_photo} alt="Exit"
                    className="w-full rounded-lg border border-slate-200 max-h-48 object-cover" />
                </a>
              </div>
            )}
            {!record.entry_photo && !record.exit_photo && (
              <p className="col-span-full text-sm text-slate-400 italic flex items-center gap-2">
                <Camera size={14} /> No photos captured.
              </p>
            )}
          </Section>
        )}

        {hasGeo && (
          <Section title="Location">
            <div className="col-span-full">
              <p className="text-sm text-slate-700 mb-2">
                <MapPin size={14} className="inline mr-1 text-blue-600" />
                {Number(record.geo_latitude).toFixed(6)}, {Number(record.geo_longitude).toFixed(6)}
              </p>
              <a
                href={`https://maps.google.com/?q=${record.geo_latitude},${record.geo_longitude}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-blue-600 hover:underline text-sm"
              >
                Open in Google Maps →
              </a>
            </div>
          </Section>
        )}

        {record.notes && (
          <Section title="Notes">
            <p className="col-span-full text-sm text-slate-700 whitespace-pre-wrap">{record.notes}</p>
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
