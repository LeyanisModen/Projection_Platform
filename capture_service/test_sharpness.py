import importlib.util
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch


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


class SyncWindowTests(unittest.TestCase):
    def setUp(self):
        self.setting_names = (
            'sync_enabled',
            'sync_weekly_enabled',
            'sync_weekly_start_day',
            'sync_weekly_start_hour',
            'sync_weekly_start_minute',
            'sync_weekly_end_day',
            'sync_weekly_end_hour',
            'sync_weekly_end_minute',
        )
        self.original_values = {
            name: getattr(CAPTURE_SERVICE.CONFIG, name)
            for name in self.setting_names
        }
        CAPTURE_SERVICE.CONFIG.sync_enabled = True
        CAPTURE_SERVICE.CONFIG.sync_weekly_enabled = True
        CAPTURE_SERVICE.CONFIG.sync_weekly_start_day = 4
        CAPTURE_SERVICE.CONFIG.sync_weekly_start_hour = 15
        CAPTURE_SERVICE.CONFIG.sync_weekly_start_minute = 30
        CAPTURE_SERVICE.CONFIG.sync_weekly_end_day = 0
        CAPTURE_SERVICE.CONFIG.sync_weekly_end_hour = 5
        CAPTURE_SERVICE.CONFIG.sync_weekly_end_minute = 0

    def tearDown(self):
        for name, value in self.original_values.items():
            setattr(CAPTURE_SERVICE.CONFIG, name, value)

    def test_weekend_sync_starts_friday_after_production(self):
        self.assertFalse(
            CAPTURE_SERVICE.in_sync_window(datetime(2026, 8, 7, 15, 29))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_sync_window(datetime(2026, 8, 7, 15, 30))
        )

    def test_weekend_sync_remains_active_saturday_and_sunday(self):
        self.assertTrue(
            CAPTURE_SERVICE.in_sync_window(datetime(2026, 8, 8, 12, 0))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_sync_window(datetime(2026, 8, 9, 23, 59))
        )

    def test_weekend_sync_ends_monday_at_0500(self):
        self.assertTrue(
            CAPTURE_SERVICE.in_sync_window(datetime(2026, 8, 10, 4, 59))
        )
        self.assertFalse(
            CAPTURE_SERVICE.in_sync_window(datetime(2026, 8, 10, 5, 0))
        )


