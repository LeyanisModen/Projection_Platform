import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name('capture_service.py')
SPEC = importlib.util.spec_from_file_location('moden_capture_service_logs', MODULE_PATH)
CAPTURE_SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE_SERVICE)


class LogUploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.logs = Path(self.tmp.name)
        self.sent = []
        self.fail = None

        def fake_request(method, url, token, payload=None):
            if self.fail:
                raise self.fail
            self.sent.append(payload)
            return {}

        for target, value in (
            ('_logs_dir', lambda: self.logs),
            ('_read_stored_token', lambda: 'device-token'),
            ('_remote_request_json', fake_request),
        ):
            patcher = patch.object(CAPTURE_SERVICE, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, text, mode='a'):
        with (self.logs / name).open(mode, encoding='utf-8', newline='') as handle:
            handle.write(text)

    def texts(self):
        return [(item['fichero'], item['contenido']) for item in self.sent]

    def test_sends_whole_lines_once(self):
        self.write('player-watchdog.log', 'a\r\nb\r\nmedia linea')
        self.assertIsNone(CAPTURE_SERVICE._upload_logs_once())
        self.assertEqual(self.texts(), [('player-watchdog.log', 'a\r\nb\r\n')])

        # The half-written line goes once it is complete, nothing else repeats.
        self.write('player-watchdog.log', ' entera\r\nc\r\n')
        CAPTURE_SERVICE._upload_logs_once()
        self.assertEqual(self.texts()[1:], [('player-watchdog.log', 'media linea entera\r\nc\r\n')])
        CAPTURE_SERVICE._upload_logs_once()
        self.assertEqual(len(self.sent), 2)

    def test_emptied_log_starts_again(self):
        self.write('player-watchdog.log', 'linea larga de antes\r\n')
        CAPTURE_SERVICE._upload_logs_once()
        # The watchdog clears its log at 1 MB and keeps writing.
        self.write('player-watchdog.log', 'nueva\r\n', mode='w')
        CAPTURE_SERVICE._upload_logs_once()
        self.assertEqual(self.texts()[-1], ('player-watchdog.log', 'nueva\r\n'))

    def test_first_run_sends_only_the_end_from_a_whole_line(self):
        self.write('auto-update.log', ''.join(f'linea {n:03}\n' for n in range(100)))
        with patch.object(CAPTURE_SERVICE, 'LOG_UPLOAD_FIRST_BYTES', 25):
            CAPTURE_SERVICE._upload_logs_once()
        self.assertEqual(self.texts(), [('auto-update.log', 'linea 098\nlinea 099\n')])

    def test_large_log_goes_in_chunks(self):
        self.write('player-watchdog.log', ''.join(f'linea {n:03}\n' for n in range(10)))
        with patch.object(CAPTURE_SERVICE, 'LOG_UPLOAD_CHUNK_BYTES', 25):
            CAPTURE_SERVICE._upload_logs_once()
        self.assertEqual(''.join(text for _, text in self.texts()), ''.join(f'linea {n:03}\n' for n in range(10)))
        self.assertGreater(len(self.sent), 1)

    def test_failed_upload_is_retried_next_round(self):
        self.write('player-watchdog.log', 'foco\r\n')
        self.fail = CAPTURE_SERVICE.RemoteConfigTransientError('HTTP 502')
        self.assertIn('HTTP 502', CAPTURE_SERVICE._upload_logs_once())
        self.fail = None
        CAPTURE_SERVICE._upload_logs_once()
        self.assertEqual(self.texts(), [('player-watchdog.log', 'foco\r\n')])

    def test_utf8_bom_is_dropped(self):
        (self.logs / 'player-watchdog.log').write_bytes('﻿2026-10-30 15:12 foco\r\n'.encode('utf-8'))
        CAPTURE_SERVICE._upload_logs_once()
        self.assertEqual(self.texts(), [('player-watchdog.log', '2026-10-30 15:12 foco\r\n')])


if __name__ == '__main__':
    unittest.main()
