from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Notification, PushSubscription
from .push import vapid_public_key
from .serializers import NotificationSerializer


class NotificationViewSet(mixins.ListModelMixin, mixins.DestroyModelMixin,
                          viewsets.GenericViewSet):
    """Current user's notifications.

    GET    /api/notifications/                  → { results, unread_count }
    GET    /api/notifications/unread-count/     → { unread_count }
    POST   /api/notifications/<id>/mark-read/   → the updated notification
    POST   /api/notifications/mark-all-read/    → { unread_count: 0 }
    DELETE /api/notifications/<id>/             → remove one notification
    POST   /api/notifications/clear-all/        → remove all of the user's
    """

    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Notification.objects.filter(recipient=self.request.user)

    def list(self, request, *args, **kwargs):
        # Cap the payload — the bell shows recent items, not full history.
        qs = self.get_queryset()
        data = self.get_serializer(qs[:50], many=True).data
        unread = qs.filter(is_read=False).count()
        return Response({'results': data, 'unread_count': unread})

    @action(detail=False, methods=['get'], url_path='unread-count')
    def unread_count(self, request):
        count = self.get_queryset().filter(is_read=False).count()
        return Response({'unread_count': count})

    @action(detail=True, methods=['post'], url_path='mark-read')
    def mark_read(self, request, pk=None):
        notification = self.get_queryset().filter(pk=pk).first()
        if notification is None:
            return Response(status=status.HTTP_404_NOT_FOUND)
        if not notification.is_read:
            notification.is_read = True
            notification.read_at = timezone.now()
            notification.save(update_fields=['is_read', 'read_at'])
        return Response(self.get_serializer(notification).data)

    @action(detail=False, methods=['post'], url_path='mark-all-read')
    def mark_all_read(self, request):
        self.get_queryset().filter(is_read=False).update(
            is_read=True, read_at=timezone.now(),
        )
        return Response({'unread_count': 0})

    @action(detail=False, methods=['post'], url_path='clear-all')
    def clear_all(self, request):
        """Delete all of the caller's notifications."""
        self.get_queryset().delete()
        return Response({'unread_count': 0})


# ── Web Push (native notifications) ──────────────────────────────────────

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def push_vapid_key(request):
    """Public VAPID key the browser needs to create a subscription."""
    return Response({'public_key': vapid_public_key()})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def push_subscribe(request):
    """Register (or refresh) the caller's Web Push subscription for a device."""
    endpoint = (request.data.get('endpoint') or '').strip()
    keys = request.data.get('keys') or {}
    p256dh = (keys.get('p256dh') or '').strip()
    auth = (keys.get('auth') or '').strip()
    if not endpoint or not p256dh or not auth:
        return Response({'error': 'endpoint and keys (p256dh, auth) are required.'},
                        status=status.HTTP_400_BAD_REQUEST)
    # Upsert keyed on (caller, endpoint): a user only ever creates/refreshes
    # THEIR OWN subscription for a device, so no one can hijack or knock out
    # another user's device by replaying its endpoint.
    PushSubscription.objects.update_or_create(
        user=request.user,
        endpoint=endpoint,
        defaults={
            'p256dh': p256dh,
            'auth': auth,
            'user_agent': (request.data.get('user_agent') or '')[:300],
        },
    )
    return Response({'ok': True}, status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def push_unsubscribe(request):
    """Remove a device subscription (on disable / logout)."""
    endpoint = (request.data.get('endpoint') or '').strip()
    if endpoint:
        PushSubscription.objects.filter(endpoint=endpoint, user=request.user).delete()
    return Response({'ok': True})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def push_test(request):
    """Send a test push to the caller and return a diagnostic of why it did or
    didn't arrive (VAPID config, subscriptions, send result)."""
    from .push import send_test_push
    return Response(send_test_push(request.user))
