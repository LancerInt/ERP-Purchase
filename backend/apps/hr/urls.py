"""HR URL routing (standalone) — Staff only."""
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r'staff', views.StaffViewSet, basename='staff')
router.register(r'staff-bank-accounts', views.StaffBankAccountViewSet, basename='staff-bank-account')
router.register(r'staff-id-proofs', views.StaffIDProofViewSet, basename='staff-id-proof')

app_name = 'hr'
urlpatterns = router.urls
