import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { confirm } from '@/components/common/confirm';
import { formatCurrency, formatDate } from '@/utils/formatters';

const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtMoney = (v) => formatCurrency(v);

export default function PayrollExportDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get(`/api/hr/payroll/${id}/`);
      setRecord(res.data);
    } catch (err) {
      if (err.response?.status !== 404) toast.error(getApiErrorMessage(err) || 'Failed to load payroll export');
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerate = async () => {
    if (!(await confirm({ message: 'Regenerate this payroll run? All per-staff rows will be recalculated from current attendance, leave (incl. LOP) and overtime data for the same period. The Run ID stays the same.', isDangerous: true }))) return;
    setRegenerating(true);
    try {
      const res = await apiClient.post(`/api/hr/payroll/${id}/regenerate/`);
      setRecord(res.data);
      toast.success('Payroll regenerated from latest HR data.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to regenerate payroll.');
    } finally {
      setRegenerating(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

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
          <p className="text-red-500 mb-3">Payroll export not found.</p>
          <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/hr/payroll')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Payroll
          </button>
        </div>
      </MainLayout>
    );
  }

  const summaries = record.staff_summaries || [];
  const totals = summaries.reduce((acc, s) => ({
    present: acc.present + Number(s.present_days || 0),
    absent: acc.absent + Number(s.absent_days || 0),
    overtime: acc.overtime + Number(s.overtime_hours || 0),
    lopDays: acc.lopDays + Number(s.lop_days || 0),
    lopDeduction: acc.lopDeduction + Number(s.lop_deduction || 0),
    wages: acc.wages + Number(s.wages_amount || 0),
  }), { present: 0, absent: 0, overtime: 0, lopDays: 0, lopDeduction: 0, wages: 0 });

  return (
    <MainLayout>
      <PageHeader
        title={`Payroll ${record.export_id || ''}`}
        subtitle={`${record.warehouse_name || '-'} • ${fmtDate(record.period_start)} → ${fmtDate(record.period_end)}`}
        breadcrumbs={[
          { label: 'HR', href: '/hr' },
          { label: 'Payroll', href: '/hr/payroll' },
          { label: record.export_id || 'Detail' },
        ]}
      />
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/hr/payroll')}
          className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800"
        >
          <ArrowLeft size={16} /> Back to list
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="flex items-center gap-2 px-4 py-2 border border-blue-300 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
            title="Recompute from current attendance / leave / overtime for the same period"
          >
            <RefreshCw size={16} className={regenerating ? 'animate-spin' : ''} />
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
          {record.export_file && (
            <a
              href={record.export_file}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              <Download size={16} /> Download Export
            </a>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 space-y-4 sm:space-y-5">
        <Section title="Period Summary">
          <Field label="Export ID" value={record.export_id} mono />
          <Field label="Warehouse" value={record.warehouse_name} />
          <Field label="Period Start" value={fmtDate(record.period_start)} />
          <Field label="Period End" value={fmtDate(record.period_end)} />
          <Field label="Staff Count" value={record.total_staff || 0} />
          <Field label="Total OT Hours" value={Number(record.overtime_hours_total || 0).toFixed(2)} />
        </Section>

        {record.attendance_metrics && (
          <Section title="Attendance Metrics">
            <pre className="col-span-full text-xs text-slate-600 bg-slate-50 p-3 rounded border border-slate-200 whitespace-pre-wrap">
              {record.attendance_metrics}
            </pre>
          </Section>
        )}

        {record.exceptions && (
          <Section title="Exceptions">
            <pre className="col-span-full text-xs text-amber-800 bg-amber-50 p-3 rounded border border-amber-200 whitespace-pre-wrap">
              {record.exceptions}
            </pre>
          </Section>
        )}

        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3">
            Per-Staff Summary ({summaries.length})
          </h3>
          {summaries.length === 0 ? (
            <p className="text-sm text-slate-400 italic">No per-staff records on this export.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Staff ID</th>
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Name</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Present</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Absent</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">OT Hours</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">LOP Days</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">LOP Deduction</th>
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Net Wages</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summaries.map((s) => {
                    const lopDays = Number(s.lop_days || 0);
                    const lopDed = Number(s.lop_deduction || 0);
                    return (
                      <tr key={s.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono text-xs">{s.staff_id_display}</td>
                        <td className="px-3 py-2 font-medium text-slate-800">{s.staff_name || '-'}</td>
                        <td className="px-3 py-2 text-right">{s.present_days}</td>
                        <td className="px-3 py-2 text-right text-red-600">{s.absent_days}</td>
                        <td className="px-3 py-2 text-right text-violet-700">{Number(s.overtime_hours || 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-right">
                          {lopDays > 0
                            ? <span className="text-red-700 font-medium">{lopDays}</span>
                            : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {lopDed > 0
                            ? <span className="text-red-700 font-semibold">−{fmtMoney(lopDed)}</span>
                            : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmtMoney(s.wages_amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 font-semibold">
                  <tr>
                    <td colSpan={2} className="px-3 py-2 text-slate-700">Totals</td>
                    <td className="px-3 py-2 text-right">{totals.present}</td>
                    <td className="px-3 py-2 text-right text-red-600">{totals.absent}</td>
                    <td className="px-3 py-2 text-right text-violet-700">{totals.overtime.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-red-700">{totals.lopDays.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-red-700">
                      {totals.lopDeduction > 0 ? `−${fmtMoney(totals.lopDeduction)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-emerald-700">{fmtMoney(totals.wages)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
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
