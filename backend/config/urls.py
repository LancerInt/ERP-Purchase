"""Standalone URL config: login + master + users/roles + staff."""
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.http import JsonResponse

from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenVerifyView

from core.jwt_auth import (
    LastLoginTokenRefreshView, LogoutAllView, LogoutView,
    MessagefulTokenObtainPairView,
)
from core.views import (
    CompanyViewSet, WarehouseViewSet, GodownViewSet,
    RoleDefinitionViewSet, StakeholderUserViewSet, AppSettingsView,
)
from master.views import (
    ProductViewSet, ServiceCatalogueViewSet, VendorViewSet, CustomerViewSet,
    TransporterViewSet, PriceListViewSet, TaxMasterViewSet,
    TemplateLibraryViewSet, BrokerViewSet, StateGroupViewSet,
    ShippingAddressViewSet, MachineryDivisionViewSet, MachineryExpenseViewSet,
    ExpenseCategoryViewSet, MasterAttachmentViewSet, party_match_preview,
)
from purchase.views import (
    PurchaseRequestViewSet, RFQHeaderViewSet, QuoteResponseViewSet,
    QuoteEvaluationViewSet, PurchaseOrderViewSet, ReceiptAdviceViewSet,
    VendorPaymentAdviceViewSet, FreightAdviceInboundViewSet,
    FreightPaymentInboundViewSet, WageEntryViewSet, WagePaymentViewSet,
    VendorBillViewSet, PaymentMadeViewSet, VendorCreditViewSet,
    PurchaseAttachmentViewSet, MaterialRejectionViewSet,
    VendorProductMappingViewSet, PurchaseItemsView,
    EvaluationDashboardView, EvaluationDashboardSubmitView,
    PurchaseLifecycleGraphView,
)
from purchase.local_freight import LocalFreightViewSet
from purchase.amendment import POAmendmentRequestViewSet
from purchase.dashboard_views import (
    PurchaseDashboardView, PurchaseDashboardRecordsView, PurchaseAnalyticsView,
    PurchaseMonthlyBreakdownView,
    PaidByCategoryView, PurchasePayablesCalendarView,
)
from purchase.freight_overview_views import FreightOverviewView
from purchase.category_views import (
    PurchaseByCategoryView, PurchaseByCategoryItemsView, ExpenseVouchersView,
)
from purchase.report_views import ConsolidatedReportView, PurchaseReportView
from purchase.item_rate_trend_views import PurchaseItemRateTrendView, PurchaseItemVendorBillsView
from purchase.tds_summary_views import TdsSummaryView
from purchase.tds_bill_views import TdsBillsView
from purchase.stock_views import StockView, StockProductView
from ai_parser.gst2b_views import Gst2BUploadView, Gst2BListView, Gst2BReportView
from bank.views import BankAccountViewSet, BankStatementUploadViewSet
from finance.ledger_views import VendorLedgerEntriesView
from ai_parser.scan_views import (
    ScanUploadView, ScanBatchListView, ScanBatchDetailView, ScanBillDetailView,
    ScanBillActionView, ScanSuggestView, GstinLookupView, ScanConvertedView,
    ScanFreightBillsView, ScanDocRetryView, ScanDocFileView, ScanLocationsView,
    ScanProductSearchView, ScanBillSearchView, ScanLinkCandidatesView,
    ScanTypeOptionView, ScanTypeOptionDetailView,
)


def health(_request):
    return JsonResponse({'status': 'ok'})


def empty_list(_request):
    """Stub for optional lookups not shipped in this standalone (finance
    ledgers, sales receivables) so the UI's dropdowns resolve to empty."""
    return JsonResponse({'count': 0, 'results': []})


router = DefaultRouter()

# Core (org + users + roles)
router.register(r'companies', CompanyViewSet, basename='company')
router.register(r'warehouses', WarehouseViewSet, basename='warehouse')
router.register(r'godowns', GodownViewSet, basename='godown')
router.register(r'roles', RoleDefinitionViewSet, basename='role')
router.register(r'users', StakeholderUserViewSet, basename='user')

# Master
router.register(r'products', ProductViewSet, basename='product')
router.register(r'service-catalogues', ServiceCatalogueViewSet, basename='service-catalogue')
router.register(r'vendors', VendorViewSet, basename='vendor')
router.register(r'customers', CustomerViewSet, basename='customer')
router.register(r'shipping-addresses', ShippingAddressViewSet, basename='shipping-address')
router.register(r'transporters', TransporterViewSet, basename='transporter')
router.register(r'price-lists', PriceListViewSet, basename='price-list')
router.register(r'state-groups', StateGroupViewSet, basename='state-group')
router.register(r'taxes', TaxMasterViewSet, basename='tax')
router.register(r'templates', TemplateLibraryViewSet, basename='template')
router.register(r'brokers', BrokerViewSet, basename='broker')
router.register(r'machinery-divisions', MachineryDivisionViewSet, basename='machinery-division')
router.register(r'machinery-expenses', MachineryExpenseViewSet, basename='machinery-expense')
router.register(r'expense-categories', ExpenseCategoryViewSet, basename='expense-category')
router.register(r'product-attachments', MasterAttachmentViewSet, basename='product-attachment')

