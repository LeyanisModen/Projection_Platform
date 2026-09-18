from unittest.mock import patch

from django.db.utils import OperationalError
from rest_framework.test import APITestCase


class HealthEndpointTests(APITestCase):
    def test_health_is_public_and_reports_database(self):
        response = self.client.get('/api/health/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {'status': 'ok', 'database': 'ok'})

    def test_health_accepts_railway_healthcheck_host(self):
        # Railway's healthcheck sends this Host header; ALLOWED_HOSTS must
        # not reject it or every deploy fails.
        with self.settings(ALLOWED_HOSTS=['healthcheck.railway.app']):
            response = self.client.get('/api/health/', HTTP_HOST='healthcheck.railway.app')
        self.assertEqual(response.status_code, 200)

    def test_health_reports_503_when_database_is_down(self):
        with patch('api.health.connection') as conn:
            conn.cursor.side_effect = OperationalError('connection refused')
            response = self.client.get('/api/health/')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data['status'], 'error')
