import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import StatusBadge from '../../../../components/common/StatusBadge';
import ListState from '../../../../components/common/ListState.jsx';
import apiClient from '../../../../utils/api.js';
import { formatDate } from '../../../../utils/formatters.js';

import KernelInputPanel from './KernelInputPanel.jsx';
import SLEWashesPanel from './SLEWashesPanel.jsx';
import SpentKernelForm from './SpentKernelForm.jsx';
import LLEWashesPanel from './LLEWashesPanel.jsx';
import FFEATFEPanel from './FFEATFEPanel.jsx';
import FinalProductPanel from './FinalProductPanel.jsx';
import BalancePanel from './BalancePanel.jsx';
import SignOffButton from './SignOffButton.jsx';

const TABS = [
  { id: 'kernel',   label: 'Kernel Input' },
  { id: 'sle',      label: 'SLE Washes + Spent Kernel' },
  { id: 'lle',      label: 'LLE Washes' },
  { id: 'ffe',      label: 'FFE' },
  { id: 'atfe',     label: 'ATFE' },
  { id: 'final',    label: 'Final Product' },
  { id: 'balance',  label: 'Balance' },
];

/**
 * Manufacturing Batch — detail view with per-stage tabs.
 *
 * Each tab component fetches its own data on mount and holds its own
 * state. `savedTick` bumps whenever any panel saves so downstream tabs
 * (like Balance) know to refresh.
 */
export default function ManufacturingBatchDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Direct apiClient fetch — useApiData is for LIST endpoints; a single
  // detail response ({id, batch_no, ...}) falls through its paginated
  // parser and leaves data as an empty array (truthy but with no fields).
  const [batch, setBatch] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const refetch = useCallback(() => {
    if (!id) return;
    setIsLoading(true);
    apiClient.get(`/api/production/manufacturing-batches/${id}/`)
      .then((res) => { setBatch(res.data); setError(null); })
      .catch((err) => setError(err?.response?.data || err.message))
      .finally(() => setIsLoading(false));
  }, [id]);
  useEffect(() => { refetch(); }, [refetch]);

  const [activeTab, setActiveTab] = useState('kernel');
  const [savedTick, setSavedTick] = useState(0);
  const bumpSaved = () => setSavedTick((t) => t + 1);

  return (
    <MainLayout>
      <PageHeader
        title={batch?.batch_no || 'Manufacturing Batch'}
        subtitle="Batch detail"
        breadcrumbs={[
          { label: 'Production', path: '/production/work-orders' },
          { label: 'Extraction' },
          { label: 'Manufacturing Batches', path: '/production/extraction/manufacturing-batches' },
          { label: batch?.batch_no || id },
        ]}
      />

      <ListState isLoading={isLoading} error={error} isEmpty={!isLoading && !batch}
                 emptyTitle="Batch not found" onRetry={refetch}>
        {batch && (
          <>
            <div className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 mb-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-slate-500 mb-1">Batch No</div>
                  <div className="font-mono text-slate-900">{batch.batch_no}</div>
                </div>
                <div>
                  <div className="text-slate-500 mb-1">Warehouse</div>
                  <div className="text-slate-900">{batch.warehouse_name}</div>
                </div>
                <div>
                  <div className="text-slate-500 mb-1">Batch Date</div>
                  <div className="text-slate-900">{batch.created_on ? formatDate(batch.created_on) : '-'}</div>
                </div>
                <div>
                  <div className="text-slate-500 mb-1">Status</div>
                  <div><StatusBadge status={batch.status_display || batch.status} /></div>
                </div>
                <div>
                  <div className="text-slate-500 mb-1">Planned Kernel (kg)</div>
                  <div className="text-slate-900">{batch.planned_kernel_qty_kg ? Number(batch.planned_kernel_qty_kg).toLocaleString() : '-'}</div>
                </div>
                <div>
                  <div className="text-slate-500 mb-1">Planned Washes</div>
                  <div className="text-slate-900">{batch.planned_wash_count ?? '-'}</div>
                </div>
                <div>
                  <div className="text-slate-500 mb-1">Planned Route</div>
                  <div className="text-slate-900">{batch.planned_route_display}</div>
                </div>
                <div>
                  <div className="text-slate-500 mb-1">Planned Production</div>
                  <div className="text-slate-900">{batch.planned_production_date ? formatDate(batch.planned_production_date) : '-'}</div>
                </div>
              </div>
              {batch.remarks && (
                <div className="mt-4 pt-4 border-t border-slate-100">
                  <div className="text-slate-500 text-sm mb-1">Remarks</div>
                  <div className="text-slate-800 text-sm whitespace-pre-wrap">{batch.remarks}</div>
                </div>
              )}

              {/* Sign-off action / indicator — flips batch to COMPLETED
                  when confirmed; locks the stage panels below to read-only. */}
              <div className="mt-4 pt-4 border-t border-slate-100 flex justify-end">
                <SignOffButton batch={batch} onChanged={refetch} />
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg">
              <div className="border-b border-slate-200 flex flex-wrap gap-1 px-2 pt-2 overflow-x-auto">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={
                      'px-4 py-2 text-sm rounded-t-md border-b-2 transition whitespace-nowrap ' +
                      (activeTab === tab.id
                        ? 'border-primary-600 text-primary-700 font-medium bg-primary-50/50'
                        : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50')
                    }
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="p-4 sm:p-5">
                {/* Signed-off batches are read-only. Each panel checks
                    the `readOnly` prop to hide add/delete affordances. */}
                {batch.sign_off && (
                  <div className="mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                    This batch is signed off — panels are read-only. Click "Revoke" in the header if you need to make changes.
                  </div>
                )}
                {activeTab === 'kernel' && (
                  <KernelInputPanel batchId={id} batch={batch} readOnly={!!batch.sign_off} onSaved={() => { refetch(); bumpSaved(); }} />
                )}
                {activeTab === 'sle' && (
                  <>
                    <SLEWashesPanel batchId={id} batch={batch} readOnly={!!batch.sign_off} onSaved={bumpSaved} />
                    <SpentKernelForm batchId={id} readOnly={!!batch.sign_off} onSaved={bumpSaved} />
                  </>
                )}
                {activeTab === 'lle' && (
                  <LLEWashesPanel batchId={id} readOnly={!!batch.sign_off} onSaved={bumpSaved} />
                )}
                {activeTab === 'ffe' && (
                  <FFEATFEPanel batchId={id} batch={batch} stage="ffe" readOnly={!!batch.sign_off} onSaved={bumpSaved} />
                )}
                {activeTab === 'atfe' && (
                  <FFEATFEPanel batchId={id} batch={batch} stage="atfe" readOnly={!!batch.sign_off} onSaved={bumpSaved} />
                )}
                {activeTab === 'final' && (
                  <FinalProductPanel batch={batch} readOnly={!!batch.sign_off} onSaved={bumpSaved} />
                )}
                {activeTab === 'balance' && (
                  <BalancePanel batchId={id} refreshKey={savedTick} />
                )}
              </div>
            </div>

            {/* Bottom action row — pb-24 on mobile so the mobile
                bottom-nav bar (Production / HR / Archive) doesn't
                overlap the Back button. Ordinary padding on sm+. */}
            <div className="mt-4 mb-4 pb-24 sm:pb-0 flex gap-3">
              <button
                onClick={() => navigate('/production/extraction/manufacturing-batches')}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Back to list
              </button>
            </div>
          </>
        )}
      </ListState>
    </MainLayout>
  );
}
