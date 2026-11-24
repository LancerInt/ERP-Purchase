import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigationType, useParams, useNavigate } from 'react-router-dom';
import SwipeToaster from './components/common/SwipeToaster.jsx';
import GlobalTooltip from './components/common/GlobalTooltip.jsx';
import { ConfirmHost } from './components/common/confirm.jsx';
import { PartyLinkPickerHost } from './components/common/partyLinkPicker.jsx';
import { PromptHost } from './components/common/prompt.jsx';
import ErrorBoundary from './components/common/ErrorBoundary.jsx';
import NotFound from './pages/NotFound.jsx';
import BankPWA from './pages/bank/BankPWA.jsx';

// Scroll to top when you go somewhere NEW — never when you go BACK.
//
// This used to fire on every pathname change, Back included. So opening an
// invoice from a table half way down the Sales Analytics page and pressing
// Back put you at the top, with the row you had been reading somewhere below.
// Nothing the page itself did could survive it: this effect ran afterwards
// and overrode the restored position.
//
// `useNavigationType()` tells the two apart. POP is the browser's Back and
// Forward, and a browser restoring its own scroll position is the behaviour
// users already expect from every other site — so leave it alone. PUSH and
// REPLACE are a genuinely new destination, where starting at the top is
// right.
//
// Scroll presentation only: no route, no destination, no history entry and no
// data is affected, and every page still opens at the top when opened fresh.
function ScrollToTop() {
  const { pathname } = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    if (navType === 'POP') return;
    window.scrollTo(0, 0);
  }, [pathname, navType]);
  return null;
}

// Legacy /sales/freight/:id and /sales/freight/:id/edit paths route to the
// unified freight detail at /freight/sales/:id (no edit route exists).
function SalesFreightRedirect() {
  const { id } = useParams();
  return <Navigate to={`/freight/sales/${id}`} replace />;
}

// Loading fallback
const Loading = () => <div className="flex items-center justify-center min-h-dvh"><div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin"></div></div>;

// Permission-protected route wrapper
import ProtectedRoute from './components/common/ProtectedRoute';
import { useSelector } from 'react-redux';
import usePermissions from './hooks/usePermissions.js';
import { getLandingPath } from './constants/navigation.js';
const ModuleLanding = lazy(() => import('./pages/ModuleLanding.jsx'));

// Post-login landing: drop each user on their role's primary MODULE
// page (a tile grid of that module's submodules) rather than straight
// into one submodule, so they pick where to go. Warehouse roles land on
// the Purchase module, Sales roles on Sales, IT Admin on Admin, etc.
function RoleLanding() {
  const isAuthenticated = useSelector((s) => !!s.auth?.token);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <ModuleLanding />;
}

// Auth
import Login from './pages/login.jsx';

// Profile
const ProfilePage = lazy(() => import('./pages/profile/index.jsx'));
const NotificationsPage = lazy(() => import('./pages/notifications/index.jsx'));


// Masters - List
const CompanyList = lazy(() => import('./pages/masters/company/index.jsx'));
const WarehouseList = lazy(() => import('./pages/masters/warehouse/index.jsx'));
const GodownList = lazy(() => import('./pages/masters/godown/index.jsx'));
const MachineryDivisionList = lazy(() => import('./pages/masters/machinery-division/index.jsx'));
const MachineryExpenseList = lazy(() => import('./pages/masters/machinery-expense/index.jsx'));
const ProductList = lazy(() => import('./pages/masters/products/index.jsx'));
const VendorList = lazy(() => import('./pages/masters/vendor/index.jsx'));
const CustomerList = lazy(() => import('./pages/masters/customer/index.jsx'));
const TransporterList = lazy(() => import('./pages/masters/transporter/index.jsx'));
const PriceListPage = lazy(() => import('./pages/masters/price-list/index.jsx'));
const TaxMasterList = lazy(() => import('./pages/masters/tax/index.jsx'));
const StateGroupList = lazy(() => import('./pages/masters/state-group/index.jsx'));
const StateGroupNew = lazy(() => import('./pages/masters/state-group/new.jsx'));
const StateGroupEdit = lazy(() => import('./pages/masters/state-group/[id].jsx'));
const TemplateList = lazy(() => import('./pages/masters/templates/index.jsx'));
const ServiceCatalogueList = lazy(() => import('./pages/masters/service-catalogue/index.jsx'));
const RoleList = lazy(() => import('./pages/masters/roles/index.jsx'));
const UserList = lazy(() => import('./pages/masters/users/index.jsx'));
// Masters - Forms
const CompanyNew = lazy(() => import('./pages/masters/company/new.jsx'));
const CompanyEdit = lazy(() => import('./pages/masters/company/[id].jsx'));
const WarehouseNew = lazy(() => import('./pages/masters/warehouse/new.jsx'));
const WarehouseDetail = lazy(() => import('./pages/masters/warehouse/[id].jsx'));
const GodownNew = lazy(() => import('./pages/masters/godown/new.jsx'));
const GodownEdit = lazy(() => import('./pages/masters/godown/[id].jsx'));
const MachineryDivisionNew = lazy(() => import('./pages/masters/machinery-division/new.jsx'));
const MachineryDivisionEdit = lazy(() => import('./pages/masters/machinery-division/[id].jsx'));
const MachineryExpenseNew = lazy(() => import('./pages/masters/machinery-expense/new.jsx'));
const MachineryExpenseEdit = lazy(() => import('./pages/masters/machinery-expense/[id].jsx'));
const ProductNew = lazy(() => import('./pages/masters/products/new.jsx'));
const VendorNew = lazy(() => import('./pages/masters/vendor/new.jsx'));
const VendorEdit = lazy(() => import('./pages/masters/vendor/edit.jsx'));
const BrokerList = lazy(() => import('./pages/masters/broker/index.jsx'));
const BrokerNew = lazy(() => import('./pages/masters/broker/new.jsx'));
const CustomerNew = lazy(() => import('./pages/masters/customer/new.jsx'));
const CustomerEdit = lazy(() => import('./pages/masters/customer/[id].jsx'));
const TransporterNew = lazy(() => import('./pages/masters/transporter/new.jsx'));
const TransporterEdit = lazy(() => import('./pages/masters/transporter/[id].jsx'));
const PriceListNew = lazy(() => import('./pages/masters/price-list/new.jsx'));
const PriceListEdit = lazy(() => import('./pages/masters/price-list/[id].jsx'));
const TaxNew = lazy(() => import('./pages/masters/tax/new.jsx'));
const TaxEdit = lazy(() => import('./pages/masters/tax/[id].jsx'));
const TemplateNew = lazy(() => import('./pages/masters/templates/new.jsx'));
const TemplateEdit = lazy(() => import('./pages/masters/templates/[id].jsx'));
const ServiceCatalogueNew = lazy(() => import('./pages/masters/service-catalogue/new.jsx'));
const ServiceCatalogueEdit = lazy(() => import('./pages/masters/service-catalogue/[id].jsx'));
const RoleNew = lazy(() => import('./pages/masters/roles/new.jsx'));
const UserNew = lazy(() => import('./pages/masters/users/new.jsx'));

// Purchase - List
const PurchaseRequests = lazy(() => import('./pages/purchase/requests/index.jsx'));
const PurchaseRequestDetail = lazy(() => import('./pages/purchase/requests/detail.jsx'));
const RFQList = lazy(() => import('./pages/purchase/rfq/index.jsx'));
const RFQDetail = lazy(() => import('./pages/purchase/rfq/detail.jsx'));
const RFQDocument = lazy(() => import('./pages/purchase/rfq/document.jsx'));
const QuoteList = lazy(() => import('./pages/purchase/quotes/index.jsx'));
const QuoteResponseDetail = lazy(() => import('./pages/purchase/quotes/detail.jsx'));
const EvaluationList = lazy(() => import('./pages/purchase/evaluations/index.jsx'));
const PurchaseOrders = lazy(() => import('./pages/purchase/orders/index.jsx'));
const PurchaseOrderDetail = lazy(() => import('./pages/purchase/orders/[id].jsx'));
const SendPOEmail = lazy(() => import('./pages/purchase/orders/send-email.jsx'));
const PurchaseOrderDocument = lazy(() => import('./pages/purchase/orders/document.jsx'));
const ReceiptList = lazy(() => import('./pages/purchase/receipts/index.jsx'));
// Purchase - Forms
const PurchaseRequestNew = lazy(() => import('./pages/purchase/requests/new.jsx'));
const RFQNew = lazy(() => import('./pages/purchase/rfq/new.jsx'));
const QuoteNew = lazy(() => import('./pages/purchase/quotes/new.jsx'));
const EvaluationNew = lazy(() => import('./pages/purchase/evaluations/new.jsx'));
const EvaluationDetail = lazy(() => import('./pages/purchase/evaluations/[id].jsx'));
// EvaluationDashboard merged into EvaluationList (index.jsx) as a tab
const PurchaseLifecycleDashboard = lazy(() => import('./pages/purchase/lifecycle/index.jsx'));
const PurchaseDashboard = lazy(() => import('./pages/purchase/dashboard/index.jsx'));
const PurchaseDashboardOverview = lazy(() => import('./pages/purchase/overview/index.jsx'));
const PurchaseStock = lazy(() => import('./pages/purchase/stock/index.jsx'));
const PurchaseStockDetail = lazy(() => import('./pages/purchase/stock/[id].jsx'));
const PurchaseTdsSummary = lazy(() => import('./pages/purchase/tds/index.jsx'));
const PurchaseTdsReconcile = lazy(() => import('./pages/purchase/tds-reconcile/index.jsx'));
const VendorCustomerReport = lazy(() => import('./pages/reports/vendor-customer/index.jsx'));
const ReportsSummary = lazy(() => import('./pages/reports/summary/index.jsx'));
const TwoWayFreight = lazy(() => import('./pages/freight/two-way/index.jsx'));
const FreightDashboard = lazy(() => import('./pages/freight/dashboard/index.jsx'));
const FreightBills = lazy(() => import('./pages/freight/bills/index.jsx'));
const PurchaseExpenses = lazy(() => import('./pages/purchase/expenses/index.jsx'));
const PurchaseByCategory = lazy(() => import('./pages/purchase/by-category/index.jsx'));
const PurchaseExpenseReconcile = lazy(() => import('./pages/purchase/expense-reconcile/index.jsx'));
const SalesDebtors = lazy(() => import('./pages/sales/debtors/index.jsx'));
const SalesReceipts = lazy(() => import('./pages/sales/receipts/index.jsx'));
// DocumentExtractor merged into Quote Response page
const PurchaseOrderNew = lazy(() => import('./pages/purchase/orders/new.jsx'));
const ReceiptNew = lazy(() => import('./pages/purchase/receipts/new.jsx'));
const ReceiptDetail = lazy(() => import('./pages/purchase/receipts/[id].jsx'));

