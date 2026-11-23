from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    NotificationViewSet,
    push_subscribe,
    push_test,
    push_unsubscribe,
    push_vapid_key,
)

router = DefaultRouter()
router.register(r'', NotificationViewSet, basename='notification')

# Explicit push routes first so they take precedence over the router's
# catch-all detail patterns.
urlpatterns = [
    path('push/vapid-key/', push_vapid_key, name='push-vapid-key'),
    path('push/subscribe/', push_subscribe, name='push-subscribe'),
    path('push/unsubscribe/', push_unsubscribe, name='push-unsubscribe'),
    path('push/test/', push_test, name='push-test'),
] + router.urls