class DriveProcessWindowTests(unittest.TestCase):
    def setUp(self):
        self.setting_names = (
            'drive_guard_enabled',
            'drive_daily_enabled',
            'drive_start_hour',
            'drive_start_minute',
            'drive_stop_hour',
            'drive_stop_minute',
            'drive_weekend_enabled',
            'drive_weekend_start_day',
            'drive_weekend_start_hour',
            'drive_weekend_start_minute',
            'drive_weekend_end_day',
            'drive_weekend_end_hour',
            'drive_weekend_end_minute',
        )
        self.original_values = {
            name: getattr(CAPTURE_SERVICE.CONFIG, name)
            for name in self.setting_names
        }
        self.original_stats = dict(CAPTURE_SERVICE._stats)
        CAPTURE_SERVICE.CONFIG.drive_guard_enabled = True
        CAPTURE_SERVICE.CONFIG.drive_daily_enabled = True
        CAPTURE_SERVICE.CONFIG.drive_start_hour = 3
        CAPTURE_SERVICE.CONFIG.drive_start_minute = 45
        CAPTURE_SERVICE.CONFIG.drive_stop_hour = 4
        CAPTURE_SERVICE.CONFIG.drive_stop_minute = 45
        CAPTURE_SERVICE.CONFIG.drive_weekend_enabled = True
        CAPTURE_SERVICE.CONFIG.drive_weekend_start_day = 4
        CAPTURE_SERVICE.CONFIG.drive_weekend_start_hour = 15
        CAPTURE_SERVICE.CONFIG.drive_weekend_start_minute = 15
        CAPTURE_SERVICE.CONFIG.drive_weekend_end_day = 0
        CAPTURE_SERVICE.CONFIG.drive_weekend_end_hour = 6
        CAPTURE_SERVICE.CONFIG.drive_weekend_end_minute = 35

    def tearDown(self):
        for name, value in self.original_values.items():
            setattr(CAPTURE_SERVICE.CONFIG, name, value)
        with CAPTURE_SERVICE._stats_lock:
            CAPTURE_SERVICE._stats.clear()
            CAPTURE_SERVICE._stats.update(self.original_stats)

    def test_daily_update_window_boundaries(self):
        self.assertFalse(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 4, 3, 44))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 4, 3, 45))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 4, 4, 44))
        )
        self.assertFalse(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 4, 4, 45))
        )

    def test_daily_drive_window_can_be_disabled(self):
        CAPTURE_SERVICE.CONFIG.drive_daily_enabled = False
        self.assertFalse(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 4, 4, 15))
        )

    def test_extended_weekend_drive_window_boundaries(self):
        self.assertFalse(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 7, 15, 14))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 7, 15, 15))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 9, 12, 0))
        )
        self.assertTrue(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 10, 6, 34))
        )
        self.assertFalse(
            CAPTURE_SERVICE.in_drive_process_window(datetime(2026, 8, 10, 6, 35))
        )

    @unittest.skipUnless(CAPTURE_SERVICE.os.name == 'nt', 'Windows-only guard')
    def test_policy_starts_drive_during_update_window(self):
        with (
            patch.object(
                CAPTURE_SERVICE,
                '_google_drive_is_running',
                side_effect=[False, True],
            ),
            patch.object(CAPTURE_SERVICE, '_start_google_drive') as start_drive,
            patch.object(CAPTURE_SERVICE, '_stop_google_drive') as stop_drive,
            patch.object(
                CAPTURE_SERVICE,
                '_drive_maintenance_requested',
                return_value=False,
            ),
        ):
            CAPTURE_SERVICE._apply_google_drive_process_policy(
                datetime(2026, 8, 4, 4, 15)
            )

        start_drive.assert_called_once_with()
        stop_drive.assert_not_called()

    @unittest.skipUnless(CAPTURE_SERVICE.os.name == 'nt', 'Windows-only guard')
    def test_policy_stops_drive_during_production(self):
        with (
            patch.object(
                CAPTURE_SERVICE,
                '_google_drive_is_running',
                side_effect=[True, False],
            ),
            patch.object(CAPTURE_SERVICE, '_start_google_drive') as start_drive,
            patch.object(CAPTURE_SERVICE, '_stop_google_drive') as stop_drive,
            patch.object(
                CAPTURE_SERVICE,
                '_drive_maintenance_requested',
                return_value=False,
            ),
        ):
            CAPTURE_SERVICE._apply_google_drive_process_policy(
                datetime(2026, 8, 4, 9, 0)
            )

        start_drive.assert_not_called()
        stop_drive.assert_called_once_with()

    @unittest.skipUnless(CAPTURE_SERVICE.os.name == 'nt', 'Windows-only guard')
    def test_manual_update_keeps_drive_available_outside_window(self):
        with (
            patch.object(
                CAPTURE_SERVICE,
                '_google_drive_is_running',
                side_effect=[False, True],
            ),
            patch.object(CAPTURE_SERVICE, '_start_google_drive') as start_drive,
            patch.object(CAPTURE_SERVICE, '_stop_google_drive') as stop_drive,
            patch.object(
                CAPTURE_SERVICE,
                '_drive_maintenance_requested',
                return_value=True,
            ),
        ):
            CAPTURE_SERVICE._apply_google_drive_process_policy(
                datetime(2026, 8, 4, 9, 0)
            )

        start_drive.assert_called_once_with()
        stop_drive.assert_not_called()


class StorageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.original_values = {
            'local_buffer_dir': CAPTURE_SERVICE.CONFIG.local_buffer_dir,
            'output_dir': CAPTURE_SERVICE.CONFIG.output_dir,
            'mesa_id': CAPTURE_SERVICE.CONFIG.mesa_id,
            'local_retention_days': CAPTURE_SERVICE.CONFIG.local_retention_days,
            'max_local_gb': CAPTURE_SERVICE.CONFIG.max_local_gb,
            'min_free_gb': CAPTURE_SERVICE.CONFIG.min_free_gb,
        }
        self.original_stats = dict(CAPTURE_SERVICE._stats)
        CAPTURE_SERVICE.CONFIG.local_buffer_dir = root / 'buffer'
        CAPTURE_SERVICE.CONFIG.output_dir = root / 'drive'
        CAPTURE_SERVICE.CONFIG.mesa_id = 'test_mesa'
        CAPTURE_SERVICE.CONFIG.local_retention_days = 7
        CAPTURE_SERVICE.CONFIG.max_local_gb = 30
        CAPTURE_SERVICE.CONFIG.min_free_gb = 0
        CAPTURE_SERVICE.CONFIG.local_buffer_dir.mkdir(parents=True)
        CAPTURE_SERVICE.CONFIG.output_dir.mkdir(parents=True)

    def tearDown(self):
        for name, value in self.original_values.items():
            setattr(CAPTURE_SERVICE.CONFIG, name, value)
        with CAPTURE_SERVICE._stats_lock:
            CAPTURE_SERVICE._stats.clear()
            CAPTURE_SERVICE._stats.update(self.original_stats)
        self.temp_dir.cleanup()

    def _old_day_dir(self):
        day_name = (datetime.now().date() - timedelta(days=8)).isoformat()
        day_dir = CAPTURE_SERVICE._docs_buffer_root() / day_name
        day_dir.mkdir(parents=True)
        return day_dir

    def test_week_old_day_is_purged_when_every_file_matches_drive(self):
        day_dir = self._old_day_dir()
        (day_dir / 'one.jpg').write_bytes(b'one')
        nested = day_dir / 'nested'
        nested.mkdir()
        (nested / 'two.jpg').write_bytes(b'two')

        drive_day = CAPTURE_SERVICE._mesa_root() / day_dir.name
        (drive_day / 'nested').mkdir(parents=True)
        (drive_day / 'one.jpg').write_bytes(b'one')
        (drive_day / 'nested' / 'two.jpg').write_bytes(b'two')

        CAPTURE_SERVICE._purge_old_synced_local_days()

        self.assertFalse(day_dir.exists())

    def test_incomplete_drive_copy_is_never_purged(self):
        day_dir = self._old_day_dir()
        (day_dir / 'one.jpg').write_bytes(b'one')
        (day_dir / 'two.jpg').write_bytes(b'two')

        drive_day = CAPTURE_SERVICE._mesa_root() / day_dir.name
        drive_day.mkdir(parents=True)
        (drive_day / 'one.jpg').write_bytes(b'one')

        CAPTURE_SERVICE._purge_old_synced_local_days()

        self.assertTrue(day_dir.exists())

    def test_buffer_limit_pauses_periodic_capture_without_deleting_unique_file(self):
        day_dir = self._old_day_dir()
        unique_file = day_dir / 'unique.jpg'
        unique_file.write_bytes(b'unique')
        CAPTURE_SERVICE.CONFIG.max_local_gb = 1 / (1024 ** 3)

        ready = CAPTURE_SERVICE._storage_ready_for_periodic_capture()

        self.assertFalse(ready)
        self.assertTrue(unique_file.exists())
        self.assertEqual(
            CAPTURE_SERVICE._stats['documentation_paused_reason'],
            'local_buffer_limit',
        )

    def test_weekend_copy_stops_before_consuming_disk_reserve(self):
        day_dir = self._old_day_dir()
        source_file = day_dir / 'pending.jpg'
        source_file.write_bytes(b'pending')
        stable_time = CAPTURE_SERVICE.time.time() - 60
        CAPTURE_SERVICE.os.utime(source_file, (stable_time, stable_time))
        CAPTURE_SERVICE.CONFIG.local_retention_days = 30
        CAPTURE_SERVICE.CONFIG.min_free_gb = 5
        disk_usage = type('DiskUsage', (), {'free': 0})()

        with patch.object(CAPTURE_SERVICE.shutil, 'disk_usage', return_value=disk_usage):
            CAPTURE_SERVICE._copy_buffered_files_to_drive_once()

        destination = CAPTURE_SERVICE._mesa_root() / day_dir.name / source_file.name
        self.assertFalse(destination.exists())
        self.assertEqual(
            CAPTURE_SERVICE._stats['last_sync_error'],
            'sync paused: low free disk',
        )


class PlayerPauseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.pause_path = Path(self.temp_dir.name) / '.player_pause'
        self.path_patch = patch.object(
            CAPTURE_SERVICE,
            '_player_pause_path',
            return_value=self.pause_path,
        )
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.temp_dir.cleanup()

    def test_close_request_creates_active_pause(self):
        self.assertTrue(CAPTURE_SERVICE._request_player_pause())
        self.assertTrue(CAPTURE_SERVICE._player_pause_requested())

    def test_stale_pause_is_removed(self):
        self.pause_path.write_text('stale', encoding='ascii')
        stale = CAPTURE_SERVICE.time.time() - (31 * 60)
        CAPTURE_SERVICE.os.utime(self.pause_path, (stale, stale))

        self.assertFalse(CAPTURE_SERVICE._player_pause_requested())
        self.assertFalse(self.pause_path.exists())


if __name__ == '__main__':
    unittest.main()