// Purchase - Bills, Payments Made, Vendor Credits
const VendorBillList = lazy(() => import('./pages/purchase/bills/index.jsx'));
const VendorBillNew = lazy(() => import('./pages/purchase/bills/new.jsx'));
const VendorBillDetail = lazy(() => import('./pages/purchase/bills/[id].jsx'));
const ZohoBillList = lazy(() => import('./pages/purchase/zoho-bills/index.jsx'));
const ZohoPurchaseDashboard = lazy(() => import('./pages/purchase/zoho-dashboard/index.jsx'));
const ZohoPurchaseAnalytics = lazy(() => import('./pages/purchase/zoho-analytics/index.jsx'));
const ScanInbox = lazy(() => import('./pages/purchase/scan/index.jsx'));
const EmailBillInbox = lazy(() => import('./pages/purchase/email-bills/index.jsx'));
const Mappings = lazy(() => import('./pages/purchase/mappings/index.jsx'));
const Gst2B = lazy(() => import('./pages/purchase/gst2b/index.jsx'));
const Gstr1 = lazy(() => import('./pages/sales/gstr1/index.jsx'));
const EwbEinvoiceCheck = lazy(() => import('./pages/sales/ewb-einvoice/index.jsx'));
const MaterialRejectionList = lazy(() => import('./pages/purchase/rejections/index.jsx'));
const MaterialRejectionNew = lazy(() => import('./pages/purchase/rejections/new.jsx'));
const MaterialRejectionDetail = lazy(() => import('./pages/purchase/rejections/[id].jsx'));
const PaymentsMadeList = lazy(() => import('./pages/purchase/payments-made/index.jsx'));
const PaymentEntries = lazy(() => import('./pages/purchase/payment-entries/index.jsx'));
const PaymentsMadeNew = lazy(() => import('./pages/purchase/payments-made/new.jsx'));
const PaymentsMadeDetail = lazy(() => import('./pages/purchase/payments-made/[id].jsx'));
const ImportBankStatements = lazy(() => import('./pages/purchase/payments-made/import/index.jsx'));
const ReconcilePayments = lazy(() => import('./pages/purchase/payments-made/reconcile/index.jsx'));
// ImportLedger (old triage page) retired — its Inbox + Pending tabs now live in Scan Inbox.
const SalesTallyImport = lazy(() => import('./pages/import-data/sales-tally/index.jsx'));
const PurchaseTallyImport = lazy(() => import('./pages/import-data/purchase-tally/index.jsx'));
const ImportOverview = lazy(() => import('./pages/import-data/overview/index.jsx'));
const PayablesOverview = lazy(() => import('./pages/purchase/payables-overview/index.jsx'));
const VendorCreditList = lazy(() => import('./pages/purchase/vendor-credits/index.jsx'));
const VendorDuesPage = lazy(() => import('./pages/purchase/vendor-dues/index.jsx'));
const VendorCreditNew = lazy(() => import('./pages/purchase/vendor-credits/new.jsx'));
const VendorCreditDetail = lazy(() => import('./pages/purchase/vendor-credits/[id].jsx'));

// Unified Freight
const UnifiedFreightList = lazy(() => import('./pages/freight/index.jsx'));
const UnifiedFreightCreate = lazy(() => import('./pages/freight/new.jsx'));
const LocalFreightList = lazy(() => import('./pages/freight/local/index.jsx'));
const LocalFreightCreate = lazy(() => import('./pages/freight/local/new.jsx'));
const LocalFreightDetail = lazy(() => import('./pages/freight/local/[id].jsx'));
const LorryFreightReview = lazy(() => import('./pages/freight/lorry-review/index.jsx'));
const FreightPaymentList = lazy(() => import('./pages/freight/payments/index.jsx'));
const FreightPaymentCreate = lazy(() => import('./pages/freight/payments/new.jsx'));
const PayeeMappings = lazy(() => import('./pages/freight/payee-mappings/index.jsx'));
const WageEntryList = lazy(() => import('./pages/freight/wages/index.jsx'));
const WageEntryCreate = lazy(() => import('./pages/freight/wages/new.jsx'));
const WageEntryDetail = lazy(() => import('./pages/freight/wages/[id].jsx'));
const WagePaymentList = lazy(() => import('./pages/freight/wages/payments/index.jsx'));
const WagePaymentCreate = lazy(() => import('./pages/freight/wages/payments/new.jsx'));
const WagePaymentDetail = lazy(() => import('./pages/freight/wages/payments/[id].jsx'));
const UnifiedFreightDetail = lazy(() => import('./pages/freight/[id].jsx'));

// Sales - List
const CustomerPO = lazy(() => import('./pages/sales/customer-po/index.jsx'));
const SalesQuotes = lazy(() => import('./pages/sales/quotes/index.jsx'));
const SalesQuoteNew = lazy(() => import('./pages/sales/quotes/new.jsx'));
const SalesQuoteDetail = lazy(() => import('./pages/sales/quotes/[id].jsx'));
const QuoteDocument = lazy(() => import('./pages/sales/quotes/document.jsx'));
const SendQuoteEmail = lazy(() => import('./pages/sales/quotes/send-email.jsx'));

// Expenses
const ImprestPage = lazy(() => import('./pages/expenses/imprest/index.jsx'));
const VoucherPage = lazy(() => import('./pages/expenses/voucher/index.jsx'));
const ExpenseAnalyticsPage = lazy(() => import('./pages/expenses/dashboard/index.jsx'));
const ExpenseRegisterPage = lazy(() => import('./pages/expenses/register/index.jsx'));
const SpendByCategoryPage = lazy(() => import('./pages/expenses/spend-by-category/index.jsx'));
const ConsumablesPage = lazy(() => import('./pages/expenses/consumables/index.jsx'));
const ExpenseBillsPage = lazy(() => import('./pages/expenses/bills/index.jsx'));
const SalesOrders = lazy(() => import('./pages/sales/orders/index.jsx'));
const DispatchChallan = lazy(() => import('./pages/sales/dc/index.jsx'));
const SalesInvoice = lazy(() => import('./pages/sales/invoices/index.jsx'));
const DebitNotes = lazy(() => import('./pages/sales/debit-notes/index.jsx'));
const DebitNoteDetail = lazy(() => import('./pages/sales/debit-notes/[id].jsx'));
const SalesFlowDashboard = lazy(() => import('./pages/sales/flow/index.jsx'));
const Receivables = lazy(() => import('./pages/sales/receivables/index.jsx'));
const SalesDashboard = lazy(() => import('./pages/sales/dashboard/index.jsx'));
const SalesLedger = lazy(() => import('./pages/sales/ledger/index.jsx'));
const SalesTds = lazy(() => import('./pages/sales/tds/index.jsx'));
const SalesDashboardOverview = lazy(() => import('./pages/sales/overview/index.jsx'));
const CustomerInsights = lazy(() => import('./pages/sales/customer-insights/CustomerInsights.jsx'));
const Customer360List = lazy(() => import('./pages/sales/customer-360/index.jsx'));
const Customer360Detail = lazy(() => import('./pages/sales/customer-360/[id].jsx'));
const Company360List = lazy(() => import('./pages/sales/company-360/index.jsx'));
const Company360Detail = lazy(() => import('./pages/sales/company-360/[id].jsx'));
const VendorInsights = lazy(() => import('./pages/purchase/vendor-insights/VendorInsights.jsx'));
// Sales - Forms
const CustomerPONew = lazy(() => import('./pages/sales/customer-po/new.jsx'));
const CustomerPODetail = lazy(() => import('./pages/sales/customer-po/[id].jsx'));
const CustomerPOEdit = lazy(() => import('./pages/sales/customer-po/edit.jsx'));
const CustomerPOInbox = lazy(() => import('./pages/sales/customer-po/inbox.jsx'));
const CustomerPOBulkUpload = lazy(() => import('./pages/sales/customer-po/bulk.jsx'));
const SalesOrderNew = lazy(() => import('./pages/sales/orders/new.jsx'));
const MultiPoSalesOrder = lazy(() => import('./pages/sales/orders/multi-po/index.jsx'));
const SalesOrderDetail = lazy(() => import('./pages/sales/orders/[id].jsx'));
const SalesOrderEdit = lazy(() => import('./pages/sales/orders/edit.jsx'));
const DCNew = lazy(() => import('./pages/sales/dc/new.jsx'));
const DCDetail = lazy(() => import('./pages/sales/dc/[id].jsx'));
const DCEdit = lazy(() => import('./pages/sales/dc/edit.jsx'));
const InvoiceNew = lazy(() => import('./pages/sales/invoices/new.jsx'));
const InvoiceDetail = lazy(() => import('./pages/sales/invoices/[id].jsx'));
const InvoiceEdit = lazy(() => import('./pages/sales/invoices/edit.jsx'));
const ReceivableNew = lazy(() => import('./pages/sales/receivables/new.jsx'));
const MsmeReceivables = lazy(() => import('./pages/sales/receivables/msme.jsx'));
const ReceivableDetail = lazy(() => import('./pages/sales/receivables/[id].jsx'));
// One receipt, broken down into the invoices it settled. Declared BEFORE
// the :id route so "receipt" is never read as a receivable id.
const ReceivableReceipt = lazy(() => import('./pages/sales/receivables/receipt.jsx'));
const ReceivableEdit = lazy(() => import('./pages/sales/receivables/edit.jsx'));

// Bank
const BankDashboard = lazy(() => import('./pages/bank/dashboard/index.jsx'));
const BankAccountsList = lazy(() => import('./pages/bank/accounts/index.jsx'));
const BankAccountNew = lazy(() => import('./pages/bank/accounts/new.jsx'));
const ReceiptRegister = lazy(() => import('./pages/bank/receipts/index.jsx'));
const BankReceiptNew = lazy(() => import('./pages/bank/receipts/new.jsx'));
const PaymentRegister = lazy(() => import('./pages/bank/payments/index.jsx'));
const BankPaymentNew = lazy(() => import('./pages/bank/payments/new.jsx'));
const OwnAccountTransfers = lazy(() => import('./pages/bank/transfers/index.jsx'));
const BankTransferDetail = lazy(() => import('./pages/bank/transfers/[id].jsx'));
const ReconcileStatementList = lazy(() => import('./pages/bank/reconcile/index.jsx'));
const ReconcileStatementNew = lazy(() => import('./pages/bank/reconcile/new.jsx'));
const ReconcileStatementReport = lazy(() => import('./pages/bank/reconcile/report.jsx'));
const CustomerAdvancesList = lazy(() => import('./pages/sales/advances/index.jsx'));
const CreateCustomerAdvance = lazy(() => import('./pages/sales/advances/new.jsx'));
const CustomerAdvanceDetail = lazy(() => import('./pages/sales/advances/[id].jsx'));

