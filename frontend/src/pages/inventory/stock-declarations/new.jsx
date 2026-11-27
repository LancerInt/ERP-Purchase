import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import CreatableSelect from '@/components/ui/CreatableSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import { UOM_OPTIONS } from '../../../constants/uom.js';

export default function NewStockDeclaration() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState('');

  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: warehouseOptions } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}&scope=true` : null
  );
  const { raw: productsRaw } = useLookup('/api/products/');

  const [formData, setFormData] = useState({
    product: '',
    product_name: '',
    specification: '',
    quantity: '',
    uom: 'KG',
    warehouse: '',
    godown: '',
  });

  const { options: godownOptions } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null
  );

  const allProducts = useMemo(() => productsRaw || [], [productsRaw]);

  const productLabels = useMemo(() =>
    allProducts.map(p => `${p.sku_code ? p.sku_code + ' — ' : ''}${p.product_name}`),
    [allProducts]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleCompanyChange = (e) => {
    setSelectedCompany(e.target.value);
    setFormData((prev) => ({ ...prev, warehouse: '', godown: '', product: '', product_name: '' }));
  };

  const handleWarehouseChange = (e) => {
    setFormData((prev) => ({ ...prev, warehouse: e.target.value, godown: '', product: '', product_name: '' }));
  };

  const handleProductChange = (e) => {
    const val = e.target.value;
    const matched = allProducts.find(p => {
      const label = `${p.sku_code ? p.sku_code + ' — ' : ''}${p.product_name}`;
      return label === val;
    });
    if (matched) {
      setFormData((prev) => ({
        ...prev,
        product: matched.id,
        product_name: matched.product_name,
        uom: matched.uom || prev.uom,
      }));
    } else {
      setFormData((prev) => ({ ...prev, product: '', product_name: val }));
    }
  };

  const isNewProduct = !formData.product && formData.product_name.trim() !== '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    const name = formData.product_name.trim();
    if (!name) { toast.error('Product name is required'); return; }
    if (!formData.quantity || Number(formData.quantity) <= 0) { toast.error('Enter a valid quantity'); return; }
    if (!formData.warehouse) { toast.error('Select a warehouse'); return; }

    setSaving(true);
    try {
      const payload = {
        product_name: name,
        specification: formData.specification,
        quantity: formData.quantity,
        uom: formData.uom,
        warehouse: formData.warehouse,
        ...(formData.godown ? { godown: formData.godown } : {}),
      };
      if (formData.product) {
        payload.product = formData.product;
      }
      await apiClient.post('/api/inventory/stock-declarations/', payload);
      toast.success('Stock declaration submitted for approval');
      navigate('/inventory/stock-declarations');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const matchedProd = formData.product ? allProducts.find(p => p.id === formData.product) : null;
  const displayValue = matchedProd
    ? `${matchedProd.sku_code ? matchedProd.sku_code + ' — ' : ''}${formData.product_name}`
    : formData.product_name;

  const inputClass = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-200 focus:border-primary-400 transition';

  return (
    <MainLayout>
      <PageHeader
        title="Opening Stock Declaration"
        hideCompanyFilter
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Stock Declarations', href: '/inventory/stock-declarations' },
          { label: 'New' },
        ]}
      />

      <form onSubmit={handleSubmit} className="space-y-3 px-1">
        <div className="grid grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-0.5">Company <span className="text-red-500">*</span></label>
            <CustomSelect name="company" value={selectedCompany} onChange={handleCompanyChange}>
              <option value="">Select company</option>
              {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-0.5">Warehouse <span className="text-red-500">*</span></label>
            <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleWarehouseChange}>
              <option value="">{selectedCompany ? 'Select warehouse' : 'Select company first'}</option>
              {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-0.5">Godown</label>
            <CustomSelect name="godown" value={formData.godown} onChange={handleChange}>
              <option value="">{formData.warehouse ? 'Select godown' : 'Select warehouse first'}</option>
              {godownOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-0.5">
              Product <span className="text-red-500">*</span>
              {isNewProduct && (
                <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full">New</span>
              )}
            </label>
            <CreatableSelect
              name="product_name"
              value={displayValue}
              onChange={handleProductChange}
              options={productLabels}
              placeholder="Search product or type new name..."
            />
          </div>
        </div>

        <div className="grid grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-0.5">Quantity <span className="text-red-500">*</span></label>
            <input
              name="quantity"
              type="number"
              step="0.001"
              min="0"
              value={formData.quantity}
              onChange={handleChange}
              placeholder="0.000"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-0.5">UOM</label>
            <CustomSelect name="uom" value={formData.uom} onChange={handleChange}>
              <option value="">Select UOM</option>
              {UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div className="col-span-3">
            <label className="block text-xs font-medium text-slate-600 mb-0.5">Specification</label>
            <input
              name="specification"
              value={formData.specification}
              onChange={handleChange}
              placeholder="Size, grade, material..."
              className={inputClass}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => navigate('/inventory/stock-declarations')}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 text-xs font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition disabled:opacity-50"
          >
            {saving ? 'Submitting...' : 'Submit Declaration'}
          </button>
        </div>
      </form>
    </MainLayout>
  );
}
