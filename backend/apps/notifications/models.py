from django.conf import settings
from django.db import models


class Notification(models.Model):
    """A single in-app notification delivered to one user.

    Notifications are created per-recipient (fan-out at creation time) so
    the list/unread-count queries stay a trivial indexed filter on
    ``recipient``. Role-targeted events resolve to the set of users in
    that role and create one row each — see ``notifications.services``.
    """

    LEVEL_CHOICES = [
        ('info', 'Info'),
        ('success', 'Success'),
        ('warning', 'Warning'),
        ('danger', 'Danger'),
    ]

    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='notifications',
    )
    # Who triggered it (the approver, the submitter, …). Optional —
    # system/scheduled notifications have no actor.
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
    )
    title = models.CharField(max_length=255)
    message = models.TextField(blank=True, default='')
    # Free-form bucket for grouping/filtering, e.g. 'approval', 'overdue'.
    category = models.CharField(max_length=50, blank=True, default='', db_index=True)
    level = models.CharField(max_length=10, choices=LEVEL_CHOICES, default='info')
    # Frontend route to open when the notification is clicked, e.g.
    # '/purchase/requests/<uuid>'. Stored as a relative path.
    link = models.CharField(max_length=500, blank=True, default='')
    is_read = models.BooleanField(default=False)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'notifications_notification'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['recipient', 'is_read', '-created_at']),
        ]

    def __str__(self):
        return f'{self.recipient_id} · {self.title}'


class PushSubscription(models.Model):
    """A browser Web Push subscription for one user on one device.

    Created when the user taps "Enable notifications" on a device, and used
    to deliver native push (which fire even when the PWA is closed). The
    endpoint is unique per device, so a user can hold several (phone +
    laptop). Dead endpoints (404/410 from the push service) are pruned on
    the next send — see ``notifications.push``.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='push_subscriptions',
    )
    # NOT globally unique: a shared device (same endpoint, different logins)
    # may legitimately hold a row per user. Uniqueness is per (user, endpoint)
    # so one user can never overwrite another user's device binding.
    endpoint = models.URLField(max_length=1000)
    p256dh = models.CharField(max_length=255)
    auth = models.CharField(max_length=255)
    user_agent = models.CharField(max_length=300, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'notifications_push_subscription'
        indexes = [models.Index(fields=['user'])]
        unique_together = (('user', 'endpoint'),)

    def __str__(self):
        return f'{self.user_id} · {self.endpoint[:40]}'