// Production - List
const BOMList = lazy(() => import('./pages/production/bom/index.jsx'));
const WorkOrders = lazy(() => import('./pages/production/work-orders/index.jsx'));
const WorkOrderDetail = lazy(() => import('./pages/production/work-orders/[id].jsx'));
const ProductionDamageList = lazy(() => import('./pages/production/damage/index.jsx'));
const ProductionDamageNew = lazy(() => import('./pages/production/damage/new.jsx'));
const ProductionDamageDetail = lazy(() => import('./pages/production/damage/[id].jsx'));
const WageVouchers = lazy(() => import('./pages/production/wage-vouchers/index.jsx'));
const MaterialIssues = lazy(() => import('./pages/production/material-issues/index.jsx'));
const ProcessList = lazy(() => import('./pages/production/processes/index.jsx'));
const ProcessDetail = lazy(() => import('./pages/production/processes/[id].jsx'));
const PackingProcessList = lazy(() => import('./pages/production/packing-processes/index.jsx'));
const PackingProcessDetail = lazy(() => import('./pages/production/packing-processes/[id].jsx'));
// Production - Forms
const BOMNew = lazy(() => import('./pages/production/bom/new.jsx'));
const BOMTemplateDetail = lazy(() => import('./pages/production/bom/[id].jsx'));
const WorkOrderNew = lazy(() => import('./pages/production/work-orders/new.jsx'));
const WageVoucherNew = lazy(() => import('./pages/production/wage-vouchers/new.jsx'));
const WageVoucherDetail = lazy(() => import('./pages/production/wage-vouchers/[id].jsx'));
// Material Issues is now a derived ledger — no create page.
const ProcessNew = lazy(() => import('./pages/production/processes/new.jsx'));
const PackingProcessNew = lazy(() => import('./pages/production/packing-processes/new.jsx'));
// Production - Gate Register (digital DPR truck log)
const GateRegisterList = lazy(() => import('./pages/production/gate-register/index.jsx'));
const GateEntryForm = lazy(() => import('./pages/production/gate-register/new.jsx'));
// Production - Shift Labor daily headcount
const ShiftLaborPage = lazy(() => import('./pages/production/shift-labor/index.jsx'));
// Production - Additional Wages (Lotting / Bundling / Cleaning / …)
const AdditionalWagesList = lazy(() => import('./pages/production/additional-wages/index.jsx'));
const AdditionalWageForm = lazy(() => import('./pages/production/additional-wages/new.jsx'));
const WagesLedgerPage = lazy(() => import('./pages/production/wages-ledger/index.jsx'));
// Production - Unified DPR summary page
const DprPage = lazy(() => import('./pages/production/dpr/index.jsx'));
// Inventory - Production Stock (parallel ledger, Phase C)
const ProductionStockPage = lazy(() => import('./pages/inventory/production-stock/index.jsx'));
const ProductionStockAdjustForm = lazy(() => import('./pages/inventory/production-stock/adjust.jsx'));
// Inventory - Production Entry (Phase D — inputs + outputs)
const ProductionEntryList = lazy(() => import('./pages/inventory/production-entries/index.jsx'));
const ProductionEntryForm = lazy(() => import('./pages/inventory/production-entries/new.jsx'));
// Production - Extraction submodule (SLP PLANT only; WIP — routes wired
// locally, hidden from prod until the extraction pages ship).
const ExtractionManufacturingBatches   = lazy(() => import('./pages/production/extraction/manufacturing-batches/index.jsx'));
const ExtractionManufacturingBatchForm = lazy(() => import('./pages/production/extraction/manufacturing-batches/new.jsx'));
const ExtractionManufacturingBatchDetail = lazy(() => import('./pages/production/extraction/manufacturing-batches/[id].jsx'));

// Quality - List
const QCParams = lazy(() => import('./pages/quality/params/index.jsx'));
const QCRequests = lazy(() => import('./pages/quality/requests/index.jsx'));
const QCRequestDetail = lazy(() => import('./pages/quality/requests/[id].jsx'));
const LabJobs = lazy(() => import('./pages/quality/lab-jobs/index.jsx'));
const QCReports = lazy(() => import('./pages/quality/reports/index.jsx'));
const CounterSamples = lazy(() => import('./pages/quality/counter-samples/index.jsx'));
// Quality - Forms
const QCParamNew = lazy(() => import('./pages/quality/params/new.jsx'));
const QCRequestNew = lazy(() => import('./pages/quality/requests/new.jsx'));
const LabJobNew = lazy(() => import('./pages/quality/lab-jobs/new.jsx'));
const QCReportNew = lazy(() => import('./pages/quality/reports/new.jsx'));
const CounterSampleNew = lazy(() => import('./pages/quality/counter-samples/new.jsx'));

// Inventory - List
const StockLedger = lazy(() => import('./pages/inventory/stock-ledger/index.jsx'));
const StockLedgerWarehouseDetail = lazy(() => import('./pages/inventory/stock-ledger/[warehouseId].jsx'));
const StockLedgerProductDetail = lazy(() => import('./pages/inventory/stock-ledger/product-transactions.jsx'));
const StockTransfers = lazy(() => import('./pages/inventory/transfers/index.jsx'));
const WarehouseShifting = lazy(() => import('./pages/inventory/shifting/index.jsx'));
const JobWorkOrders = lazy(() => import('./pages/inventory/job-work/index.jsx'));
const SalesReturns = lazy(() => import('./pages/inventory/returns/index.jsx'));
const StockAdjustments = lazy(() => import('./pages/inventory/adjustments/index.jsx'));
// Inventory - Forms
const TransferNew = lazy(() => import('./pages/inventory/transfers/new.jsx'));
const TransferDetail = lazy(() => import('./pages/inventory/transfers/[id].jsx'));
const ShiftingNew = lazy(() => import('./pages/inventory/shifting/new.jsx'));
const ShiftingDetail = lazy(() => import('./pages/inventory/shifting/[id].jsx'));
const StockMovementList = lazy(() => import('./pages/inventory/stock-movement/index.jsx'));
const StockMovementRequest = lazy(() => import('./pages/inventory/stock-movement/new.jsx'));
const MovementRequestDetail = lazy(() => import('./pages/inventory/stock-movement/[id].jsx'));
const JobWorkNew = lazy(() => import('./pages/inventory/job-work/new.jsx'));
const JobWorkDetail = lazy(() => import('./pages/inventory/job-work/[id].jsx'));
const ReturnNew = lazy(() => import('./pages/inventory/returns/new.jsx'));
const ReturnDetail = lazy(() => import('./pages/inventory/returns/[id].jsx'));
const AdjustmentNew = lazy(() => import('./pages/inventory/adjustments/new.jsx'));

// Finance - List
const FinanceDashboard = lazy(() => import('./pages/finance/dashboard/index.jsx'));
const Deviations = lazy(() => import('./pages/finance/deviations/index.jsx'));
const FinanceDataTools = lazy(() => import('./pages/finance/data-tools/index.jsx'));
const ArchivePage = lazy(() => import('./pages/archive/index.jsx'));
const VendorLedger = lazy(() => import('./pages/finance/vendor-ledger/index.jsx'));
const CustomerLedger = lazy(() => import('./pages/finance/customer-ledger/index.jsx'));
const FinancePayments = lazy(() => import('./pages/finance/payments/index.jsx'));
const GSTReconciliation = lazy(() => import('./pages/finance/gst/index.jsx'));
const PettyCash = lazy(() => import('./pages/finance/petty-cash/index.jsx'));
const FreightLedgerAll = lazy(() => import('./pages/finance/freight-ledger-all/index.jsx'));
const WageLedgerAll = lazy(() => import('./pages/finance/wage-ledger-all/index.jsx'));
const ExpenseLedger = lazy(() => import('./pages/finance/expense-ledger/index.jsx'));
const PettyCashLedger = lazy(() => import('./pages/finance/petty-cash-ledger/index.jsx'));
const Ledgers = lazy(() => import('./pages/finance/ledgers/PartyLedgers.jsx'));
// Finance - Forms
const FinancePaymentNew = lazy(() => import('./pages/finance/payments/new.jsx'));
const PettyCashNew = lazy(() => import('./pages/finance/petty-cash/new.jsx'));
const GSTNew = lazy(() => import('./pages/finance/gst/new.jsx'));

// HR - List
const StaffList = lazy(() => import('./pages/hr/staff/index.jsx'));
const AttendanceList = lazy(() => import('./pages/hr/attendance/index.jsx'));
const AttendanceCheckIn = lazy(() => import('./pages/hr/attendance/check-in.jsx'));
const AttendanceFaceSetup = lazy(() => import('./pages/hr/attendance/face-setup.jsx'));
const AttendanceRegister = lazy(() => import('./pages/hr/attendance/register.jsx'));
const LeaveRequests = lazy(() => import('./pages/hr/leave/index.jsx'));
const OvertimeRequests = lazy(() => import('./pages/hr/overtime/index.jsx'));
const ShiftDefinitions = lazy(() => import('./pages/hr/shifts/index.jsx'));
const ShiftRotation = lazy(() => import('./pages/hr/shifts/rotation.jsx'));
const PayrollExport = lazy(() => import('./pages/hr/payroll/index.jsx'));
const PayrollAdjustments = lazy(() => import('./pages/hr/payroll/adjustments.jsx'));
// HR - Detail / Edit
const StaffDetail = lazy(() => import('./pages/hr/staff/[id].jsx'));
// HR - Forms
const StaffNew = lazy(() => import('./pages/hr/staff/new.jsx'));
const AttendanceNew = lazy(() => import('./pages/hr/attendance/new.jsx'));
const LeaveNew = lazy(() => import('./pages/hr/leave/new.jsx'));
const OvertimeNew = lazy(() => import('./pages/hr/overtime/new.jsx'));
const ShiftNew = lazy(() => import('./pages/hr/shifts/new.jsx'));
const PayrollNew = lazy(() => import('./pages/hr/payroll/new.jsx'));

// HR - Detail pages (view + approve / edit / drilldown)
const AttendanceDetail = lazy(() => import('./pages/hr/attendance/[id].jsx'));
const LeaveDetail = lazy(() => import('./pages/hr/leave/[id].jsx'));
const OvertimeDetail = lazy(() => import('./pages/hr/overtime/[id].jsx'));
const ShiftDetail = lazy(() => import('./pages/hr/shifts/[id].jsx'));
const PayrollDetail = lazy(() => import('./pages/hr/payroll/[id].jsx'));
const HolidayCalendar = lazy(() => import('./pages/hr/calendar/index.jsx'));

// Admin RBAC
const AdminUserList = lazy(() => import('./pages/admin/users/index.jsx'));
const AdminUserNew = lazy(() => import('./pages/admin/users/new.jsx'));
const AdminUserDetail = lazy(() => import('./pages/admin/users/[id].jsx'));
const AdminUserEdit = lazy(() => import('./pages/admin/users/edit.jsx'));
const AdminRoleList = lazy(() => import('./pages/admin/roles/index.jsx'));
const AdminRoleNew = lazy(() => import('./pages/admin/roles/new.jsx'));
const AdminRoleDetail = lazy(() => import('./pages/admin/roles/[id].jsx'));
const AdminPermissions = lazy(() => import('./pages/admin/permissions/index.jsx'));
const AdminSalesPermissions = lazy(() => import('./pages/admin/permissions/sales.jsx'));
const AdminPurchasePermissions = lazy(() => import('./pages/admin/permissions/purchase.jsx'));
const AdminFreightPermissions = lazy(() => import('./pages/admin/permissions/freight.jsx'));
const AdminProductionPermissions = lazy(() => import('./pages/admin/permissions/production.jsx'));
const AdminInventoryPermissions = lazy(() => import('./pages/admin/permissions/inventory.jsx'));
const AdminHRPermissions = lazy(() => import('./pages/admin/permissions/hr.jsx'));
const AdminFinancePermissions = lazy(() => import('./pages/admin/permissions/finance.jsx'));
const AdminBankPermissions = lazy(() => import('./pages/admin/permissions/bank.jsx'));
const AdminMastersPermissions = lazy(() => import('./pages/admin/permissions/masters.jsx'));
const AdminReportsPermissions = lazy(() => import('./pages/admin/permissions/reports.jsx'));
const AdminExpensesPermissions = lazy(() => import('./pages/admin/permissions/expenses.jsx'));
const AdminImportPermissions = lazy(() => import('./pages/admin/permissions/import.jsx'));
const AuditLogViewer = lazy(() => import('./pages/admin/audit-logs/index.jsx'));

// Admin - Email Templates
const EmailTemplateList = lazy(() => import('./pages/admin/email-templates/index.jsx'));
const EmailTemplateForm = lazy(() => import('./pages/admin/email-templates/new.jsx'));

// Purchase - RFQ Email
const SendRFQEmail = lazy(() => import('./pages/purchase/rfq/send-email.jsx'));

