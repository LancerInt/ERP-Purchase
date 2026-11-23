// Vendor type keys — must match Vendor.VENDOR_TYPE_CHOICES on the backend
// (master/models.py). Shared by the create (new.jsx) and edit ([id]/edit.jsx)
// forms so both offer exactly the same options and the saved value round-trips.
export const VENDOR_TYPE_OPTIONS = [
  { value: 'RAW_MATERIAL', label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'EXPENSE', label: 'Expense' },
  { value: 'TRANSPORTER', label: 'Transporter' },
  { value: 'CONTRACTOR', label: 'Contractor' },
  // An individual we pay who isn't a trade supplier — a salaried employee or a
  // one-off bank-statement payee. Salary/expense bank lines record against one
  // of these (booked as an Expense), instead of a fake vendor.
  { value: 'EMPLOYEE', label: 'Employee / Payee' },
];