# Bank accounts (for the payment "paid from" picker)
router.register(r'bank/accounts', BankAccountViewSet, basename='bank-account')
# Bank statement upload + parse (standalone, no Tally reconcile). Mounted at
# the path the frontend ImportBankStatements page already calls.
router.register(r'finance/bank-statements', BankStatementUploadViewSet, basename='bank-statement')

# Purchase
router.register(r'purchase/requests', PurchaseRequestViewSet, basename='purchase-request')
router.register(r'purchase/rfq', RFQHeaderViewSet, basename='rfq')
router.register(r'purchase/quotes', QuoteResponseViewSet, basename='quote')
router.register(r'purchase/evaluations', QuoteEvaluationViewSet, basename='evaluation')
router.register(r'purchase/orders', PurchaseOrderViewSet, basename='purchase-order')
router.register(r'purchase/po-amendments', POAmendmentRequestViewSet, basename='po-amendment')
router.register(r'purchase/receipts', ReceiptAdviceViewSet, basename='receipt')
router.register(r'purchase/payments', VendorPaymentAdviceViewSet, basename='vendor-payment')
router.register(r'purchase/freight', FreightAdviceInboundViewSet, basename='purchase-freight')
router.register(r'purchase/freight-payments', FreightPaymentInboundViewSet, basename='purchase-freight-payment')
router.register(r'purchase/local-freight', LocalFreightViewSet, basename='local-freight')
router.register(r'purchase/wage-entries', WageEntryViewSet, basename='wage-entry')
router.register(r'purchase/wage-payments', WagePaymentViewSet, basename='wage-payment')
router.register(r'purchase/bills', VendorBillViewSet, basename='vendor-bill')
router.register(r'purchase/payments-made', PaymentMadeViewSet, basename='payment-made')
router.register(r'purchase/vendor-credits', VendorCreditViewSet, basename='vendor-credit')
router.register(r'purchase/attachments', PurchaseAttachmentViewSet, basename='purchase-attachment')
router.register(r'purchase/rejections', MaterialRejectionViewSet, basename='material-rejection')
router.register(r'purchase/vendor-product-mappings', VendorProductMappingViewSet, basename='vendor-product-mapping')

