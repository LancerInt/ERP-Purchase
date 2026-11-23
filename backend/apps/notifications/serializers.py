from rest_framework import serializers

from .models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    actor_name = serializers.SerializerMethodField()
    # Alias kept because the existing bell UI reads `timestamp`.
    timestamp = serializers.DateTimeField(source='created_at', read_only=True)

    class Meta:
        model = Notification
        fields = [
            'id', 'title', 'message', 'category', 'level', 'link',
            'is_read', 'created_at', 'timestamp', 'actor_name',
        ]
        read_only_fields = fields

    def get_actor_name(self, obj):
        if obj.actor_id and obj.actor:
            return obj.actor.get_full_name() or obj.actor.username
        return ''
