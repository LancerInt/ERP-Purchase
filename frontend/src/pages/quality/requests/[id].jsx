import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { formatDate } from '@/utils/formatters';

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-slate-800 mt-0.5 whitespace-pre-wrap">{value || '-'}</p>
    </div>
  );
}

export default function QCRequestDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Real record from the QC Request API. (Pass/fail RESULTS are not part of
  // a request — they're produced later by the Lab Job — so we never show a
  // fabricated outcome here.)
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiClient.get(`/api/quality/requests/${id}/`)
      .then((res) => { if (!cancelled) { setData(res.data); setError(false); } })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  if (isLoading) {
    return <MainLayout><div className="flex justify-center py-20"><Loader2 className="animate-spin text-primary-600" /></div></MainLayout>;
  }
  if (error || !data) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">QC request not found.</p>
          <button onClick={() => navigate('/quality/requests')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back
          </button>
        </div>
      </MainLayout>
    );
  }

  const params = data.selected_parameters || [];

  return (
    <MainLayout>
      <PageHeader
        title={data.request_no || 'QC Request'}
        breadcrumbs={[{ label: 'Quality' }, { label: 'QC Requests', href: '/quality/requests' }, { label: data.request_no || '' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 space-y-5">
        <div className="flex items-center justify-between gap-3 pb-3 border-b">
          <div className="flex items-center gap-3">
            <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/quality/requests'))} className="text-slate-500 hover:text-slate-800"><ArrowLeft size={18} /></button>
            <StatusBadge status={data.status_display || data.status} />
          </div>
          {data.priority && (
            <span className="text-xs px-2 py-1 rounded border border-slate-200 text-slate-600">Priority: {data.priority}</span>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Field label="Date" value={data.request_date ? formatDate(data.request_date) : '-'} />
          <Field label="Product" value={data.product_code} />
          <Field label="Warehouse" value={data.warehouse_code} />
          <Field label="Batch" value={data.batch} />
          <Field label="Stage" value={data.stage} />
          <Field label="Sample Qty" value={data.sample_qty} />
          <Field label="Template" value={data.template_name} />
          <Field label="Requested By" value={data.requested_by_name} />
          <Field label="Counter Sample" value={data.counter_sample_required ? 'Required' : 'No'} />
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Parameters to Test ({params.length})</h3>
          {params.length === 0 ? (
            <p className="text-sm text-slate-400">No parameters selected.</p>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                    <th className="px-3 py-2 font-medium">Code</th>
                    <th className="px-3 py-2 font-medium">Parameter</th>
                    <th className="px-3 py-2 font-medium">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {params.map((p, i) => (
                    <tr key={p.id || i} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-3 py-2 text-slate-500">{p.parameter_code || '-'}</td>
                      <td className="px-3 py-2">{p.parameter_name || '-'}</td>
                      <td className="px-3 py-2">{p.unit || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">Test results are recorded against this request's Lab Job, not here.</p>
        </div>

        {data.remarks && <Field label="Remarks" value={data.remarks} />}
      </div>
    </MainLayout>
  );
}