urlpatterns = [
    path('healthz/', health),
    path('admin/', admin.site.urls),

    # Authentication
    path('api/token/', MessagefulTokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('api/token/refresh/', LastLoginTokenRefreshView.as_view(), name='token_refresh'),
    path('api/token/verify/', TokenVerifyView.as_view(), name='token_verify'),
    path('api/token/logout/', LogoutView.as_view(), name='token_logout'),
    path('api/token/logout-all/', LogoutAllView.as_view(), name='token_logout_all'),

    # App settings
    path('api/settings/', AppSettingsView.as_view(), name='app-settings'),

    # MFA (two-factor)
    path('api/mfa/', include('mfa.urls')),

    # RBAC (roles / permissions / modules)
    path('api/rbac/', include('rbac.urls')),

    # Staff (trimmed hr app)
    path('api/hr/', include('hr.urls')),

    # Master party-match helper
    path('api/master/party-match/', party_match_preview, name='master-party-match'),

    # Vendor Ledger — running statement per vendor (bills vs payments).
    path('api/finance/vendor-ledger-entries/', VendorLedgerEntriesView.as_view(), name='finance-vendor-ledger-entries'),

    # Optional lookups not shipped here (finance/sales) — empty so UI resolves.
    path('api/finance/ledgers/', empty_list, name='finance-ledgers-stub'),
    path('api/sales/receivables/', empty_list, name='sales-receivables-stub'),

    # Communications (email templates, logs, sending)
    path('api/communications/', include('communications.urls')),

    # Purchase extra views (non-router)
    path('api/purchase/items/', PurchaseItemsView.as_view(), name='purchase-items'),
    path('api/purchase/dashboard/', PurchaseDashboardView.as_view(), name='purchase-dashboard'),
    path('api/purchase/dashboard/records/', PurchaseDashboardRecordsView.as_view(), name='purchase-dashboard-records'),
    path('api/purchase/dashboard/analytics/', PurchaseAnalyticsView.as_view(), name='purchase-dashboard-analytics'),
    path('api/purchase/monthly-breakdown/', PurchaseMonthlyBreakdownView.as_view(), name='purchase-monthly-breakdown'),
    path('api/purchase/dashboard/paid-by-category/', PaidByCategoryView.as_view(), name='purchase-paid-by-category'),
    path('api/purchase/payables-calendar/', PurchasePayablesCalendarView.as_view(), name='purchase-payables-calendar'),
    path('api/purchase/freight-overview/', FreightOverviewView.as_view(), name='freight-overview'),
    path('api/purchase/by-category/', PurchaseByCategoryView.as_view(), name='purchase-by-category'),
    path('api/purchase/by-category/items/', PurchaseByCategoryItemsView.as_view(), name='purchase-by-category-items'),
    path('api/purchase/expense-vouchers/', ExpenseVouchersView.as_view(), name='purchase-expense-vouchers'),
    path('api/purchase/consolidated-report/', ConsolidatedReportView.as_view(), name='purchase-consolidated-report'),
    path('api/purchase/purchase-report/', PurchaseReportView.as_view(), name='purchase-report'),
    path('api/purchase/item-rate-trend/', PurchaseItemRateTrendView.as_view(), name='purchase-item-rate-trend'),
    path('api/purchase/item-vendor-bills/', PurchaseItemVendorBillsView.as_view(), name='purchase-item-vendor-bills'),
    path('api/purchase/tds-summary/', TdsSummaryView.as_view(), name='tds-summary'),
    path('api/purchase/tds-bills/', TdsBillsView.as_view(), name='tds-bills'),
    # Stock on-hand (derived from purchase receipts)
    path('api/purchase/stock/', StockView.as_view(), name='purchase-stock'),
    path('api/purchase/stock/<uuid:product_id>/', StockProductView.as_view(), name='purchase-stock-product'),
    # GST 2B reconciliation (upload GSTR-2B, match against purchase bills)
    path('api/purchase/gst2b/upload/', Gst2BUploadView.as_view(), name='gst2b-upload'),
    path('api/purchase/gst2b/', Gst2BListView.as_view(), name='gst2b-list'),
    path('api/purchase/gst2b/<uuid:pk>/', Gst2BReportView.as_view(), name='gst2b-report'),

    # Invoice Scan Inbox — bulk scan (OCR) → item lines on vendor bills
    path('api/purchase/scan/upload/', ScanUploadView.as_view(), name='scan-upload'),
    path('api/purchase/scan/batches/', ScanBatchListView.as_view(), name='scan-batches'),
    path('api/purchase/scan/batches/<uuid:pk>/', ScanBatchDetailView.as_view(), name='scan-batch-detail'),
    path('api/purchase/scan/bills/<uuid:pk>/', ScanBillDetailView.as_view(), name='scan-bill-detail'),
    path('api/purchase/scan/bills/<uuid:pk>/<str:action>/', ScanBillActionView.as_view(), name='scan-bill-action'),
    path('api/purchase/scan/suggest/', ScanSuggestView.as_view(), name='scan-suggest'),
    path('api/purchase/scan/gstin/', GstinLookupView.as_view(), name='scan-gstin-lookup'),
    path('api/purchase/scan/locations/', ScanLocationsView.as_view(), name='scan-locations'),
    path('api/purchase/scan/type-options/', ScanTypeOptionView.as_view(), name='scan-type-options'),
    path('api/purchase/scan/type-options/<uuid:pk>/', ScanTypeOptionDetailView.as_view(), name='scan-type-option-detail'),
    path('api/purchase/scan/product-search/', ScanProductSearchView.as_view(), name='scan-product-search'),
    path('api/purchase/scan/bill-search/', ScanBillSearchView.as_view(), name='scan-bill-search'),
    path('api/purchase/scan/link-candidates/<uuid:pk>/', ScanLinkCandidatesView.as_view(), name='scan-link-candidates'),
    path('api/purchase/scan/converted/', ScanConvertedView.as_view(), name='scan-converted'),
    path('api/purchase/scan/freight-bills/', ScanFreightBillsView.as_view(), name='scan-freight-bills'),
    path('api/purchase/scan/documents/<uuid:pk>/retry/', ScanDocRetryView.as_view(), name='scan-doc-retry'),
    path('api/purchase/scan/documents/<uuid:pk>/file/', ScanDocFileView.as_view(), name='scan-doc-file'),
    path('api/purchase/lifecycle-graph/', PurchaseLifecycleGraphView.as_view(), name='purchase-lifecycle-graph'),
    path('api/purchase/evaluation-dashboard/', EvaluationDashboardView.as_view(), name='purchase-evaluation-dashboard'),
    path('api/purchase/evaluation-dashboard/submit/', EvaluationDashboardSubmitView.as_view(), name='purchase-evaluation-dashboard-submit'),

    # Core + master + purchase routers
    path('api/', include(router.urls)),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
