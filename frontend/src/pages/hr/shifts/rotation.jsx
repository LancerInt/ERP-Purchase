import { useMemo, useState } from 'react';
import { Plus, Trash2, Layers, Users, CalendarClock, X } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import Modal from '@/components/ui/Modal';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function ShiftRotation() {
  const { canCreate, canDelete } = usePermissions();
  const [tab, setTab] = useState('patterns');

  const patterns = useApiData('/api/hr/rotation-patterns/');
  const assignments = useApiData('/api/hr/rotation-assignments/');
  const { data: shifts } = useApiData('/api/hr/shifts/');
  const { data: staffList } = useApiData('/api/hr/staff/');
  const { data: warehouses } = useApiData('/api/warehouses/');

  return (
    <MainLayout>
      <PageHeader
        title="Shift Rotation"
        subtitle="Define rotating rosters (Morning → Evening → Night) and assign staff to them. The shift any employee works on a given date is resolved from their rotation; weekly-offs come from each step or the shift itself."
        breadcrumbs={[{ label: 'HR', href: '/hr' }, { label: 'Shifts', href: '/hr/shifts' }, { label: 'Rotation' }]}
      />

      <div className="flex gap-1 mb-4 border-b border-slate-200">
        <TabBtn active={tab === 'patterns'} onClick={() => setTab('patterns')} icon={Layers} label="Rotation Patterns" count={(patterns.data || []).length} />
        <TabBtn active={tab === 'assignments'} onClick={() => setTab('assignments')} icon={Users} label="Staff Assignments" count={(assignments.data || []).length} />
      </div>

      {tab === 'patterns' ? (
        <PatternsTab
          patterns={patterns} shifts={shifts || []} warehouses={warehouses || []}
          canCreate={canCreate('Shift')} canDelete={canDelete('Shift')} />
      ) : (
        <AssignmentsTab
          assignments={assignments} patterns={patterns.data || []} staffList={staffList || []}
          warehouses={warehouses || []} canCreate={canCreate('Shift')} canDelete={canDelete('Shift')} />
      )}
    </MainLayout>
  );
}

/* ─────────────────────────── Patterns ─────────────────────────── */

