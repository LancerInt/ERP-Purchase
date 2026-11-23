import { useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import Modal from '@/components/ui/Modal';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import toast from 'react-hot-toast';
import { Plus, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';

const today = () => new Date().toISOString().slice(0, 10);

export default function ConsumablesPage() {
  const { canCreate } = usePermissions();
  const items = useApiData('/api/expenses/consumables/');
  const movements = useApiData('/api/expenses/consumable-movements/');

  const [itemModal, setItemModal] = useState(false);
  const [moveModal, setMoveModal] = useState(null); // 'IN' | 'OUT'
  const [saving, setSaving] = useState(false);
  const [itemForm, setItemForm] = useState({ name: '', uom: 'NOS', reorder_level: '', notes: '' });
  const [moveForm, setMoveForm] = useState({ item: '', movement_date: today(), quantity: '', unit_cost: '', reference: '' });

  const openMove = (type) => { setMoveForm({ item: items.data?.[0]?.id || '', movement_date: today(), quantity: '', unit_cost: '', reference: '' }); setMoveModal(type); };

  const saveItem = async () => {
    if (!itemForm.name.trim()) { toast.error('Item name is required'); return; }
    setSaving(true);
    try {
      await apiClient.post('/api/expenses/consumables/', {
        name: itemForm.name.trim(), uom: itemForm.uom || 'NOS',
        reorder_level: itemForm.reorder_level || 0, notes: itemForm.notes,
      });
      toast.success('Item created');
      setItemModal(false);
      setItemForm({ name: '', uom: 'NOS', reorder_level: '', notes: '' });
      items.refetch();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setSaving(false); }
  };

  const saveMove = async () => {
    if (!moveForm.item) { toast.error('Select an item'); return; }
    if (!(Number(moveForm.quantity) > 0)) { toast.error('Enter a quantity'); return; }
    setSaving(true);
    try {
      await apiClient.post('/api/expenses/consumable-movements/', {
        item: moveForm.item,
        movement_type: moveModal,
        movement_date: moveForm.movement_date,
        quantity: moveForm.quantity,
        unit_cost: moveModal === 'IN' ? (moveForm.unit_cost || 0) : 0,
        reference: moveForm.reference,
      });
      toast.success(moveModal === 'IN' ? 'Stock added' : 'Usage recorded');
      setMoveModal(null);
      items.refetch(); movements.refetch();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setSaving(false); }
  };

  const itemColumns = [
    { key: 'name', label: 'Consumable' },
    { key: 'uom', label: 'UOM' },
    { key: 'current_stock', label: 'In Stock', render: (v, row) => (
      <span className={`font-medium ${row.is_low ? 'text-red-600' : 'text-slate-800'}`}>{Number(v)} {row.is_low && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-red-100 text-red-700">LOW</span>}</span>
    ) },
    { key: 'unit_cost', label: 'Unit Cost', render: (v) => formatCurrency(v) },
    { key: 'reorder_level', label: 'Reorder At', render: (v) => Number(v) || '—' },
  ];

  const moveColumns = [
    { key: 'movement_date', label: 'Date', render: (v) => formatDate(v) },
    { key: 'item_name', label: 'Consumable' },
    { key: 'movement_type_display', label: 'Type', render: (v, row) => (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${row.movement_type === 'IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{v}</span>
    ) },
    { key: 'quantity', label: 'Qty', render: (v, row) => `${Number(v)} ${row.item_uom || ''}` },
    { key: 'unit_cost', label: 'Unit Cost', render: (v) => Number(v) ? formatCurrency(v) : '—' },
    { key: 'reference', label: 'Reference', render: (v) => v || '—' },
    { key: 'created_by_name', label: 'By', render: (v) => v || '—' },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Consumables"
        subtitle="Consumable stock — buy adds, usage reduces"
        breadcrumbs={[{ label: 'Expenses' }, { label: 'Consumables' }]}
        actions={{
          right: canCreate('Consumables') ? (
            <div className="flex items-center gap-2">
              <button onClick={() => openMove('OUT')} className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50"><ArrowUpCircle size={15} /> Record Usage</button>
              <button onClick={() => openMove('IN')} className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50"><ArrowDownCircle size={15} /> Stock In</button>
              <button onClick={() => setItemModal(true)} className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700"><Plus size={15} /> New Item</button>
            </div>
          ) : null,
        }}
      />

      <DataTable columns={itemColumns} data={items.data || []} isLoading={items.isLoading} exportFileName="consumables" />

      <h3 className="text-sm font-semibold text-slate-700 mt-4 mb-2">Recent movements</h3>
      <DataTable columns={moveColumns} data={movements.data || []} isLoading={movements.isLoading} exportFileName="consumable-movements" />

      {/* New Item modal */}
      <Modal isOpen={itemModal} onClose={() => setItemModal(false)} title="New Consumable" footer={
        <>
          <button onClick={() => setItemModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
          <button onClick={saveItem} disabled={saving} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? 'Saving…' : 'Create'}</button>
        </>
      }>
        <div className="space-y-4">
          <Field label="Name" required><input value={itemForm.name} onChange={(e) => setItemForm((p) => ({ ...p, name: e.target.value }))} className={inputCls} placeholder="e.g. Cotton waste" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="UOM"><input value={itemForm.uom} onChange={(e) => setItemForm((p) => ({ ...p, uom: e.target.value }))} className={inputCls} placeholder="NOS / KG / LTR" /></Field>
            <Field label="Reorder level"><input type="number" step="0.001" value={itemForm.reorder_level} onChange={(e) => setItemForm((p) => ({ ...p, reorder_level: e.target.value }))} className={inputCls} placeholder="0" /></Field>
          </div>
          <Field label="Notes"><input value={itemForm.notes} onChange={(e) => setItemForm((p) => ({ ...p, notes: e.target.value }))} className={inputCls} /></Field>
          <p className="text-xs text-slate-400">Stock starts at 0 — add stock with “Stock In”, or it fills automatically when you tag an Expense Register item as stock.</p>
        </div>
      </Modal>

      {/* Movement modal */}
      <Modal isOpen={!!moveModal} onClose={() => setMoveModal(null)} title={moveModal === 'IN' ? 'Stock In' : 'Record Usage'} footer={
        <>
          <button onClick={() => setMoveModal(null)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
          <button onClick={saveMove} disabled={saving} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </>
      }>
        <div className="space-y-4">
          <Field label="Consumable" required>
            <CustomSelect name="item" value={moveForm.item} onChange={(e) => setMoveForm((p) => ({ ...p, item: e.target.value }))} className={selectCls}>
              <option value="">Select item…</option>
              {(items.data || []).map((c) => <option key={c.id} value={c.id}>{c.name} — {Number(c.current_stock)} {c.uom}</option>)}
            </CustomSelect>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><CustomDatePicker value={moveForm.movement_date} onChange={(d) => setMoveForm((p) => ({ ...p, movement_date: d }))} /></Field>
            <Field label="Quantity" required><input type="number" step="0.001" value={moveForm.quantity} onChange={(e) => setMoveForm((p) => ({ ...p, quantity: e.target.value }))} className={inputCls} placeholder="0" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {moveModal === 'IN' && <Field label="Unit cost"><input type="number" step="0.01" value={moveForm.unit_cost} onChange={(e) => setMoveForm((p) => ({ ...p, unit_cost: e.target.value }))} className={inputCls} placeholder="0.00" /></Field>}
            <Field label="Reference"><input value={moveForm.reference} onChange={(e) => setMoveForm((p) => ({ ...p, reference: e.target.value }))} className={inputCls} placeholder={moveModal === 'IN' ? 'Bill / source' : 'Used for…'} /></Field>
          </div>
        </div>
      </Modal>
    </MainLayout>
  );
}

const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const selectCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white';

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}{required && <span className="text-red-500"> *</span>}</label>
      {children}
    </div>
  );
}
