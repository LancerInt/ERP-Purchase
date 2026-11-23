from django.apps import AppConfig


class MasterConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'master'
    verbose_name = 'Master Data'

    def ready(self):
        # Audit trail on the master-data entities auditors ask about
        # most: vendor GSTIN edits, product HSN/GST edits, price list
        # changes, tax master changes. Line rows (PriceLine,
        # VendorBankDetail, etc.) are NOT registered because a parent
        # save cascades them and the header event carries the signal.
        from common.audit import register_audited_model
        from .models import (
            Product,
            ServiceCatalogue,
            Vendor,
            Customer,
            Transporter,
            PriceList,
            TaxMaster,
            Broker,
            StateGroup,
            MachineryDivision,
            MachineryExpense,
        )
        register_audited_model(Product, 'Product')
        register_audited_model(ServiceCatalogue, 'Service Catalogue')
        register_audited_model(Vendor, 'Vendor')
        register_audited_model(Customer, 'Customer')
        register_audited_model(Transporter, 'Transporter')
        register_audited_model(PriceList, 'Price List')
        register_audited_model(TaxMaster, 'Tax Master')
        register_audited_model(Broker, 'Broker')
        register_audited_model(StateGroup, 'State Group')
        register_audited_model(MachineryDivision, 'Machinery Division')
        register_audited_model(MachineryExpense, 'Machinery Expense')