function PatternsTab({ patterns, shifts, warehouses, canCreate, canDelete }) {
  const { data, isLoading, error, refetch } = patterns;
  const [showNew, setShowNew] = useState(false);
  const [stepsFor, setStepsFor] = useState(null); // pattern being edited
  const [form, setForm] = useState({ name: '', warehouse: '', step_length_days: 7, description: '' });
  const [saving, setSaving] = useState(false);

  const createPattern = async () => {
    if (!form.name.trim()) { toast.error('Name the pattern.'); return; }
    if (!form.warehouse) { toast.error('Pick a warehouse.'); return; }
    setSaving(true);
    try {
      await apiClient.post('/api/hr/rotation-patterns/', {
        name: form.name, warehouse: form.warehouse,
        step_length_days: Number(form.step_length_days) || 7, description: form.description,
      });
      toast.success('Pattern created. Add its shift steps next.');
      setShowNew(false);
      setForm({ name: '', warehouse: '', step_length_days: 7, description: '' });
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to create pattern.');
    } finally { setSaving(false); }
  };

  const removePattern = async (row) => {
    if (!(await confirm({ message: `Delete rotation pattern "${row.name}"?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/hr/rotation-patterns/${row.id}/`);
      toast.success('Pattern deleted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  const columns = [
    { field: 'name', header: 'Pattern', sortable: true, width: '200px',
      render: (v) => <span className="font-medium text-slate-800">{v}</span> },
    { field: 'warehouse_name', header: 'Warehouse', sortable: true, width: '160px', render: (v) => v || '-' },
    { field: 'step_count', header: 'Steps', sortable: true, width: '80px',
      render: (v) => <span className="font-semibold text-slate-700">{v}</span> },
    { field: 'sequence', header: 'Rotation', sortable: false, width: '260px',
      render: (_, row) => {
        const seq = (row.steps || []).map(s => s.shift_code).join(' → ');
        return seq ? <span className="text-xs text-slate-600">{seq}</span> : <span className="text-amber-600 text-xs">No steps yet</span>;
      } },
    { field: 'cycle_length_days', header: 'Cycle', sortable: true, width: '90px',
      render: (v) => <span className="text-xs text-slate-500">{v} days</span> },
    { field: 'actions', header: '', sortable: false, width: '120px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canCreate && (
            <button onClick={(e) => { e.stopPropagation(); setStepsFor(row); }}
              className="px-2 py-1 text-xs text-blue-700 border border-blue-200 rounded hover:bg-blue-50" title="Manage steps">
              Steps
            </button>
          )}
          {canDelete && (
            <button onClick={(e) => { e.stopPropagation(); removePattern(row); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ) },
  ];

  return (
    <>
      {canCreate && (
        <div className="flex justify-end mb-3">
          <button onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
            <Plus size={16} /> New Pattern
          </button>
        </div>
      )}

      <ListState error={error} onRetry={refetch}>
        <DataTable
          exportFileName="rotation-patterns" columns={columns} data={data || []} isLoading={isLoading}
          emptyMessage="No rotation patterns yet"
          emptyHint="Create a pattern, then add the ordered shifts it cycles through." />
      </ListState>

      <Modal isOpen={showNew} onClose={() => setShowNew(false)} title="New Rotation Pattern" size="md"
        footer={(
          <>
            <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50">Cancel</button>
            <button onClick={createPattern} disabled={saving}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
              {saving ? 'Creating…' : 'Create'}
            </button>
          </>
        )}>
        <div className="space-y-3">
          <Field label="Pattern name" required>
            <input value={form.name} onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))}
              className="input" placeholder="e.g. 3-Shift Weekly Rotation" />
          </Field>
          <Field label="Warehouse" required>
            <CustomSelect value={form.warehouse} onChange={(e) => setForm(p => ({ ...p, warehouse: e.target.value }))} className="input">
              <option value="">Select warehouse…</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </CustomSelect>
          </Field>
          <Field label="Days per step">
            <input type="number" min="1" value={form.step_length_days}
              onChange={(e) => setForm(p => ({ ...p, step_length_days: e.target.value }))}
              className="input" />
            <p className="text-xs text-slate-400 mt-1">How long each shift in the cycle lasts before rotating. 7 = weekly.</p>
          </Field>
          <Field label="Description">
            <textarea value={form.description} onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))}
              rows={2} className="input" />
          </Field>
        </div>
      </Modal>

      {stepsFor && (
        <StepsModal pattern={stepsFor} shifts={shifts}
          onClose={() => setStepsFor(null)} onSaved={() => { setStepsFor(null); refetch(); }} />
      )}
    </>
  );
}

