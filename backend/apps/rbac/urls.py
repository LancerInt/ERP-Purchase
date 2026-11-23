from django.urls import path, include
from rest_framework.routers import DefaultRouter

from rbac.views import (
    ERPRoleViewSet,
    ERPModuleViewSet,
    ERPPermissionViewSet,
    RolePermissionViewSet,
    RoleFieldPermissionViewSet,
    UserPermissionOverrideViewSet,
    UserFieldPermissionOverrideViewSet,
    AuditLogViewSet,
    UserManagementViewSet,
    user_permissions_view,
    manageable_sales_fields,
    manageable_purchase_fields,
    manageable_freight_fields,
    manageable_production_fields,
    manageable_inventory_fields,
    manageable_hr_fields,
    manageable_import_fields,
    my_field_permissions,
)

router = DefaultRouter()
router.register(r'roles', ERPRoleViewSet, basename='erp-role')
router.register(r'modules', ERPModuleViewSet, basename='erp-module')
router.register(r'permissions', ERPPermissionViewSet, basename='erp-permission')
router.register(r'role-permissions', RolePermissionViewSet, basename='role-permission')
router.register(r'role-field-permissions', RoleFieldPermissionViewSet, basename='role-field-permission')
router.register(r'user-permission-overrides', UserPermissionOverrideViewSet, basename='user-permission-override')
router.register(r'user-field-permission-overrides', UserFieldPermissionOverrideViewSet, basename='user-field-permission-override')
router.register(r'audit-logs', AuditLogViewSet, basename='rbac-audit-log')
router.register(r'users', UserManagementViewSet, basename='rbac-user')

urlpatterns = [
    path('', include(router.urls)),
    path('my-permissions/', user_permissions_view, name='my-permissions'),
    path('my-field-permissions/', my_field_permissions, name='my-field-permissions'),
    path('manageable-sales-fields/', manageable_sales_fields, name='manageable-sales-fields'),
    path('manageable-purchase-fields/', manageable_purchase_fields, name='manageable-purchase-fields'),
    path('manageable-freight-fields/', manageable_freight_fields, name='manageable-freight-fields'),
    path('manageable-production-fields/', manageable_production_fields, name='manageable-production-fields'),
    path('manageable-inventory-fields/', manageable_inventory_fields, name='manageable-inventory-fields'),
    path('manageable-hr-fields/', manageable_hr_fields, name='manageable-hr-fields'),
    path('manageable-import-fields/', manageable_import_fields, name='manageable-import-fields'),
]
