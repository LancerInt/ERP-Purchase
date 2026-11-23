from django_filters import rest_framework as filters

from .models import AuditLog


class AuditLogFilter(filters.FilterSet):
    """Filters for the audit log browser and the per-record activity tab.

    `user`/`module_name` are icontains — the audit browser's filter boxes are
    free text, not an exact-id/exact-name picker. `date_from`/`date_to` gate
    the browser to a bounded window instead of the whole table (see
    AuditLogViewer.jsx), which is what actually makes the list page fast —
    `record_id`/`action` alone still leave 100k+ rows on an unfiltered visit.
    """
    user = filters.CharFilter(field_name='user__username', lookup_expr='icontains')
    module_name = filters.CharFilter(field_name='module_name', lookup_expr='icontains')
    date_from = filters.DateFilter(field_name='timestamp', lookup_expr='date__gte')
    date_to = filters.DateFilter(field_name='timestamp', lookup_expr='date__lte')

    class Meta:
        model = AuditLog
        fields = ['user', 'action', 'module_name', 'record_id', 'date_from', 'date_to']