// Lightweight fallback shown while a route's lazy chunk loads.
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="h-8 w-8 rounded-full border-2 border-slate-200 border-t-primary-600 animate-spin" />
    </div>
  );
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const theme = localStorage.getItem('theme') || 'light';
    if (theme === 'dark') document.documentElement.classList.add('dark');
  }, []);

  // Tapping a native push notification: the service worker focuses this window
  // and posts the target URL here so we route in-app (no reload) — fixes mobile
  // notifications that previously just brought the app forward on its old page.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.type !== 'NOTIFICATION_CLICK' || !data.url) return;
      try {
        const u = new URL(data.url, window.location.origin);
        navigate(u.pathname + u.search + u.hash);
      } catch (_e) {
        navigate(data.url);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  return (
    <>
      <ScrollToTop />
      {/* Bank module PWA: installable "Lancer Bank" app (manifest swap + SW +
          install prompt), active only while browsing /bank/*. */}
      {location.pathname.startsWith('/bank') && <BankPWA />}
      <div className="min-h-dvh bg-neutral-50">
       <ErrorBoundary resetKey={`${location.pathname}${location.search}`}>
        <Suspense fallback={<PageLoader />}>
        <Routes>
          {/* Auth */}
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/sales/customer-insights" element={<ProtectedRoute module="Customer Insights"><CustomerInsights /></ProtectedRoute>} />
          <Route path="/sales/customer-360" element={<ProtectedRoute module="Customer Insights"><Customer360List /></ProtectedRoute>} />
          <Route path="/sales/customer-360/:id" element={<ProtectedRoute module="Customer Insights"><Customer360Detail /></ProtectedRoute>} />
          <Route path="/sales/company-360" element={<ProtectedRoute module="Customer Insights"><Company360List /></ProtectedRoute>} />
          <Route path="/sales/company-360/:id" element={<ProtectedRoute module="Customer Insights"><Company360Detail /></ProtectedRoute>} />
          {/* Role-aware landing — login sends here, it redirects to the
              user's primary module. */}
          <Route path="/home" element={<RoleLanding />} />

          {/* Profile. ProtectedRoute with no `module` is the AUTH check only
              (no permission check), so it denies nobody who can reach it
              today — it just stops a signed-out user rendering the page.
              Without it, logging out while sitting here left the user on a
              live /profile drawing a null user ("User", "Member", "—"),
              because nothing was left to redirect them to /login. */}
          <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />

          {/* Notifications — same reasoning as /profile above. */}
          <Route path="/notifications" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />

          {/* ========== MASTERS ========== */}
          <Route path="/masters/company" element={<ProtectedRoute module="Company"><CompanyList /></ProtectedRoute>} />
          <Route path="/masters/company/new" element={<ProtectedRoute module="Company" action="create"><CompanyNew /></ProtectedRoute>} />
          <Route path="/masters/company/:id" element={<ProtectedRoute module="Company"><CompanyEdit /></ProtectedRoute>} />
          <Route path="/masters/company/:id/edit" element={<ProtectedRoute module="Company"><CompanyEdit /></ProtectedRoute>} />
          <Route path="/masters/warehouse" element={<ProtectedRoute module="Warehouse"><WarehouseList /></ProtectedRoute>} />
          <Route path="/masters/warehouse/new" element={<ProtectedRoute module="Warehouse" action="create"><WarehouseNew /></ProtectedRoute>} />
          <Route path="/masters/warehouse/:id" element={<ProtectedRoute module="Warehouse"><WarehouseDetail /></ProtectedRoute>} />
          <Route path="/masters/warehouse/:id/edit" element={<ProtectedRoute module="Warehouse" action="edit"><WarehouseDetail /></ProtectedRoute>} />
          <Route path="/masters/godown" element={<ProtectedRoute module="Godown"><GodownList /></ProtectedRoute>} />
          <Route path="/masters/godown/new" element={<ProtectedRoute module="Godown" action="create"><GodownNew /></ProtectedRoute>} />
          <Route path="/masters/godown/:id" element={<ProtectedRoute module="Godown"><GodownEdit /></ProtectedRoute>} />
          <Route path="/masters/machinery-division" element={<ProtectedRoute module="Machinery Division"><MachineryDivisionList /></ProtectedRoute>} />
          <Route path="/masters/machinery-division/new" element={<ProtectedRoute module="Machinery Division" action="create"><MachineryDivisionNew /></ProtectedRoute>} />
          <Route path="/masters/machinery-division/:id" element={<ProtectedRoute module="Machinery Division"><MachineryDivisionEdit /></ProtectedRoute>} />
          <Route path="/masters/machinery-expense" element={<ProtectedRoute module="Machinery Expense"><MachineryExpenseList /></ProtectedRoute>} />
          <Route path="/masters/machinery-expense/new" element={<ProtectedRoute module="Machinery Expense" action="create"><MachineryExpenseNew /></ProtectedRoute>} />
          <Route path="/masters/machinery-expense/:id" element={<ProtectedRoute module="Machinery Expense"><MachineryExpenseEdit /></ProtectedRoute>} />
          <Route path="/masters/products" element={<ProtectedRoute module="Product"><ProductList /></ProtectedRoute>} />
          <Route path="/masters/products/new" element={<ProtectedRoute module="Product" action="create"><ProductNew /></ProtectedRoute>} />
          <Route path="/masters/products/:id" element={<ProtectedRoute module="Product"><ProductNew /></ProtectedRoute>} />
          <Route path="/masters/products/:id/edit" element={<ProtectedRoute module="Product" action="edit"><ProductNew /></ProtectedRoute>} />
          <Route path="/masters/vendor" element={<ProtectedRoute module="Vendor"><VendorList /></ProtectedRoute>} />
          <Route path="/masters/vendor/new" element={<ProtectedRoute module="Vendor" action="create"><VendorNew /></ProtectedRoute>} />
          <Route path="/masters/broker" element={<BrokerList />} />
          <Route path="/masters/broker/new" element={<BrokerNew />} />
          <Route path="/masters/vendor/:id" element={<ProtectedRoute module="Vendor"><VendorEdit /></ProtectedRoute>} />
          <Route path="/masters/vendor/:id/edit" element={<ProtectedRoute module="Vendor" action="edit"><VendorEdit /></ProtectedRoute>} />
          <Route path="/masters/customer" element={<ProtectedRoute module="Customer"><CustomerList /></ProtectedRoute>} />
          <Route path="/masters/customer/new" element={<ProtectedRoute module="Customer" action="create"><CustomerNew /></ProtectedRoute>} />
          <Route path="/masters/customer/:id" element={<ProtectedRoute module="Customer"><CustomerEdit /></ProtectedRoute>} />
          <Route path="/masters/transporter" element={<ProtectedRoute module="Transporter"><TransporterList /></ProtectedRoute>} />
          <Route path="/masters/transporter/new" element={<ProtectedRoute module="Transporter" action="create"><TransporterNew /></ProtectedRoute>} />
          <Route path="/masters/transporter/:id" element={<ProtectedRoute module="Transporter"><TransporterEdit /></ProtectedRoute>} />
          <Route path="/masters/price-list" element={<ProtectedRoute module="Price List"><PriceListPage /></ProtectedRoute>} />
          <Route path="/masters/price-list/new" element={<ProtectedRoute module="Price List" action="create"><PriceListNew /></ProtectedRoute>} />
          <Route path="/masters/price-list/:id" element={<ProtectedRoute module="Price List"><PriceListEdit /></ProtectedRoute>} />
          <Route path="/masters/state-group" element={<ProtectedRoute module="State Group"><StateGroupList /></ProtectedRoute>} />
          <Route path="/masters/state-group/new" element={<ProtectedRoute module="State Group" action="create"><StateGroupNew /></ProtectedRoute>} />
          <Route path="/masters/state-group/:id" element={<ProtectedRoute module="State Group"><StateGroupEdit /></ProtectedRoute>} />
          <Route path="/masters/tax" element={<ProtectedRoute module="Tax Master"><TaxMasterList /></ProtectedRoute>} />
          <Route path="/masters/tax/new" element={<ProtectedRoute module="Tax Master" action="create"><TaxNew /></ProtectedRoute>} />
          <Route path="/masters/tax/:id" element={<ProtectedRoute module="Tax Master"><TaxEdit /></ProtectedRoute>} />
          <Route path="/masters/templates" element={<ProtectedRoute module="Template"><TemplateList /></ProtectedRoute>} />
          <Route path="/masters/templates/new" element={<ProtectedRoute module="Template" action="create"><TemplateNew /></ProtectedRoute>} />
          <Route path="/masters/templates/:id" element={<ProtectedRoute module="Template"><TemplateEdit /></ProtectedRoute>} />
          <Route path="/masters/service-catalogue" element={<ProtectedRoute module="Service Catalogue"><ServiceCatalogueList /></ProtectedRoute>} />
          <Route path="/masters/service-catalogue/new" element={<ProtectedRoute module="Service Catalogue" action="create"><ServiceCatalogueNew /></ProtectedRoute>} />
          <Route path="/masters/service-catalogue/:id" element={<ProtectedRoute module="Service Catalogue"><ServiceCatalogueEdit /></ProtectedRoute>} />
          <Route path="/masters/roles" element={<ProtectedRoute module="Role Management"><RoleList /></ProtectedRoute>} />
          <Route path="/masters/roles/new" element={<ProtectedRoute module="Role Management" action="create"><RoleNew /></ProtectedRoute>} />
          <Route path="/masters/users" element={<ProtectedRoute module="User Management"><UserList /></ProtectedRoute>} />
          <Route path="/masters/users/new" element={<ProtectedRoute module="User Management" action="create"><UserNew /></ProtectedRoute>} />

          {/* ========== PURCHASE ========== */}
          <Route path="/purchase/requests" element={<ProtectedRoute module="Purchase Request"><PurchaseRequests /></ProtectedRoute>} />
          <Route path="/purchase/requests/new" element={<ProtectedRoute module="Purchase Request" action="create"><PurchaseRequestNew /></ProtectedRoute>} />
          <Route path="/purchase/requests/:id" element={<ProtectedRoute module="Purchase Request"><PurchaseRequestDetail /></ProtectedRoute>} />
          <Route path="/purchase/rfq" element={<ProtectedRoute module="RFQ"><RFQList /></ProtectedRoute>} />
          <Route path="/purchase/rfq/new" element={<ProtectedRoute module="RFQ" action="create"><RFQNew /></ProtectedRoute>} />
          <Route path="/purchase/rfq/:id" element={<ProtectedRoute module="RFQ"><RFQDetail /></ProtectedRoute>} />
          <Route path="/purchase/rfq/:id/send-email" element={<ProtectedRoute module="RFQ"><SendRFQEmail /></ProtectedRoute>} />
          <Route path="/purchase/rfq/:id/document" element={<ProtectedRoute module="RFQ"><RFQDocument /></ProtectedRoute>} />
          <Route path="/purchase/quotes" element={<ProtectedRoute module="Quote"><QuoteList /></ProtectedRoute>} />
          <Route path="/purchase/quotes/new" element={<ProtectedRoute module="Quote" action="create"><QuoteNew /></ProtectedRoute>} />
          <Route path="/purchase/quotes/rfq/:rfqId" element={<ProtectedRoute module="Quote"><QuoteResponseDetail /></ProtectedRoute>} />
          <Route path="/purchase/quotes/:id/edit" element={<ProtectedRoute module="Quote" action="edit"><QuoteNew /></ProtectedRoute>} />
          <Route path="/purchase/evaluations" element={<ProtectedRoute module="Quote Evaluation"><EvaluationList /></ProtectedRoute>} />
          <Route path="/purchase/evaluations/new" element={<ProtectedRoute module="Quote Evaluation" action="create"><EvaluationNew /></ProtectedRoute>} />
          <Route path="/purchase/evaluations/dashboard" element={<ProtectedRoute module="Quote Evaluation"><EvaluationList /></ProtectedRoute>} />
          <Route path="/purchase/evaluations/:id" element={<ProtectedRoute module="Quote Evaluation"><EvaluationDetail /></ProtectedRoute>} />
          <Route path="/purchase/lifecycle" element={<ProtectedRoute module="Purchase Request"><PurchaseLifecycleDashboard /></ProtectedRoute>} />
          {/* Original purchase Dashboard/Analytics UI, now fed with Zoho data
              (the pages fetch the /api/purchase/zoho/* endpoints). */}
          <Route path="/purchase/overview" element={<ProtectedRoute module="Purchase Dashboard"><PurchaseDashboardOverview /></ProtectedRoute>} />
          <Route path="/purchase/stock" element={<ProtectedRoute module="Stock"><PurchaseStock /></ProtectedRoute>} />
          <Route path="/purchase/stock/:id" element={<ProtectedRoute module="Stock"><PurchaseStockDetail /></ProtectedRoute>} />
          <Route path="/purchase/tds" element={<ProtectedRoute module="TDS Summary"><PurchaseTdsSummary /></ProtectedRoute>} />
          <Route path="/purchase/tds-reconcile" element={<ProtectedRoute module="TDS Reconciliation"><PurchaseTdsReconcile /></ProtectedRoute>} />
          <Route path="/purchase/dashboard" element={<ProtectedRoute module="Purchase Analytics"><PurchaseDashboard /></ProtectedRoute>} />
          <Route path="/purchase/vendor-insights" element={<ProtectedRoute module="Vendor Insights"><VendorInsights /></ProtectedRoute>} />
          <Route path="/purchase/orders" element={<ProtectedRoute module="Purchase Order"><PurchaseOrders /></ProtectedRoute>} />
          <Route path="/purchase/orders/new" element={<ProtectedRoute module="Purchase Order" action="create"><PurchaseOrderNew /></ProtectedRoute>} />
          <Route path="/purchase/orders/:id" element={<ProtectedRoute module="Purchase Order"><PurchaseOrderDetail /></ProtectedRoute>} />
          <Route path="/purchase/orders/:id/send-email" element={<ProtectedRoute module="Purchase Order"><SendPOEmail /></ProtectedRoute>} />
          <Route path="/purchase/orders/:id/document" element={<ProtectedRoute module="Purchase Order"><PurchaseOrderDocument /></ProtectedRoute>} />
          <Route path="/purchase/receipts" element={<ProtectedRoute module="Receipt Advice"><ReceiptList /></ProtectedRoute>} />
          <Route path="/purchase/receipts/new" element={<ProtectedRoute module="Receipt Advice" action="create"><ReceiptNew /></ProtectedRoute>} />
          <Route path="/purchase/receipts/:id" element={<ProtectedRoute module="Receipt Advice"><ReceiptDetail /></ProtectedRoute>} />


          {/* Purchase - Bills */}
          <Route path="/purchase/bills" element={<ProtectedRoute module="Vendor Bill"><VendorBillList /></ProtectedRoute>} />
          {/* Zoho dashboard/analytics now serve at /purchase/overview and
              /purchase/dashboard. Bills/Freight (Zoho) lists folded in — import
              lives on the dashboard/analytics headers. */}
          <Route path="/purchase/scan" element={<ProtectedRoute module="Scan Inbox"><ScanInbox /></ProtectedRoute>} />

          {/* ── Import Data module (slice 1: shell) ───────────────────────────
              Scan Inbox and Payments reuse the EXISTING page components under
              new /import/* routes; the old /purchase/* routes redirect so
              bookmarks keep working. Overview/Ledger/Tally are placeholders
              until their full build in a later slice. Gated by 'Import Data'. */}
          <Route path="/import" element={<Navigate to="/import/overview" replace />} />
          <Route path="/import/overview" element={<ProtectedRoute module="Import Overview"><ImportOverview /></ProtectedRoute>} />
          {/* Triage moved into Scan Inbox tabs — keep the old link alive */}
          <Route path="/import/ledger" element={<Navigate to="/import/scan" replace />} />
          <Route path="/import/scan" element={<ProtectedRoute module="Import Scan Inbox"><ScanInbox /></ProtectedRoute>} />
          <Route path="/import/payments" element={<ProtectedRoute module="Import Payments Made"><ImportBankStatements /></ProtectedRoute>} />
          <Route path="/import/ledgers" element={<ProtectedRoute module="Ledger"><Ledgers /></ProtectedRoute>} />
          <Route path="/import/mappings" element={<ProtectedRoute module="Import Mappings"><PayeeMappings /></ProtectedRoute>} />
          <Route path="/import/sales-tally" element={<ProtectedRoute module="Sales Tally Import"><SalesTallyImport /></ProtectedRoute>} />
          <Route path="/import/purchase-tally" element={<ProtectedRoute module="Purchase Tally Import"><PurchaseTallyImport /></ProtectedRoute>} />
          {/* old routes → new homes (keep bookmarks/deep-links alive) */}
          <Route path="/purchase/payments-made/import" element={<Navigate to="/import/payments" replace />} />
          <Route path="/purchase/email-bills" element={<ProtectedRoute module="Scan Inbox"><EmailBillInbox /></ProtectedRoute>} />
          <Route path="/purchase/mappings" element={<ProtectedRoute module="Scan Inbox"><Mappings /></ProtectedRoute>} />
          <Route path="/purchase/gst2b" element={<ProtectedRoute module="GST 2B Match"><Gst2B /></ProtectedRoute>} />
          <Route path="/sales/gstr1" element={<ProtectedRoute module="GSTR-1 Match"><Gstr1 /></ProtectedRoute>} />
          <Route path="/sales/ewb-einvoice" element={<ProtectedRoute module="E-Way Bill Check"><EwbEinvoiceCheck /></ProtectedRoute>} />
          <Route path="/purchase/bills/new" element={<ProtectedRoute module="Vendor Bill" anyOf={["create", "convert"]}><VendorBillNew /></ProtectedRoute>} />
          <Route path="/purchase/bills/:id" element={<ProtectedRoute module="Vendor Bill"><VendorBillDetail /></ProtectedRoute>} />

          {/* Purchase - Material Rejections. Routes were missing
              entirely, so the "Reject Material" button on the Receipt
              detail page navigated to a 404. */}
          <Route path="/purchase/rejections" element={<ProtectedRoute module="Material Rejection"><MaterialRejectionList /></ProtectedRoute>} />
          <Route path="/purchase/rejections/new" element={<ProtectedRoute module="Material Rejection" action="create"><MaterialRejectionNew /></ProtectedRoute>} />
          <Route path="/purchase/rejections/:id" element={<ProtectedRoute module="Material Rejection"><MaterialRejectionDetail /></ProtectedRoute>} />

          {/* Purchase - Payments Made */}
          <Route path="/purchase/payments-made" element={<ProtectedRoute module="Payment Made"><PaymentsMadeList /></ProtectedRoute>} />
          <Route path="/purchase/payment-entries" element={<ProtectedRoute module="Payment Entries"><PaymentEntries /></ProtectedRoute>} />
          {/* /purchase/payments-made/import now redirects to /import/payments (see Import Data block) */}
          <Route path="/purchase/payments-made/reconcile" element={<ProtectedRoute module="Payment Made"><ReconcilePayments /></ProtectedRoute>} />
          <Route path="/purchase/payables-overview" element={<ProtectedRoute module="Payment Made"><PayablesOverview /></ProtectedRoute>} />
          <Route path="/reports/vendor-customer" element={<ProtectedRoute module="Vendor-Customer"><VendorCustomerReport /></ProtectedRoute>} />
          <Route path="/reports/summary" element={<ProtectedRoute module="Reports"><ReportsSummary /></ProtectedRoute>} />
          <Route path="/sales/debtors" element={<ProtectedRoute module="Debtors"><SalesDebtors /></ProtectedRoute>} />
          <Route path="/sales/receipts" element={<ProtectedRoute module="Receipts"><SalesReceipts /></ProtectedRoute>} />
          {/* Creditors page removed; TDS now lives on TDS Summary (/purchase/tds).
              Old TDS-Payable / Creditors links (incl bill-detail TDS cards)
              redirect to TDS Summary so they don't 404. */}
          <Route path="/purchase/creditors" element={<Navigate to="/purchase/tds" replace />} />
          <Route path="/purchase/tds-payable" element={<Navigate to="/purchase/tds" replace />} />
          <Route path="/purchase/expenses" element={<ProtectedRoute module="Expense Register"><PurchaseExpenses /></ProtectedRoute>} />
          <Route path="/purchase/by-category" element={<ProtectedRoute module="Vendor Bill"><PurchaseByCategory /></ProtectedRoute>} />
          <Route path="/purchase/expense-reconcile" element={<ProtectedRoute><PurchaseExpenseReconcile /></ProtectedRoute>} />
          <Route path="/purchase/payments-made/new" element={<ProtectedRoute module="Payment Made" action="create"><PaymentsMadeNew /></ProtectedRoute>} />
          <Route path="/purchase/payments-made/:id" element={<ProtectedRoute module="Payment Made"><PaymentsMadeDetail /></ProtectedRoute>} />

          {/* Purchase - Vendor Credits */}
          <Route path="/purchase/vendor-credits" element={<ProtectedRoute module="Vendor Credit"><VendorCreditList /></ProtectedRoute>} />
          <Route path="/purchase/vendor-credits/new" element={<ProtectedRoute module="Vendor Credit" action="create"><VendorCreditNew /></ProtectedRoute>} />
          <Route path="/purchase/vendor-credits/:id" element={<ProtectedRoute module="Vendor Credit"><VendorCreditDetail /></ProtectedRoute>} />
          <Route path="/purchase/vendor-dues" element={<ProtectedRoute module="Vendor Dues"><VendorDuesPage /></ProtectedRoute>} />

          {/* ========== FREIGHT — TWO DEDICATED FLOWS ==========
              The old unified "Freight Management" page at /freight and
              its /freight/new create were removed. Each direction now
              has its own list + create + detail pages. Permission
              ownership: Inward = Freight Advice (purchase), Outward =
              Sales Freight (sales). */}
          <Route path="/freight/inward"      element={<ProtectedRoute module="Freight Advice"><UnifiedFreightList /></ProtectedRoute>} />
          <Route path="/freight/inward/new"  element={<ProtectedRoute module="Freight Advice" action="create"><UnifiedFreightCreate /></ProtectedRoute>} />
          <Route path="/freight/outward"     element={<ProtectedRoute module="Sales Freight"><UnifiedFreightList /></ProtectedRoute>} />
          <Route path="/freight/outward/new" element={<ProtectedRoute module="Sales Freight" action="create"><UnifiedFreightCreate /></ProtectedRoute>} />
          <Route path="/freight/lorry-review" element={<ProtectedRoute module="Sales Freight"><LorryFreightReview /></ProtectedRoute>} />
          <Route path="/freight/local"       element={<ProtectedRoute module="Local Freight"><LocalFreightList /></ProtectedRoute>} />
          <Route path="/freight/two-way"     element={<ProtectedRoute module="Freight Advice"><TwoWayFreight /></ProtectedRoute>} />
          <Route path="/freight/dashboard"   element={<ProtectedRoute module="Freight Analytics"><FreightDashboard /></ProtectedRoute>} />
          <Route path="/freight/bills"       element={<ProtectedRoute module="Freight Advice"><FreightBills /></ProtectedRoute>} />
          <Route path="/freight/local/new"   element={<ProtectedRoute module="Local Freight" action="create"><LocalFreightCreate /></ProtectedRoute>} />
          <Route path="/freight/local/:id"   element={<ProtectedRoute module="Local Freight"><LocalFreightDetail /></ProtectedRoute>} />
          {/* Legacy redirects — old bookmarks keep working. */}
          <Route path="/freight"           element={<Navigate to="/freight/inward" replace />} />
          <Route path="/freight/new"       element={<Navigate to="/freight/inward/new" replace />} />
          <Route path="/freight/sales/new" element={<Navigate to="/freight/outward/new" replace />} />
          <Route path="/freight/payments" element={<ProtectedRoute module="Freight Payment"><FreightPaymentList /></ProtectedRoute>} />
          <Route path="/freight/payments/new" element={<ProtectedRoute module="Freight Payment" action="create"><FreightPaymentCreate /></ProtectedRoute>} />
          {/* Freight payments have no standalone detail page — drill-throughs
              (sales flow timeline) land on the list. Must precede the
              /freight/:type/:id catch-all or it renders a broken freight detail. */}
          <Route path="/freight/payments/:id" element={<Navigate to="/freight/payments" replace />} />
          {/* Legacy /sales/freight-payments/* → unified freight payments list */}
          <Route path="/sales/freight-payments" element={<Navigate to="/freight/payments" replace />} />
          <Route path="/sales/freight-payments/:id" element={<Navigate to="/freight/payments" replace />} />
          {/* Payee Mappings moved to Import Data › Mappings — keep the old link alive */}
          <Route path="/freight/payee-mappings" element={<Navigate to="/import/mappings" replace />} />
          <Route path="/freight/wages" element={<ProtectedRoute module="Wage Entry"><WageEntryList /></ProtectedRoute>} />
          <Route path="/freight/wages/new" element={<ProtectedRoute module="Wage Entry" action="create"><WageEntryCreate /></ProtectedRoute>} />
          {/* Wage Payments — periodic contractor settlements. Literal
              /payments routes must come BEFORE /freight/wages/:id so the
              router doesn't treat "payments" as a wage-entry id. */}
          <Route path="/freight/wages/payments" element={<ProtectedRoute module="Wage Payment"><WagePaymentList /></ProtectedRoute>} />
          <Route path="/freight/wages/payments/new" element={<ProtectedRoute module="Wage Payment" action="create"><WagePaymentCreate /></ProtectedRoute>} />
          <Route path="/freight/wages/payments/:id" element={<ProtectedRoute module="Wage Payment"><WagePaymentDetail /></ProtectedRoute>} />
          <Route path="/freight/wages/:id" element={<ProtectedRoute module="Wage Entry"><WageEntryDetail /></ProtectedRoute>} />
          {/* Explicit sales/purchase detail routes — they must come
              before the catch-all /freight/:type/:id so the correct
              module is enforced. */}
          <Route path="/freight/sales/:id"    element={<ProtectedRoute module="Sales Freight"><UnifiedFreightDetail /></ProtectedRoute>} />
          <Route path="/freight/purchase/:id" element={<ProtectedRoute module="Freight Advice"><UnifiedFreightDetail /></ProtectedRoute>} />
          <Route path="/freight/:type/:id" element={<ProtectedRoute module="Freight Advice"><UnifiedFreightDetail /></ProtectedRoute>} />
          {/* Legacy /sales/freight/* paths → redirect to dedicated pages */}
          <Route path="/sales/freight" element={<Navigate to="/freight/outward" replace />} />
          <Route path="/sales/freight/new" element={<Navigate to="/freight/outward/new" replace />} />
          <Route path="/sales/freight/:id" element={<SalesFreightRedirect />} />
          <Route path="/sales/freight/:id/edit" element={<SalesFreightRedirect />} />

          {/* ========== SALES ========== */}
          {/* Dashboard routes are gated on their DASHBOARD modules — the
              same modules the sidebar items check (navigation.js). They
              were gated on "Sales Order", so a role granted only Sales
              Dashboard saw the menu but every click bounced back to the
              user's first accessible page (ProtectedRoute's deny path). */}
          <Route path="/sales/overview" element={<ProtectedRoute module="Sales Dashboard"><SalesDashboardOverview /></ProtectedRoute>} />
          <Route path="/sales/dashboard" element={<ProtectedRoute module="Sales Analytics"><SalesDashboard /></ProtectedRoute>} />
          <Route path="/sales/flow" element={<ProtectedRoute module="Sales Flow Dashboard"><SalesFlowDashboard /></ProtectedRoute>} />
          <Route path="/sales/quotes" element={<ProtectedRoute module="Sales Quote"><SalesQuotes /></ProtectedRoute>} />
          <Route path="/sales/quotes/new" element={<ProtectedRoute module="Sales Quote" action="create"><SalesQuoteNew /></ProtectedRoute>} />
          <Route path="/sales/quotes/:id/send-email" element={<ProtectedRoute module="Sales Quote" action="send_email"><SendQuoteEmail /></ProtectedRoute>} />
          <Route path="/sales/quotes/:id/document" element={<ProtectedRoute module="Sales Quote"><QuoteDocument /></ProtectedRoute>} />
          <Route path="/sales/quotes/:id" element={<ProtectedRoute module="Sales Quote"><SalesQuoteDetail /></ProtectedRoute>} />
          <Route path="/sales/customer-po" element={<ProtectedRoute module="Customer PO"><CustomerPO /></ProtectedRoute>} />
          <Route path="/sales/customer-po/new" element={<ProtectedRoute module="Customer PO" action="create"><CustomerPONew /></ProtectedRoute>} />
          {/* Literal /inbox route must come BEFORE the :id route so React
              Router resolves it as the inbox page rather than treating
              "inbox" as a Customer PO id. */}
          <Route path="/sales/customer-po/inbox" element={<ProtectedRoute module="Customer PO"><CustomerPOInbox /></ProtectedRoute>} />
          {/* Literal /bulk route must also come BEFORE the :id route. */}
          <Route path="/sales/customer-po/bulk" element={<ProtectedRoute module="Customer PO" action="create"><CustomerPOBulkUpload /></ProtectedRoute>} />
          <Route path="/sales/customer-po/:id" element={<ProtectedRoute module="Customer PO"><CustomerPODetail /></ProtectedRoute>} />
          <Route path="/sales/customer-po/:id/edit" element={<ProtectedRoute module="Customer PO" action="edit"><CustomerPOEdit /></ProtectedRoute>} />
          <Route path="/sales/orders" element={<ProtectedRoute module="Sales Order"><SalesOrders /></ProtectedRoute>} />
          <Route path="/sales/orders/new" element={<ProtectedRoute module="Sales Order" action="create"><SalesOrderNew /></ProtectedRoute>} />
          <Route path="/sales/orders/multi-po" element={<ProtectedRoute module="Sales Order" action="create"><MultiPoSalesOrder /></ProtectedRoute>} />
          <Route path="/sales/orders/:id" element={<ProtectedRoute module="Sales Order"><SalesOrderDetail /></ProtectedRoute>} />
          <Route path="/sales/orders/:id/edit" element={<ProtectedRoute module="Sales Order" action="edit"><SalesOrderEdit /></ProtectedRoute>} />
          <Route path="/sales/dc" element={<ProtectedRoute module="Dispatch Challan"><DispatchChallan /></ProtectedRoute>} />
          <Route path="/sales/dc/new" element={<ProtectedRoute module="Dispatch Challan" action="create"><DCNew /></ProtectedRoute>} />
          <Route path="/sales/dc/:id" element={<ProtectedRoute module="Dispatch Challan"><DCDetail /></ProtectedRoute>} />
          <Route path="/sales/dc/:id/edit" element={<ProtectedRoute module="Dispatch Challan" action="edit"><DCEdit /></ProtectedRoute>} />
          <Route path="/sales/invoices" element={<ProtectedRoute module="Sales Invoice"><SalesInvoice /></ProtectedRoute>} />
          <Route path="/sales/debit-notes" element={<ProtectedRoute module="Sales Invoice"><DebitNotes /></ProtectedRoute>} />
          {/* One note. Declared AFTER the list so the bare path still matches
              the list first. Same module gate as the list it opens from. */}
          <Route path="/sales/debit-notes/:id" element={<ProtectedRoute module="Sales Invoice"><DebitNoteDetail /></ProtectedRoute>} />
          <Route path="/sales/invoices/new" element={<ProtectedRoute module="Sales Invoice" action="create"><InvoiceNew /></ProtectedRoute>} />
          <Route path="/sales/invoices/:id" element={<ProtectedRoute module="Sales Invoice"><InvoiceDetail /></ProtectedRoute>} />
          <Route path="/sales/invoices/:id/edit" element={<ProtectedRoute module="Sales Invoice" action="edit"><InvoiceEdit /></ProtectedRoute>} />
          <Route path="/sales/receivables" element={<ProtectedRoute module="Receivable"><Receivables /></ProtectedRoute>} />
          <Route path="/sales/ledger" element={<ProtectedRoute module="Receivable"><SalesLedger /></ProtectedRoute>} />
          <Route path="/sales/tds" element={<ProtectedRoute module="Receivable"><SalesTds /></ProtectedRoute>} />
          <Route path="/sales/receivables/new" element={<ProtectedRoute module="Receivable" action="create"><ReceivableNew /></ProtectedRoute>} />
          {/* Specific path BEFORE the :id route so "msme" isn't read as an id. */}
          <Route path="/sales/receivables/msme" element={<ProtectedRoute module="Receivable"><MsmeReceivables /></ProtectedRoute>} />
          <Route path="/sales/receivables/receipt/:id" element={<ProtectedRoute module="Receivable"><ReceivableReceipt /></ProtectedRoute>} />
          <Route path="/sales/receivables/:id" element={<ProtectedRoute module="Receivable"><ReceivableDetail /></ProtectedRoute>} />
          <Route path="/sales/receivables/:id/edit" element={<ProtectedRoute module="Receivable" action="edit"><ReceivableEdit /></ProtectedRoute>} />
          {/* Customer Advances — pre-invoice money received, drawn down
              against future invoices via the Apply panel on the detail
              page. Reuses the Receivable module permission. */}
          <Route path="/sales/advances" element={<ProtectedRoute module="Receivable"><CustomerAdvancesList /></ProtectedRoute>} />
          <Route path="/sales/advances/new" element={<ProtectedRoute module="Receivable" action="create"><CreateCustomerAdvance /></ProtectedRoute>} />
          <Route path="/sales/advances/:id" element={<ProtectedRoute module="Receivable"><CustomerAdvanceDetail /></ProtectedRoute>} />

          {/* ========== BANK ========== */}
          <Route path="/bank/dashboard" element={<BankDashboard />} />
          <Route path="/bank/accounts" element={<ProtectedRoute module="Bank Account"><BankAccountsList /></ProtectedRoute>} />
          <Route path="/bank/accounts/new" element={<ProtectedRoute module="Bank Account" action="create"><BankAccountNew /></ProtectedRoute>} />
          <Route path="/bank/receipts" element={<ProtectedRoute module="Bank Receipt"><ReceiptRegister /></ProtectedRoute>} />
          <Route path="/bank/receipts/new" element={<ProtectedRoute module="Bank Receipt" action="create"><BankReceiptNew /></ProtectedRoute>} />
          <Route path="/bank/payments" element={<ProtectedRoute module="Bank Payment"><PaymentRegister /></ProtectedRoute>} />
          <Route path="/bank/payments/new" element={<ProtectedRoute module="Bank Payment" action="create"><BankPaymentNew /></ProtectedRoute>} />
          <Route path="/bank/transfers" element={<ProtectedRoute module="Bank Payment"><OwnAccountTransfers /></ProtectedRoute>} />
          <Route path="/bank/transfers/:id" element={<ProtectedRoute module="Bank Payment"><BankTransferDetail /></ProtectedRoute>} />
          <Route path="/bank/reconcile" element={<ProtectedRoute module="Reconcile Statement"><ReconcileStatementList /></ProtectedRoute>} />
          <Route path="/bank/reconcile/new" element={<ProtectedRoute module="Reconcile Statement" action="create"><ReconcileStatementNew /></ProtectedRoute>} />
          <Route path="/bank/reconcile/:id" element={<ProtectedRoute module="Reconcile Statement"><ReconcileStatementReport /></ProtectedRoute>} />

          {/* ========== PRODUCTION ========== */}
          <Route path="/production/bom" element={<ProtectedRoute module="BOM Request"><BOMList /></ProtectedRoute>} />
          <Route path="/production/bom/new" element={<ProtectedRoute module="BOM Request" action="create"><BOMNew /></ProtectedRoute>} />
          <Route path="/production/bom/:id" element={<ProtectedRoute module="BOM Request"><BOMTemplateDetail /></ProtectedRoute>} />
          <Route path="/production/bom/:id/edit" element={<ProtectedRoute module="BOM Request" action="edit"><BOMTemplateDetail /></ProtectedRoute>} />
          <Route path="/production/work-orders" element={<ProtectedRoute module="Work Order"><WorkOrders /></ProtectedRoute>} />
          <Route path="/production/work-orders/new" element={<ProtectedRoute module="Work Order" action="create"><WorkOrderNew /></ProtectedRoute>} />
          <Route path="/production/work-orders/:id" element={<ProtectedRoute module="Work Order"><WorkOrderDetail /></ProtectedRoute>} />
          <Route path="/production/damage" element={<ProtectedRoute module="Production Damage"><ProductionDamageList /></ProtectedRoute>} />
          <Route path="/production/damage/new" element={<ProtectedRoute module="Production Damage" action="create"><ProductionDamageNew /></ProtectedRoute>} />
          <Route path="/production/damage/:id" element={<ProtectedRoute module="Production Damage"><ProductionDamageDetail /></ProtectedRoute>} />
          <Route path="/production/gate-register" element={<ProtectedRoute module="Gate Register"><GateRegisterList /></ProtectedRoute>} />
          <Route path="/production/gate-register/new" element={<ProtectedRoute module="Gate Register" action="create"><GateEntryForm /></ProtectedRoute>} />
          <Route path="/production/gate-register/:id" element={<ProtectedRoute module="Gate Register"><GateEntryForm /></ProtectedRoute>} />
          <Route path="/production/shift-labor" element={<ProtectedRoute module="Shift Labor"><ShiftLaborPage /></ProtectedRoute>} />
          <Route path="/production/dpr" element={<ProtectedRoute module="Work Order"><DprPage /></ProtectedRoute>} />
          <Route path="/production/wage-vouchers" element={<ProtectedRoute module="Wage Voucher"><WageVouchers /></ProtectedRoute>} />
          <Route path="/production/wage-vouchers/new" element={<ProtectedRoute module="Wage Voucher" action="create"><WageVoucherNew /></ProtectedRoute>} />
          <Route path="/production/wage-vouchers/:id" element={<ProtectedRoute module="Wage Voucher"><WageVoucherDetail /></ProtectedRoute>} />
          <Route path="/production/additional-wages" element={<ProtectedRoute module="Wage Voucher"><AdditionalWagesList /></ProtectedRoute>} />
          <Route path="/production/additional-wages/new" element={<ProtectedRoute module="Wage Voucher" action="create"><AdditionalWageForm /></ProtectedRoute>} />
          <Route path="/production/additional-wages/:id" element={<ProtectedRoute module="Wage Voucher"><AdditionalWageForm /></ProtectedRoute>} />
          <Route path="/production/wages-ledger" element={<ProtectedRoute module="Additional Wages"><WagesLedgerPage /></ProtectedRoute>} />
          <Route path="/production/processes" element={<ProtectedRoute module="Process"><ProcessList /></ProtectedRoute>} />
          <Route path="/production/processes/new" element={<ProtectedRoute module="Process" action="create"><ProcessNew /></ProtectedRoute>} />
          <Route path="/production/processes/:id" element={<ProtectedRoute module="Process"><ProcessDetail /></ProtectedRoute>} />
          <Route path="/production/packing-processes" element={<ProtectedRoute module="Packing Process"><PackingProcessList /></ProtectedRoute>} />
          <Route path="/production/packing-processes/new" element={<ProtectedRoute module="Packing Process" action="create"><PackingProcessNew /></ProtectedRoute>} />
          <Route path="/production/packing-processes/:id/edit" element={<ProtectedRoute module="Packing Process" action="edit"><PackingProcessNew /></ProtectedRoute>} />
          <Route path="/production/packing-processes/:id" element={<ProtectedRoute module="Packing Process"><PackingProcessDetail /></ProtectedRoute>} />
          <Route path="/production/material-issues" element={<ProtectedRoute module="Material Issue"><MaterialIssues /></ProtectedRoute>} />

          {/* Extraction submodule (SLP PLANT Azadirachtin workflow).
              Wired locally so it renders on the dev machine; the
              route + navigation lines should be pulled into their
              OWN commit before this branch ships, so a prod deploy
              doesn't accidentally expose the half-done pages. */}
          <Route path="/production/extraction/manufacturing-batches"
                 element={<ProtectedRoute module="Work Order"><ExtractionManufacturingBatches /></ProtectedRoute>} />
          <Route path="/production/extraction/manufacturing-batches/new"
                 element={<ProtectedRoute module="Work Order" action="create"><ExtractionManufacturingBatchForm /></ProtectedRoute>} />
          <Route path="/production/extraction/manufacturing-batches/:id"
                 element={<ProtectedRoute module="Work Order"><ExtractionManufacturingBatchDetail /></ProtectedRoute>} />

          {/* ========== QUALITY ========== */}
          <Route path="/quality/params" element={<ProtectedRoute module="QC Parameter"><QCParams /></ProtectedRoute>} />
          <Route path="/quality/params/new" element={<ProtectedRoute module="QC Parameter" action="create"><QCParamNew /></ProtectedRoute>} />
          <Route path="/quality/requests" element={<ProtectedRoute module="QC Request"><QCRequests /></ProtectedRoute>} />
          <Route path="/quality/requests/new" element={<ProtectedRoute module="QC Request" action="create"><QCRequestNew /></ProtectedRoute>} />
          <Route path="/quality/requests/:id" element={<ProtectedRoute module="QC Request"><QCRequestDetail /></ProtectedRoute>} />
          <Route path="/quality/lab-jobs" element={<ProtectedRoute module="QC Lab Job"><LabJobs /></ProtectedRoute>} />
          <Route path="/quality/lab-jobs/new" element={<ProtectedRoute module="QC Lab Job" action="create"><LabJobNew /></ProtectedRoute>} />
          <Route path="/quality/reports" element={<ProtectedRoute module="QC Report"><QCReports /></ProtectedRoute>} />
          <Route path="/quality/reports/new" element={<ProtectedRoute module="QC Report" action="create"><QCReportNew /></ProtectedRoute>} />
          <Route path="/quality/counter-samples" element={<ProtectedRoute module="Counter Sample"><CounterSamples /></ProtectedRoute>} />
          <Route path="/quality/counter-samples/new" element={<ProtectedRoute module="Counter Sample" action="create"><CounterSampleNew /></ProtectedRoute>} />

          {/* ========== INVENTORY ========== */}
          <Route path="/inventory/stock-ledger" element={<ProtectedRoute module="Inventory Ledger"><StockLedger /></ProtectedRoute>} />
          {/* The product-transactions page reads ?warehouse= and
              ?product= from the query string. It MUST be registered
              before /:warehouseId, otherwise the dynamic route catches
              "product-transactions" as a (non-UUID) warehouse id and
              the warehouse-detail page blows up server-side. */}
          <Route path="/inventory/stock-ledger/product-transactions" element={<ProtectedRoute module="Inventory Ledger"><StockLedgerProductDetail /></ProtectedRoute>} />
          <Route path="/inventory/stock-ledger/:warehouseId" element={<ProtectedRoute module="Inventory Ledger"><StockLedgerWarehouseDetail /></ProtectedRoute>} />
          <Route path="/inventory/stock-ledger/:warehouseId/products/:productId" element={<ProtectedRoute module="Inventory Ledger"><StockLedgerProductDetail /></ProtectedRoute>} />
          <Route path="/inventory/production-stock" element={<ProtectedRoute module="Production Stock"><ProductionStockPage /></ProtectedRoute>} />
          <Route path="/inventory/production-stock/adjust" element={<ProtectedRoute module="Production Stock" action="create"><ProductionStockAdjustForm /></ProtectedRoute>} />
          <Route path="/inventory/production-entries" element={<ProtectedRoute module="Production Entry"><ProductionEntryList /></ProtectedRoute>} />
          <Route path="/inventory/production-entries/new" element={<ProtectedRoute module="Production Entry" action="create"><ProductionEntryForm /></ProtectedRoute>} />
          <Route path="/inventory/production-entries/:id" element={<ProtectedRoute module="Production Entry"><ProductionEntryForm /></ProtectedRoute>} />
          <Route path="/inventory/transfers" element={<ProtectedRoute module="Stock Transfer"><StockTransfers /></ProtectedRoute>} />
          <Route path="/inventory/transfers/new" element={<ProtectedRoute module="Stock Transfer" action="create"><TransferNew /></ProtectedRoute>} />
          <Route path="/inventory/transfers/:id" element={<ProtectedRoute module="Stock Transfer"><TransferDetail /></ProtectedRoute>} />
          <Route path="/inventory/shifting" element={<ProtectedRoute module="Shifting"><WarehouseShifting /></ProtectedRoute>} />
          <Route path="/inventory/shifting/new" element={<ProtectedRoute module="Shifting" action="create"><ShiftingNew /></ProtectedRoute>} />
          <Route path="/inventory/stock-movement" element={<ProtectedRoute module="Stock Movement Request"><StockMovementList /></ProtectedRoute>} />
          <Route path="/inventory/stock-movement/new" element={<ProtectedRoute module="Stock Movement Request" action="create"><StockMovementRequest /></ProtectedRoute>} />
          <Route path="/inventory/stock-movement/:id" element={<ProtectedRoute module="Stock Movement Request"><MovementRequestDetail /></ProtectedRoute>} />
          <Route path="/inventory/shifting/:id" element={<ProtectedRoute module="Shifting"><ShiftingDetail /></ProtectedRoute>} />
          <Route path="/inventory/job-work" element={<ProtectedRoute module="Job Work Order"><JobWorkOrders /></ProtectedRoute>} />
          <Route path="/inventory/job-work/new" element={<ProtectedRoute module="Job Work Order" action="create"><JobWorkNew /></ProtectedRoute>} />
          <Route path="/inventory/job-work/:id" element={<ProtectedRoute module="Job Work Order"><JobWorkDetail /></ProtectedRoute>} />
          <Route path="/inventory/returns" element={<ProtectedRoute module="Sales Return"><SalesReturns /></ProtectedRoute>} />
          <Route path="/inventory/returns/new" element={<ProtectedRoute module="Sales Return" action="create"><ReturnNew /></ProtectedRoute>} />
          <Route path="/inventory/returns/:id" element={<ProtectedRoute module="Sales Return"><ReturnDetail /></ProtectedRoute>} />
          <Route path="/inventory/adjustments" element={<ProtectedRoute module="Stock Adjustment"><StockAdjustments /></ProtectedRoute>} />
          <Route path="/inventory/adjustments/new" element={<ProtectedRoute module="Stock Adjustment" action="create"><AdjustmentNew /></ProtectedRoute>} />

          {/* ========== FINANCE ========== */}
          <Route path="/finance/dashboard" element={<ProtectedRoute module="Finance Dashboard"><FinanceDashboard /></ProtectedRoute>} />
          <Route path="/finance/deviations" element={<ProtectedRoute module="Deviations"><Deviations /></ProtectedRoute>} />
          <Route path="/finance/data-tools" element={<ProtectedRoute adminOnly><FinanceDataTools /></ProtectedRoute>} />
          <Route path="/archive" element={<ProtectedRoute><ArchivePage /></ProtectedRoute>} />
          <Route path="/finance/vendor-ledger" element={<ProtectedRoute module="Vendor Ledger"><VendorLedger /></ProtectedRoute>} />
          <Route path="/finance/customer-ledger" element={<ProtectedRoute module="Customer Ledger"><CustomerLedger /></ProtectedRoute>} />
          <Route path="/finance/payments" element={<ProtectedRoute module="Payment Advice"><FinancePayments /></ProtectedRoute>} />
          <Route path="/finance/payments/new" element={<ProtectedRoute module="Payment Advice" action="create"><FinancePaymentNew /></ProtectedRoute>} />
          <Route path="/finance/gst" element={<ProtectedRoute module="GST Report"><GSTReconciliation /></ProtectedRoute>} />
          <Route path="/finance/gst/new" element={<ProtectedRoute module="GST Report" action="create"><GSTNew /></ProtectedRoute>} />
          <Route path="/finance/petty-cash" element={<ProtectedRoute module="Petty Cash"><PettyCash /></ProtectedRoute>} />
          <Route path="/finance/petty-cash/new" element={<ProtectedRoute module="Petty Cash" action="create"><PettyCashNew /></ProtectedRoute>} />
          <Route path="/finance/freight-ledger-all" element={<ProtectedRoute module="Freight Ledger"><FreightLedgerAll /></ProtectedRoute>} />
          <Route path="/finance/wage-ledger-all" element={<ProtectedRoute module="Wage Ledger"><WageLedgerAll /></ProtectedRoute>} />
          <Route path="/finance/expense-ledger" element={<ProtectedRoute module="Expense Ledger"><ExpenseLedger /></ProtectedRoute>} />
          <Route path="/finance/petty-cash-ledger" element={<ProtectedRoute module="Petty Cash Ledger"><PettyCashLedger /></ProtectedRoute>} />
          {/* 'Ledgers' moved to Import Data › Party Ledgers — keep the old link alive */}
          <Route path="/finance/ledgers" element={<Navigate to="/import/ledgers" replace />} />

          {/* ========== EXPENSES ========== */}
          <Route path="/expenses/imprest" element={<ProtectedRoute module="Imprest"><ImprestPage /></ProtectedRoute>} />
          <Route path="/expenses/voucher" element={<ProtectedRoute module="Voucher"><VoucherPage /></ProtectedRoute>} />
          <Route path="/expenses/analytics" element={<ProtectedRoute module="Expense Register"><ExpenseAnalyticsPage /></ProtectedRoute>} />
          <Route path="/expenses/register" element={<ProtectedRoute module="Expense Register"><ExpenseRegisterPage /></ProtectedRoute>} />
          <Route path="/expenses/spend-by-category" element={<ProtectedRoute module="Expense Register"><SpendByCategoryPage /></ProtectedRoute>} />
          <Route path="/expenses/consumables" element={<ProtectedRoute module="Consumables"><ConsumablesPage /></ProtectedRoute>} />
          <Route path="/expenses/bills" element={<ProtectedRoute module="Expense Register"><ExpenseBillsPage /></ProtectedRoute>} />
          {/* Direct/Indirect expense pages merged into the single Expense Bills list.
              Old links land there, pre-filtered to the bucket they used to show. */}
          <Route path="/expenses/direct" element={<Navigate to="/expenses/bills?bucket=DIRECT" replace />} />
          <Route path="/expenses/indirect" element={<Navigate to="/expenses/bills?bucket=INDIRECT" replace />} />

          {/* ========== HR ========== */}
          <Route path="/hr/staff" element={<ProtectedRoute module="Staff"><StaffList /></ProtectedRoute>} />
          <Route path="/hr/staff/new" element={<ProtectedRoute module="Staff" action="create"><StaffNew /></ProtectedRoute>} />
          <Route path="/hr/staff/:id" element={<ProtectedRoute module="Staff"><StaffDetail /></ProtectedRoute>} />
          <Route path="/hr/attendance" element={<ProtectedRoute module="Attendance"><AttendanceList /></ProtectedRoute>} />
          {/* Self check-in — gated on the 'Check In' module (seeded granted to all roles) so it can be hidden per profile. */}
          <Route path="/hr/attendance/check-in" element={<ProtectedRoute module="Check In"><AttendanceCheckIn /></ProtectedRoute>} />
          {/* Self face-enrollment — auth only, same rationale as check-in. */}
          <Route path="/hr/attendance/face-setup" element={<ProtectedRoute><AttendanceFaceSetup /></ProtectedRoute>} />
          <Route path="/hr/attendance/register" element={<ProtectedRoute module="Attendance"><AttendanceRegister /></ProtectedRoute>} />
          <Route path="/hr/attendance/new" element={<ProtectedRoute module="Attendance" action="create"><AttendanceNew /></ProtectedRoute>} />
          <Route path="/hr/attendance/:id" element={<ProtectedRoute module="Attendance"><AttendanceDetail /></ProtectedRoute>} />
          <Route path="/hr/leave" element={<ProtectedRoute module="Leave"><LeaveRequests /></ProtectedRoute>} />
          <Route path="/hr/leave/new" element={<ProtectedRoute module="Leave" action="create"><LeaveNew /></ProtectedRoute>} />
          <Route path="/hr/leave/:id" element={<ProtectedRoute module="Leave"><LeaveDetail /></ProtectedRoute>} />
          <Route path="/hr/overtime" element={<ProtectedRoute module="Overtime"><OvertimeRequests /></ProtectedRoute>} />
          <Route path="/hr/overtime/new" element={<ProtectedRoute module="Overtime" action="create"><OvertimeNew /></ProtectedRoute>} />
          <Route path="/hr/overtime/:id" element={<ProtectedRoute module="Overtime"><OvertimeDetail /></ProtectedRoute>} />
          <Route path="/hr/shifts" element={<ProtectedRoute module="Shift"><ShiftDefinitions /></ProtectedRoute>} />
          <Route path="/hr/shifts/rotation" element={<ProtectedRoute module="Shift"><ShiftRotation /></ProtectedRoute>} />
          <Route path="/hr/shifts/new" element={<ProtectedRoute module="Shift" action="create"><ShiftNew /></ProtectedRoute>} />
          <Route path="/hr/shifts/:id" element={<ProtectedRoute module="Shift"><ShiftDetail /></ProtectedRoute>} />
          <Route path="/hr/payroll" element={<ProtectedRoute module="Payroll"><PayrollExport /></ProtectedRoute>} />
          <Route path="/hr/payroll/adjustments" element={<ProtectedRoute module="Payroll"><PayrollAdjustments /></ProtectedRoute>} />
          <Route path="/hr/payroll/new" element={<ProtectedRoute module="Payroll" action="create"><PayrollNew /></ProtectedRoute>} />
          <Route path="/hr/payroll/:id" element={<ProtectedRoute module="Payroll"><PayrollDetail /></ProtectedRoute>} />
          <Route path="/hr/calendar" element={<ProtectedRoute module="Holiday Calendar"><HolidayCalendar /></ProtectedRoute>} />

          {/* ========== ADMIN RBAC ========== */}
          <Route path="/admin/users" element={<ProtectedRoute adminOnly><AdminUserList /></ProtectedRoute>} />
          <Route path="/admin/users/new" element={<ProtectedRoute adminOnly><AdminUserNew /></ProtectedRoute>} />
          <Route path="/admin/users/:id" element={<ProtectedRoute adminOnly><AdminUserDetail /></ProtectedRoute>} />
          <Route path="/admin/users/:id/edit" element={<ProtectedRoute adminOnly><AdminUserEdit /></ProtectedRoute>} />
          <Route path="/admin/roles" element={<ProtectedRoute adminOnly><AdminRoleList /></ProtectedRoute>} />
          <Route path="/admin/roles/new" element={<ProtectedRoute adminOnly><AdminRoleNew /></ProtectedRoute>} />
          <Route path="/admin/roles/:id" element={<ProtectedRoute adminOnly><AdminRoleDetail /></ProtectedRoute>} />
          <Route path="/admin/permissions" element={<ProtectedRoute adminOnly><AdminPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/sales" element={<ProtectedRoute adminOnly><AdminSalesPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/purchase" element={<ProtectedRoute adminOnly><AdminPurchasePermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/freight" element={<ProtectedRoute adminOnly><AdminFreightPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/production" element={<ProtectedRoute adminOnly><AdminProductionPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/inventory" element={<ProtectedRoute adminOnly><AdminInventoryPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/hr" element={<ProtectedRoute adminOnly><AdminHRPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/finance" element={<ProtectedRoute adminOnly><AdminFinancePermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/bank" element={<ProtectedRoute adminOnly><AdminBankPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/masters" element={<ProtectedRoute adminOnly><AdminMastersPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/reports" element={<ProtectedRoute adminOnly><AdminReportsPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/expenses" element={<ProtectedRoute adminOnly><AdminExpensesPermissions /></ProtectedRoute>} />
          <Route path="/admin/permissions/import" element={<ProtectedRoute adminOnly><AdminImportPermissions /></ProtectedRoute>} />
          <Route path="/admin/audit-logs" element={<ProtectedRoute adminOnly><AuditLogViewer /></ProtectedRoute>} />
          <Route path="/admin/email-templates" element={<ProtectedRoute adminOnly><EmailTemplateList /></ProtectedRoute>} />
          <Route path="/admin/email-templates/new" element={<ProtectedRoute adminOnly><EmailTemplateForm /></ProtectedRoute>} />
          <Route path="/admin/email-templates/:id/edit" element={<ProtectedRoute adminOnly><EmailTemplateForm /></ProtectedRoute>} />

          {/* Catch all — a real 404 that keeps the user in the app instead
              of silently bouncing a logged-in user to /login. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
       </ErrorBoundary>
      </div>

      <SwipeToaster />
      <ConfirmHost />
      <PartyLinkPickerHost />
      <PromptHost />
      <GlobalTooltip />
    </>
  );
}

export default App;
