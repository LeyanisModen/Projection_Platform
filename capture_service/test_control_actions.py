import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name('capture_service.py')
SPEC = importlib.util.spec_from_file_location('moden_capture_service_controls', MODULE_PATH)
CAPTURE_SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE_SERVICE)


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
