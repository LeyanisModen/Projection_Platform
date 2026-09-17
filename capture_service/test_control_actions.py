import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name('capture_service.py')
SPEC = importlib.util.spec_from_file_location('moden_capture_service_controls', MODULE_PATH)
CAPTURE_SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE_SERVICE)


def make_handler(headers):
    """CaptureHandler without a socket: enough to exercise the origin
    checks and the CORS headers it emits."""
    handler = CAPTURE_SERVICE.CaptureHandler.__new__(CAPTURE_SERVICE.CaptureHandler)
    handler.headers = headers
    handler.sent_headers = []
    handler.send_header = lambda key, value: handler.sent_headers.append((key, value))
    return handler


class ControlOriginTests(unittest.TestCase):
    PROD = 'https://moden.up.railway.app'

    def test_control_requires_allowlisted_origin_and_action(self):
        handler = make_handler({'Origin': self.PROD, 'X-Moden-Action': 'shutdown-pc'})
        self.assertTrue(handler._is_control_request_allowed('shutdown-pc'))

    def test_control_without_origin_is_rejected(self):
        # curl / a local script must not be able to power the PC off.
        handler = make_handler({'X-Moden-Action': 'shutdown-pc'})
        self.assertFalse(handler._is_control_request_allowed('shutdown-pc'))

    def test_control_from_unknown_origin_is_rejected(self):
        handler = make_handler({'Origin': 'https://evil.example', 'X-Moden-Action': 'shutdown-pc'})
        self.assertFalse(handler._is_control_request_allowed('shutdown-pc'))

    def test_control_with_wrong_action_is_rejected(self):
        handler = make_handler({'Origin': self.PROD, 'X-Moden-Action': 'close-browser'})
        self.assertFalse(handler._is_control_request_allowed('shutdown-pc'))

    def test_config_can_extend_allowed_origins(self):
        original = CAPTURE_SERVICE.CONFIG.allowed_origins
        try:
            CAPTURE_SERVICE.CONFIG.allowed_origins = {'https://nuevo-dominio.example'}
            handler = make_handler({'Origin': 'https://nuevo-dominio.example', 'X-Moden-Action': 'close-browser'})
            self.assertTrue(handler._is_control_request_allowed('close-browser'))
        finally:
            CAPTURE_SERVICE.CONFIG.allowed_origins = original


class DeviceTokenOriginTests(unittest.TestCase):
    PROD = 'https://moden.up.railway.app'

    def test_token_allowed_for_visor_origin_and_cors_reflects_it(self):
        handler = make_handler({'Origin': self.PROD})
        self.assertTrue(handler._origin_allowed())
        handler._cors(restricted=True)
        self.assertIn(('Access-Control-Allow-Origin', self.PROD), handler.sent_headers)
        self.assertNotIn(('Access-Control-Allow-Origin', '*'), handler.sent_headers)

    def test_token_allowed_for_local_caller_without_origin(self):
        handler = make_handler({})
        self.assertTrue(handler._origin_allowed())
        handler._cors(restricted=True)
        self.assertFalse(any(k == 'Access-Control-Allow-Origin' for k, _ in handler.sent_headers))

    def test_token_rejected_for_unknown_origin(self):
        handler = make_handler({'Origin': 'https://evil.example'})
        self.assertFalse(handler._origin_allowed())

    def test_open_endpoints_keep_wildcard_cors(self):
        # /capture, /stats and /health must keep working from any frontend
        # domain so a domain change never silently loses photos.
        handler = make_handler({'Origin': 'https://otro-frontend.example'})
        handler._cors()
        self.assertIn(('Access-Control-Allow-Origin', '*'), handler.sent_headers)


class ConfigDefaultsTests(unittest.TestCase):
    def test_default_capture_resolution_is_fullhd(self):
        # 4K hangs the OBSBOT UVC driver on open; a PC with a missing or
        # damaged config.ini must fall back to the safe resolution.
        config = CAPTURE_SERVICE.Config(Path('does-not-exist.ini'))
        self.assertEqual((config.capture_width, config.capture_height), (1920, 1080))


class PcShutdownTests(unittest.TestCase):
    def test_windows_shutdown_is_scheduled_with_short_forced_delay(self):
        with (
            patch.object(CAPTURE_SERVICE.os, 'name', 'nt'),
            patch.object(CAPTURE_SERVICE.subprocess, 'run') as run,
        ):
            run.return_value.returncode = 0
            run.return_value.stderr = ''
            run.return_value.stdout = ''

            scheduled, error = CAPTURE_SERVICE._schedule_pc_shutdown(3)

        self.assertTrue(scheduled)
        self.assertIsNone(error)
        command = run.call_args.args[0]
        self.assertEqual(command, ['shutdown.exe', '/s', '/t', '3', '/f'])

    def test_shutdown_command_failure_is_reported(self):
        with (
            patch.object(CAPTURE_SERVICE.os, 'name', 'nt'),
            patch.object(CAPTURE_SERVICE.subprocess, 'run') as run,
        ):
            run.return_value.returncode = 1
            run.return_value.stderr = 'access denied'
            run.return_value.stdout = ''

            scheduled, error = CAPTURE_SERVICE._schedule_pc_shutdown(3)

        self.assertFalse(scheduled)
        self.assertEqual(error, 'access denied')


if __name__ == '__main__':
    unittest.main()
