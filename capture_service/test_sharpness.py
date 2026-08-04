import importlib.util
import unittest
from datetime import datetime, timedelta
from pathlib import Path


MODULE_PATH = Path(__file__).with_name('capture_service.py')
SPEC = importlib.util.spec_from_file_location('moden_capture_service', MODULE_PATH)
CAPTURE_SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE_SERVICE)


class SharpnessStatusTests(unittest.TestCase):
    def setUp(self):
        self.original_stats = dict(CAPTURE_SERVICE._stats)
        self.original_retry = CAPTURE_SERVICE.CONFIG.sharpness_retry_minutes
        CAPTURE_SERVICE.CONFIG.sharpness_retry_minutes = 15

    def tearDown(self):
        with CAPTURE_SERVICE._stats_lock:
            CAPTURE_SERVICE._stats.clear()
            CAPTURE_SERVICE._stats.update(self.original_stats)
        CAPTURE_SERVICE.CONFIG.sharpness_retry_minutes = self.original_retry

    def test_first_very_low_score_is_warning_until_confirmed(self):
        status, streak = CAPTURE_SERVICE._confirmed_sharpness_status(1.0, 0)
        self.assertEqual(status, 'warning')
        self.assertEqual(streak, 1)

        status, streak = CAPTURE_SERVICE._confirmed_sharpness_status(1.0, streak)
        self.assertEqual(status, 'blurry')
        self.assertEqual(streak, 2)

    def test_recovered_score_clears_blurry_streak(self):
        status, streak = CAPTURE_SERVICE._confirmed_sharpness_status(3.0, 4)
        self.assertEqual(status, 'warning')
        self.assertEqual(streak, 0)

    def test_doubtful_result_is_retried_after_configured_interval(self):
        now = datetime(2026, 8, 4, 8, 0, 0)
        with CAPTURE_SERVICE._stats_lock:
            CAPTURE_SERVICE._stats.update({
                'sharpness_status': 'blurry',
                'sharpness_checked_date': now.date().isoformat(),
                'sharpness_checked_at': (
                    now - timedelta(minutes=14)
                ).isoformat(timespec='seconds'),
                'sharpness_blurry_streak': 2,
            })

        self.assertFalse(CAPTURE_SERVICE._sharpness_check_due(now))
        self.assertTrue(
            CAPTURE_SERVICE._sharpness_check_due(
                now + timedelta(minutes=1)
            )
        )

    def test_conclusive_result_is_not_repeated_same_day(self):
        now = datetime(2026, 8, 4, 8, 0, 0)
        with CAPTURE_SERVICE._stats_lock:
            CAPTURE_SERVICE._stats.update({
                'sharpness_status': 'ok',
                'sharpness_checked_date': now.date().isoformat(),
                'sharpness_checked_at': (
                    now - timedelta(hours=3)
                ).isoformat(timespec='seconds'),
                'sharpness_blurry_streak': 0,
            })

        self.assertFalse(CAPTURE_SERVICE._sharpness_check_due(now))


class ActiveWindowTests(unittest.TestCase):
    def setUp(self):
        self.original_values = (
            CAPTURE_SERVICE.CONFIG.active_days,
            CAPTURE_SERVICE.CONFIG.active_start_hour,
            CAPTURE_SERVICE.CONFIG.active_start_minute,
            CAPTURE_SERVICE.CONFIG.active_end_hour,
            CAPTURE_SERVICE.CONFIG.active_end_minute,
        )
        CAPTURE_SERVICE.CONFIG.active_days = {0, 1, 2, 3, 4}
        CAPTURE_SERVICE.CONFIG.active_start_hour = 6
        CAPTURE_SERVICE.CONFIG.active_start_minute = 50
        CAPTURE_SERVICE.CONFIG.active_end_hour = 15
        CAPTURE_SERVICE.CONFIG.active_end_minute = 0

    def tearDown(self):
        (
            CAPTURE_SERVICE.CONFIG.active_days,
            CAPTURE_SERVICE.CONFIG.active_start_hour,
            CAPTURE_SERVICE.CONFIG.active_start_minute,
            CAPTURE_SERVICE.CONFIG.active_end_hour,
            CAPTURE_SERVICE.CONFIG.active_end_minute,
        ) = self.original_values

    def test_window_starts_exactly_at_0650(self):
        self.assertFalse(
            CAPTURE_SERVICE.in_active_window(datetime(2026, 8, 3, 6, 49))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_active_window(datetime(2026, 8, 3, 6, 50))
        )

    def test_window_ends_exactly_at_1500(self):
        self.assertTrue(
            CAPTURE_SERVICE.in_active_window(datetime(2026, 8, 3, 14, 59))
        )
        self.assertFalse(
            CAPTURE_SERVICE.in_active_window(datetime(2026, 8, 3, 15, 0))
        )

    def test_weekends_remain_inactive(self):
        self.assertFalse(
            CAPTURE_SERVICE.in_active_window(datetime(2026, 8, 2, 10, 0))
        )


if __name__ == '__main__':
    unittest.main()
