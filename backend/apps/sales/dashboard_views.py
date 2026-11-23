"""Stub SalesDashboardView — purchase's ConsolidatedReport imports this to
blend sales stats into a combined view. In this Purchase-only build there is
no sales data, so it returns empty stats (the consolidated report then shows
purchase figures only).
"""
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated


class SalesDashboardView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        return Response({'stats': {}})