function StepsModal({ pattern, shifts, onClose, onSaved }) {
  const whShifts = useMemo(
    () => shifts.filter(s => String(s.warehouse) === String(pattern.warehouse)),
    [shifts, pattern.warehouse]);
  const [steps, setSteps] = useState(
    () => (pattern.steps || []).map(s => ({ shift: String(s.shift), weekly_off_days: s.weekly_off_days || [] })));
  const [saving, setSaving] = useState(false);

  const addStep = () => setSteps(p => [...p, { shift: whShifts[0]?.id ? String(whShifts[0].id) : '', weekly_off_days: [] }]);
  const removeStep = (i) => setSteps(p => p.filter((_, idx) => idx !== i));
  const setStepShift = (i, shift) => setSteps(p => p.map((s, idx) => idx === i ? { ...s, shift } : s));
  const toggleOff = (i, day) => setSteps(p => p.map((s, idx) => {
    if (idx !== i) return s;
    const has = s.weekly_off_days.includes(day);
    return { ...s, weekly_off_days: has ? s.weekly_off_days.filter(d => d !== day) : [...s.weekly_off_days, day] };
  }));

  const save = async () => {
    const clean = steps.filter(s => s.shift);
    if (!clean.length) { toast.error('Add at least one shift step.'); return; }
    setSaving(true);
    try {
      await apiClient.post(`/api/hr/rotation-patterns/${pattern.id}/set-steps/`, { steps: clean });
      toast.success('Rotation steps saved.');
      onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save steps.');
    } finally { setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Steps — ${pattern.name}`} size="lg"
      footer={(
        <>
          <button onClick={onClose} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Steps'}
          </button>
        </>
      )}>
      {whShifts.length === 0 && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          This pattern's warehouse has no shifts defined yet. Create shifts under HR → Shifts first.
        </div>
      )}
      <div className="space-y-2">
        {steps.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 p-2.5 border border-slate-200 rounded-lg bg-slate-50/60">
            <span className="w-6 h-6 flex items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">{i + 1}</span>
            <div className="w-48">
              <CustomSelect value={s.shift} onChange={(e) => setStepShift(i, e.target.value)} className="input">
                <option value="">Select shift…</option>
                {whShifts.map(sh => <option key={sh.id} value={String(sh.id)}>{sh.shift_code} — {sh.shift_name}</option>)}
              </CustomSelect>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-xs text-slate-400 mr-1">Off:</span>
              {DAYS.map(d => (
                <button key={d} type="button" onClick={() => toggleOff(i, d)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                    s.weekly_off_days.includes(d)
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
                  {d}
                </button>
              ))}
            </div>
            <button onClick={() => removeStep(i)} className="ml-auto p-1 text-red-400 hover:text-red-600" title="Remove step">
              <X size={15} />
            </button>
          </div>
        ))}
        <button onClick={addStep} disabled={whShifts.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-dashed border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          <Plus size={14} /> Add step
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Steps rotate in order, each lasting {pattern.step_length_days} day(s). Leave “Off” blank to inherit the shift's own weekly-off days.
      </p>
    </Modal>
  );
}

/* ───────────────────────── Assignments ───────────────────────── */

function AssignmentsTab({ assignments, patterns, staffList, warehouses, canCreate, canDelete }) {
  const { data, isLoading, error, refetch } = assignments;
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ staff: '', pattern: '', anchor_date: todayISO(), end_date: '' });
  const [saving, setSaving] = useState(false);

  // Resolve tool
  const [resolveStaff, setResolveStaff] = useState('');
  const [resolveDate, setResolveDate] = useState(todayISO());
  const [resolved, setResolved] = useState(null);
  const [resolving, setResolving] = useState(false);

  const createAssignment = async () => {
    if (!form.staff || !form.pattern) { toast.error('Pick a staff member and a pattern.'); return; }
    if (!form.anchor_date) { toast.error('Pick an anchor date.'); return; }
    setSaving(true);
    try {
      await apiClient.post('/api/hr/rotation-assignments/', {
        staff: form.staff, pattern: form.pattern,
        anchor_date: form.anchor_date, end_date: form.end_date || null,
      });
      toast.success('Staff assigned to rotation.');
      setShowNew(false);
      setForm({ staff: '', pattern: '', anchor_date: todayISO(), end_date: '' });
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to assign.');
    } finally { setSaving(false); }
  };

  const removeAssignment = async (row) => {
    if (!(await confirm({ message: `Remove ${row.staff_name} from "${row.pattern_name}"?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/hr/rotation-assignments/${row.id}/`);
      toast.success('Assignment removed.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to remove.');
    }
  };

  const runResolve = async () => {
    if (!resolveStaff) { toast.error('Pick a staff member.'); return; }
    setResolving(true); setResolved(null);
    try {
      const res = await apiClient.get('/api/hr/rotation-assignments/resolve/', {
        params: { staff: resolveStaff, date: resolveDate },
      });
      setResolved(res.data);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to resolve.');
    } finally { setResolving(false); }
  };

  const columns = [
    { field: 'staff_name', header: 'Employee', sortable: true, width: '190px',
      render: (v, row) => (
        <div>
          <p className="font-medium text-slate-800">{v || '-'}</p>
          <p className="text-xs text-slate-400 font-mono">{row.staff_id_display}</p>
        </div>
      ) },
    { field: 'pattern_name', header: 'Pattern', sortable: true, width: '200px', render: (v) => v || '-' },
    { field: 'anchor_date', header: 'Starts', sortable: true, width: '120px', render: (v) => v ? formatDate(v) : '-' },
    { field: 'end_date', header: 'Ends', sortable: true, width: '120px',
      render: (v) => v ? formatDate(v) : <span className="text-slate-400 text-xs">Open</span> },
    ...(canDelete ? [{
      field: 'actions', header: '', sortable: false, width: '60px',
      render: (_, row) => (
        <button onClick={(e) => { e.stopPropagation(); removeAssignment(row); }}
          className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Remove">
          <Trash2 size={15} />
        </button>
      ) }] : []),
  ];

  return (
    <>
      {/* Resolve tool */}
      <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium text-slate-700">
          <CalendarClock size={16} className="text-slate-500" /> Which shift on a date?
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <label className="block text-xs font-medium text-slate-500 mb-1">Employee</label>
            <CustomSelect value={resolveStaff} onChange={(e) => setResolveStaff(e.target.value)} className="input">
              <option value="">Select…</option>
              {staffList.map(s => <option key={s.id} value={s.id}>{s.staff_id} — {s.full_name}</option>)}
            </CustomSelect>
          </div>
          <div className="w-44">
            <label className="block text-xs font-medium text-slate-500 mb-1">Date</label>
            <CustomDatePicker value={resolveDate} onChange={(e) => setResolveDate(e.target.value)} className="input" />
          </div>
          <button onClick={runResolve} disabled={resolving}
            className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-white disabled:opacity-50">
            {resolving ? 'Resolving…' : 'Resolve'}
          </button>
          {resolved && (
            <div className="flex items-center gap-3 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm">
              {resolved.shift_code ? (
                <>
                  <span className="font-semibold text-slate-800">{resolved.shift_code}</span>
                  <span className="text-slate-500">{resolved.shift_name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${resolved.source === 'ROTATION' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600'}`}>
                    {resolved.source === 'ROTATION' ? `Rotation${resolved.pattern ? `: ${resolved.pattern}` : ''}` : 'Fixed shift'}
                  </span>
                  {resolved.is_weekly_off && <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">Weekly off</span>}
                </>
              ) : (
                <span className="text-slate-400">No shift assigned for this employee.</span>
              )}
            </div>
          )}
        </div>
      </div>

      {canCreate && (
        <div className="flex justify-end mb-3">
          <button onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
            <Plus size={16} /> Assign Staff
          </button>
        </div>
      )}

      <ListState error={error} onRetry={refetch}>
        <DataTable
          exportFileName="rotation-assignments" columns={columns} data={data || []} isLoading={isLoading}
          emptyMessage="No staff assigned to a rotation yet"
          emptyHint="Assign an employee to a pattern with a start date — their shift is then resolved per day." />
      </ListState>

      <Modal isOpen={showNew} onClose={() => setShowNew(false)} title="Assign Staff to Rotation" size="md"
        footer={(
          <>
            <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50">Cancel</button>
            <button onClick={createAssignment} disabled={saving}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
              {saving ? 'Assigning…' : 'Assign'}
            </button>
          </>
        )}>
        <div className="space-y-3">
          <Field label="Employee" required>
            <CustomSelect value={form.staff} onChange={(e) => setForm(p => ({ ...p, staff: e.target.value }))} className="input">
              <option value="">Select employee…</option>
              {staffList.map(s => <option key={s.id} value={s.id}>{s.staff_id} — {s.full_name}</option>)}
            </CustomSelect>
          </Field>
          <Field label="Rotation pattern" required>
            <CustomSelect value={form.pattern} onChange={(e) => setForm(p => ({ ...p, pattern: e.target.value }))} className="input">
              <option value="">Select pattern…</option>
              {patterns.map(p => <option key={p.id} value={p.id}>{p.name} ({p.step_count} steps)</option>)}
            </CustomSelect>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cycle start (anchor)" required>
              <CustomDatePicker value={form.anchor_date} onChange={(e) => setForm(p => ({ ...p, anchor_date: e.target.value }))} className="input" />
            </Field>
            <Field label="End date">
              <CustomDatePicker value={form.end_date} onChange={(e) => setForm(p => ({ ...p, end_date: e.target.value }))} className="input" />
            </Field>
          </div>
          <p className="text-xs text-slate-400">Step 0 of the pattern applies on the anchor date, advancing every step length.</p>
        </div>
      </Modal>
    </>
  );
}

/* ───────────────────────── shared bits ───────────────────────── */

function TabBtn({ active, onClick, icon: Icon, label, count }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
        active ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
      <Icon size={15} /> {label}
      <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-primary-100 text-primary-700' : 'bg-slate-100 text-slate-500'}`}>{count}</span>
    </button>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
    </div>
  );
}
