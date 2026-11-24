from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    EmailTemplateViewSet, EmailLogViewSet,
    email_suggestions, send_rfq_emails, resolved_sender,
)

router = DefaultRouter()
router.register(r'templates', EmailTemplateViewSet, basename='email-template')
router.register(r'email-logs', EmailLogViewSet, basename='email-log')

urlpatterns = [
    path('email-suggestions/', email_suggestions, name='email-suggestions'),
    path('rfq-emails/send-emails/', send_rfq_emails, name='send-rfq-emails'),
    path('resolved-sender/', resolved_sender, name='resolved-sender'),
    path('', include(router.urls)),
]
