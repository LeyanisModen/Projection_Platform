"""Liveness/readiness endpoint for Railway healthchecks and smoke tests.

Deliberately outside api/views.py: it must import nothing heavy and never
touch business logic. A 200 means the process is up and the database
answers; anything else fails the Railway deploy instead of routing traffic
to a broken container.
"""
from django.db import connection
from django.db.utils import OperationalError
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.views import APIView


class HealthView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    # Railway hits this with Host: healthcheck.railway.app; settings.py adds
    # that host to ALLOWED_HOSTS when running on Railway.

    def get(self, request):
        try:
            with connection.cursor() as cursor:
                cursor.execute('SELECT 1')
                cursor.fetchone()
        except OperationalError as exc:
            return Response({'status': 'error', 'database': str(exc)[:200]}, status=503)
        return Response({'status': 'ok', 'database': 'ok'})
