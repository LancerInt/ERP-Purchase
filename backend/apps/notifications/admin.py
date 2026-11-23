from django.contrib import admin

from .models import Notification


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ('title', 'recipient', 'category', 'level', 'is_read', 'created_at')
    list_filter = ('is_read', 'level', 'category')
    search_fields = ('title', 'message', 'recipient__username')
    raw_id_fields = ('recipient', 'actor')
    date_hierarchy = 'created_at'
