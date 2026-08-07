"""
Local camera capture HTTP service for OBSBOT Tiny 2.
Runs on each mini-PC alongside the browser Player.

Listens on localhost:5555. Two jobs in one process:

  1. HTTP server (on-demand)
     POST /capture            -> take a fresh 4K JPEG and return the
                                  bytes (used by the visor when an
                                  image filename contains _foto /
                                  _photo / _check)
     POST /save_debug_image   -> raw JPEG body + X-Filename header.
                                  Persisted to <output_dir>/<mesa_id>/
                                  debug/YYYY-MM-DD/<filename>.
                                  Used by the visor in COLOR_CHECK_DEBUG
                                  mode to mirror the annotated overlay
                                  to Drive.
     GET  /device_token       -> { "device_token": "<stored>" }. Read
                                  from device_token.txt next to the
                                  script. Used by the visor to recover
                                  the pairing token if Chrome's
                                  localStorage was wiped.
     POST /device_token       -> raw token body. Writes
                                  device_token.txt so the token
                                  survives a Chrome profile reset.
     POST /close_browser      -> close Chrome kiosk on this mini-PC.
     GET  /health             -> { "status": "ok" }
     GET  /stats              -> { documentation / counters / local
                                  disk usage }

  2. Documentation thread (periodic, configurable)
     Every `interval_seconds` saves a resized JPEG into a local buffer:
       <local_buffer_dir>/<mesa_id>/YYYY-MM-DD/HH-MM-SS.jpg
     A second thread copies buffered files to the Google Drive folder
     (`output_dir`) only during the configured weekend sync window, so
     weekday captures do not saturate the factory internet connection.
     Local buffered folders are pruned once copied and older than the
     configured retention, or when the local footprint exceeds
     `max_local_gb`.

All settings come from `config.ini` next to this script.
"""
import configparser
import json
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, time as dtime
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import cv2

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CONFIG_PATH = Path(__file__).with_name('config.ini')

DAY_NAME_TO_INDEX = {
    'MON': 0, 'TUE': 1, 'WED': 2, 'THU': 3, 'FRI': 4, 'SAT': 5, 'SUN': 6,
}
DAY_INDEX_TO_NAME = {value: key for key, value in DAY_NAME_TO_INDEX.items()}

CONTROL_ALLOWED_ORIGINS = {
    'https://moden.up.railway.app',
    'http://localhost:4200',
    'http://127.0.0.1:4200',
    'http://localhost',
    'http://127.0.0.1',
}


class Config:
    def __init__(self, path: Path):
        self.capture_width = 3840
        self.capture_height = 2160
        self.jpeg_quality = 95
        # Factory cameras are mounted on vertical posts and deliver the UVC
        # frame upside-down for our table reference. Keep this configurable so
        # a bench setup can opt out with image_rotation = 0.
        self.image_rotation = 180
        self.host = '127.0.0.1'
        self.port = 5555
        self.camera_index = 0
        # Backend name (resolved later as cv2.<name>). CAP_ANY lets OpenCV
        # pick; override to CAP_DSHOW or CAP_MSMF if a given PC needs it.
        self.camera_backend = 'CAP_ANY'

        # documentation defaults (disabled until the .ini turns it on)
        self.doc_enabled = False
        self.local_buffer_dir = Path('C:/moden/capture_buffer')
        self.output_dir = Path('C:/moden/capturas')
        self.mesa_id = 'mesa_unknown'
        self.interval_seconds = 20.0
        self.doc_width = 1920
        self.doc_height = 1080
        self.doc_jpeg_quality = 88
        self.max_local_gb = 30.0
        self.min_free_gb = 5.0
        self.sync_enabled = True
        self.sync_start_hour = 1
        self.sync_end_hour = 5
        self.sync_interval_seconds = 1800.0
        self.sync_weekly_enabled = True
        self.sync_weekly_start_day = DAY_NAME_TO_INDEX['FRI']
        self.sync_weekly_start_hour = 15
        self.sync_weekly_start_minute = 30
        self.sync_weekly_end_day = DAY_NAME_TO_INDEX['MON']
        self.sync_weekly_end_hour = 5
        self.sync_weekly_end_minute = 0
        self.local_retention_days = 7
        # Google Drive Desktop must not display dialogs over the production
        # kiosk. Keep the process alive only around scheduled photo sync.
        self.drive_guard_enabled = True
        # Software updates come directly from GitHub. The old daily Drive
        # window remains configurable but is disabled by default.
        self.drive_daily_enabled = False
        self.drive_start_hour = 3
        self.drive_start_minute = 45
        self.drive_stop_hour = 4
        self.drive_stop_minute = 45
        self.drive_weekend_enabled = True
        self.drive_weekend_start_day = DAY_NAME_TO_INDEX['FRI']
        self.drive_weekend_start_hour = 15
        self.drive_weekend_start_minute = 15
        self.drive_weekend_end_day = DAY_NAME_TO_INDEX['MON']
        self.drive_weekend_end_hour = 6
        self.drive_weekend_end_minute = 35
        self.drive_guard_interval_seconds = 30.0
        self.active_days = {0, 1, 2, 3, 4}  # MON..FRI
        self.active_start_hour = 6
        self.active_start_minute = 50
        self.active_end_hour = 15
        self.active_end_minute = 0

        # Sharpness check starts on the first active frame of the day.
        # Doubtful results are retried because an arbitrary projected scene
        # is not reliable enough to diagnose a dirty lens from one sample.
        self.sharpness_enabled = True
        # Keep the visible "clean lens" warning very conservative. The
        # projected table can be dark/plain at 06:50, so low Laplacian is
        # not enough evidence by itself.
        self.sharpness_threshold_blurry = 2.0
        self.sharpness_threshold_warning = 10.0
        self.sharpness_min_brightness = 18.0
        self.sharpness_min_contrast = 8.0
        self.sharpness_retry_minutes = 15.0

        if path.exists():
            self._load(path)

    def _load(self, path: Path):
        cp = configparser.ConfigParser()
        # utf-8-sig strips the byte-order mark if some Windows tool
        # (PowerShell's Set-Content, Notepad's 'UTF-8') added one when
        # the operator edited the config. Without this, configparser
        # fails with MissingSectionHeaderError on the first line.
        cp.read(path, encoding='utf-8-sig')

        if cp.has_section('service'):
            s = cp['service']
            self.host = s.get('host', self.host)
            self.port = s.getint('port', self.port)
            self.camera_index = s.getint('camera_index', self.camera_index)
            self.camera_backend = s.get('camera_backend', self.camera_backend)
            self.capture_width = s.getint('capture_width', self.capture_width)
            self.capture_height = s.getint('capture_height', self.capture_height)
            self.jpeg_quality = s.getint('jpeg_quality', self.jpeg_quality)
            self.image_rotation = self._parse_image_rotation(
                s.get('image_rotation', str(self.image_rotation)),
                self.image_rotation,
            )

        if cp.has_section('documentation'):
            d = cp['documentation']
            self.doc_enabled = d.getboolean('enabled', self.doc_enabled)
            self.local_buffer_dir = Path(d.get('local_buffer_dir', str(self.local_buffer_dir)))
            self.output_dir = Path(d.get('output_dir', str(self.output_dir)))
            self.mesa_id = d.get('mesa_id', self.mesa_id)
            self.interval_seconds = d.getfloat('interval_seconds', self.interval_seconds)
            self.doc_width = d.getint('width', self.doc_width)
            self.doc_height = d.getint('height', self.doc_height)
            self.doc_jpeg_quality = d.getint('jpeg_quality', self.doc_jpeg_quality)
            self.max_local_gb = d.getfloat('max_local_gb', self.max_local_gb)
            self.min_free_gb = d.getfloat('min_free_gb', self.min_free_gb)
            self.sync_enabled = d.getboolean('sync_enabled', self.sync_enabled)
            self.sync_start_hour = d.getint('sync_start_hour', self.sync_start_hour)
            self.sync_end_hour = d.getint('sync_end_hour', self.sync_end_hour)
            self.sync_interval_seconds = d.getfloat(
                'sync_interval_seconds',
                self.sync_interval_seconds,
            )
            self.sync_weekly_enabled = d.getboolean(
                'sync_weekly_enabled', self.sync_weekly_enabled
            )
            self.sync_weekly_start_day = self._parse_day_index(
                d.get('sync_weekly_start_day', 'FRI'),
                self.sync_weekly_start_day,
            )
            self.sync_weekly_start_hour = d.getint(
                'sync_weekly_start_hour', self.sync_weekly_start_hour
            )
            self.sync_weekly_start_minute = d.getint(
                'sync_weekly_start_minute', self.sync_weekly_start_minute
            )
            self.sync_weekly_end_day = self._parse_day_index(
                d.get('sync_weekly_end_day', 'MON'),
                self.sync_weekly_end_day,
            )
            self.sync_weekly_end_hour = d.getint(
                'sync_weekly_end_hour', self.sync_weekly_end_hour
            )
            self.sync_weekly_end_minute = d.getint(
                'sync_weekly_end_minute', self.sync_weekly_end_minute
            )
            self.local_retention_days = d.getint('local_retention_days', self.local_retention_days)
            self.drive_guard_enabled = d.getboolean(
                'drive_guard_enabled', self.drive_guard_enabled
            )
            self.drive_daily_enabled = d.getboolean(
                'drive_daily_enabled', self.drive_daily_enabled
            )
            self.drive_start_hour = d.getint('drive_start_hour', self.drive_start_hour)
            self.drive_start_minute = d.getint(
                'drive_start_minute', self.drive_start_minute
            )
            self.drive_stop_hour = d.getint('drive_stop_hour', self.drive_stop_hour)
            self.drive_stop_minute = d.getint(
                'drive_stop_minute', self.drive_stop_minute
            )
            self.drive_weekend_enabled = d.getboolean(
                'drive_weekend_enabled', self.drive_weekend_enabled
            )
            self.drive_weekend_start_day = self._parse_day_index(
                d.get('drive_weekend_start_day', 'FRI'),
                self.drive_weekend_start_day,
            )
            self.drive_weekend_start_hour = d.getint(
                'drive_weekend_start_hour', self.drive_weekend_start_hour
            )
            self.drive_weekend_start_minute = d.getint(
                'drive_weekend_start_minute', self.drive_weekend_start_minute
            )
            self.drive_weekend_end_day = self._parse_day_index(
                d.get('drive_weekend_end_day', 'MON'),
                self.drive_weekend_end_day,
            )
            self.drive_weekend_end_hour = d.getint(
                'drive_weekend_end_hour', self.drive_weekend_end_hour
            )
            self.drive_weekend_end_minute = d.getint(
                'drive_weekend_end_minute', self.drive_weekend_end_minute
            )
            self.drive_guard_interval_seconds = d.getfloat(
                'drive_guard_interval_seconds',
                self.drive_guard_interval_seconds,
            )
            days_raw = d.get('active_days', 'MON,TUE,WED,THU,FRI')
            self.active_days = {
                DAY_NAME_TO_INDEX[x.strip().upper()]
                for x in days_raw.split(',')
                if x.strip().upper() in DAY_NAME_TO_INDEX
            }
            self.active_start_hour = d.getint('active_start_hour', self.active_start_hour)
            self.active_start_minute = d.getint(
                'active_start_minute', self.active_start_minute
            )
            self.active_end_hour = d.getint('active_end_hour', self.active_end_hour)
            self.active_end_minute = d.getint(
                'active_end_minute', self.active_end_minute
            )

        if cp.has_section('sharpness'):
            s = cp['sharpness']
            self.sharpness_enabled = s.getboolean('enabled', self.sharpness_enabled)
            self.sharpness_threshold_blurry = s.getfloat(
                'threshold_blurry', self.sharpness_threshold_blurry
            )
            self.sharpness_threshold_warning = s.getfloat(
                'threshold_warning', self.sharpness_threshold_warning
            )
            self.sharpness_min_brightness = s.getfloat(
                'min_brightness', self.sharpness_min_brightness
            )
            self.sharpness_min_contrast = s.getfloat(
                'min_contrast', self.sharpness_min_contrast
            )
            self.sharpness_retry_minutes = s.getfloat(
                'retry_minutes', self.sharpness_retry_minutes
            )

    @staticmethod
    def _parse_image_rotation(value, default):
        try:
            rotation = int(value) % 360
        except (TypeError, ValueError):
            print(f'[CaptureService] Invalid image_rotation={value!r}; using {default}.')
            return default
        if rotation not in (0, 90, 180, 270):
            print(f'[CaptureService] Unsupported image_rotation={rotation}; using {default}.')
            return default
        return rotation

    @staticmethod
    def _parse_day_index(value, default):
        normalized = str(value).strip().upper()
        if normalized in DAY_NAME_TO_INDEX:
            return DAY_NAME_TO_INDEX[normalized]
        try:
            day_index = int(normalized)
        except (TypeError, ValueError):
            return default
        return day_index if 0 <= day_index <= 6 else default


CONFIG = Config(CONFIG_PATH)


# ---------------------------------------------------------------------------
# Camera singleton
# ---------------------------------------------------------------------------
_camera = None
# Reentrant so get_camera() can nest inside a caller that already
# holds the lock (handler or doc_loop). A plain Lock() deadlocks the
# first time capture_frame() is called.
_camera_lock = threading.RLock()


def get_camera():
    """Open the webcam. The backend is read from config (`camera_backend`)
    because DSHOW and MSMF behave differently across machines — on some
    PCs DSHOW opens fast but the reads block; on others MSMF is the one
    that hangs. Default is CAP_ANY so OpenCV picks whatever the driver
    prefers, which is what worked historically with this project."""
    global _camera
    with _camera_lock:
        if _camera is None or not _camera.isOpened():
            backend = getattr(cv2, CONFIG.camera_backend, cv2.CAP_ANY)
            _camera = cv2.VideoCapture(CONFIG.camera_index, backend)
            if not _camera.isOpened():
                print(f'[CaptureService] Camera index {CONFIG.camera_index} '
                      f'could not be opened (backend={CONFIG.camera_backend}). '
                      f'Check that no other app is holding it (OBSBOT Center, '
                      f'Teams, Zoom).')
                return _camera
            _camera.set(cv2.CAP_PROP_FRAME_WIDTH, CONFIG.capture_width)
            _camera.set(cv2.CAP_PROP_FRAME_HEIGHT, CONFIG.capture_height)
            time.sleep(0.5)
        return _camera


def capture_frame():
    """Fresh frame from the camera. Caller must hold _camera_lock."""
    cam = get_camera()
    if cam is None or not cam.isOpened():
        _set_camera_health(False, 'camera open failed')
        return False, None
    # Discard a few buffered frames so we get a fresh one.
    for _ in range(3):
        cam.read()
    ret, frame = cam.read()
    if ret and frame is not None:
        frame = _apply_image_rotation(frame)
        _set_camera_health(True)
    else:
        _set_camera_health(False, 'camera read failed')
    return ret, frame


def _apply_image_rotation(frame):
    rotation = CONFIG.image_rotation
    if rotation == 90:
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    if rotation == 180:
        return cv2.rotate(frame, cv2.ROTATE_180)
    if rotation == 270:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame


# ---------------------------------------------------------------------------
# Documentation stats (shared with /stats endpoint)
# ---------------------------------------------------------------------------
_stats_lock = threading.Lock()
_stats = {
    'documentation_enabled': CONFIG.doc_enabled,
    'mesa_id': CONFIG.mesa_id,
    'last_capture_at': None,
    'captures_today': 0,
    'captures_today_date': None,  # ISO date
    'local_disk_bytes': 0,
    'free_disk_bytes': None,
    'documentation_paused_reason': None,
    'skipped_storage_pressure': 0,
    'last_local_purge_at': None,
    'last_local_purge_bytes': 0,
    'pending_sync_bytes': 0,
    'last_sync_at': None,
    'last_sync_files': 0,
    'last_sync_bytes': 0,
    'last_sync_error': None,
    'drive_process_running': None,
    'drive_process_last_action': None,
    'drive_process_error': None,
    'last_error': None,
    'camera_available': None,
    'last_camera_ok_at': None,
    'last_camera_error_at': None,
    'skipped_out_of_schedule': 0,
    # Sharpness check starts on the first active tick. Low-confidence
    # results are retried during the day so an early dark frame is not final.
    'sharpness_status': 'unknown',  # unknown | ok | warning | blurry
    'sharpness_score': None,
    'sharpness_checked_at': None,
    'sharpness_checked_date': None,
    'sharpness_blurry_streak': 0,
}


def _update_stats_after_save():
    today_iso = datetime.now().date().isoformat()
    with _stats_lock:
        if _stats['captures_today_date'] != today_iso:
            _stats['captures_today_date'] = today_iso
            _stats['captures_today'] = 0
        _stats['captures_today'] += 1
        _stats['last_capture_at'] = datetime.now().isoformat(timespec='seconds')


def _set_last_error(msg: str):
    with _stats_lock:
        _stats['last_error'] = msg


def _set_camera_health(available, error=None):
    now_iso = datetime.now().isoformat(timespec='seconds')
    with _stats_lock:
        _stats['camera_available'] = bool(available)
        if available:
            _stats['last_camera_ok_at'] = now_iso
            return
        _stats['last_camera_error_at'] = now_iso
        _stats['last_error'] = error or 'camera unavailable'
        _stats['sharpness_status'] = 'unknown'


# ---------------------------------------------------------------------------
# Sharpness check — detects a dirty / blurry lens once per day.
# ---------------------------------------------------------------------------
def _laplacian_variance(frame) -> float:
    """Higher variance = sharper image. A dirty / smudged lens softens
    edges and drops the variance significantly."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _sharpness_context(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(gray.mean()), float(gray.std())


def _sharpness_status_for(score: float) -> str:
    if score < CONFIG.sharpness_threshold_blurry:
        return 'blurry'
    if score < CONFIG.sharpness_threshold_warning:
        return 'warning'
    return 'ok'


def _confirmed_sharpness_status(score: float, blurry_streak: int):
    """Require two very-low readings before reporting a dirty lens."""
    raw_status = _sharpness_status_for(score)
    if raw_status == 'blurry':
        next_streak = blurry_streak + 1
        if next_streak < 2:
            return 'warning', next_streak
        return 'blurry', next_streak
    return raw_status, 0


def _sharpness_check_due(now=None) -> bool:
    now = now or datetime.now()
    today_iso = now.date().isoformat()
    with _stats_lock:
        checked_date = _stats['sharpness_checked_date']
        checked_at = _stats['sharpness_checked_at']
        status = _stats['sharpness_status']
        blurry_streak = _stats['sharpness_blurry_streak']

    if checked_date != today_iso:
        return True
    if status not in {'unknown', 'blurry'} and blurry_streak == 0:
        return False
    if not checked_at:
        return True
    try:
        checked_datetime = datetime.fromisoformat(checked_at)
    except (TypeError, ValueError):
        return True
    retry_seconds = max(60.0, CONFIG.sharpness_retry_minutes * 60.0)
    return (now - checked_datetime).total_seconds() >= retry_seconds


def _ensure_sharpness_checked_today():
    """Run the daily analysis and retry doubtful results during the day."""
    if not CONFIG.sharpness_enabled:
        return
    if not _sharpness_check_due():
        return
    try:
        with _camera_lock:
            ret, frame = capture_frame()
        if not ret or frame is None:
            return
        score = _laplacian_variance(frame)
        brightness, contrast = _sharpness_context(frame)
        if (
            brightness < CONFIG.sharpness_min_brightness
            or contrast < CONFIG.sharpness_min_contrast
        ):
            status = 'unknown'
            blurry_streak = 0
        else:
            with _stats_lock:
                previous_streak = _stats['sharpness_blurry_streak']
            status, blurry_streak = _confirmed_sharpness_status(
                score,
                previous_streak,
            )
        checked_now = datetime.now()
        now_iso = checked_now.isoformat(timespec='seconds')
        with _stats_lock:
            _stats['sharpness_score'] = round(score, 2)
            _stats['sharpness_status'] = status
            _stats['sharpness_checked_at'] = now_iso
            _stats['sharpness_checked_date'] = checked_now.date().isoformat()
            _stats['sharpness_blurry_streak'] = blurry_streak
        print(
            f'[Sharpness] {status} '
            f'(score={score:.1f}, brightness={brightness:.1f}, contrast={contrast:.1f}) '
            f'for {CONFIG.mesa_id}; blurry_streak={blurry_streak}'
        )
    except Exception as exc:
        _set_last_error(f'sharpness: {exc}')


# ---------------------------------------------------------------------------
# Schedule check
# ---------------------------------------------------------------------------
def in_active_window(now: datetime = None) -> bool:
    now = now or datetime.now()
    if now.weekday() not in CONFIG.active_days:
        return False
    start = dtime(CONFIG.active_start_hour, CONFIG.active_start_minute)
    end = dtime(CONFIG.active_end_hour, CONFIG.active_end_minute)
    current = now.time()
    return start <= current < end


def _in_daily_window(now, start_hour, start_minute, end_hour, end_minute):
    start = dtime(start_hour, start_minute)
    end = dtime(end_hour, end_minute)
    current = now.time()
    if start < end:
        return start <= current < end
    if start > end:
        return current >= start or current < end
    return True


def _in_weekly_window(
    now,
    start_day,
    start_hour,
    start_minute,
    end_day,
    end_hour,
    end_minute,
):
    current = now.weekday() * 24 * 60 + now.hour * 60 + now.minute
    start = start_day * 24 * 60 + start_hour * 60 + start_minute
    end = end_day * 24 * 60 + end_hour * 60 + end_minute
    if start < end:
        return start <= current < end
    if start > end:
        return current >= start or current < end
    return True


def _format_weekly_window(start_day, start_hour, start_minute, end_day, end_hour, end_minute):
    return (
        f'{DAY_INDEX_TO_NAME[start_day]} {start_hour:02d}:{start_minute:02d}-'
        f'{DAY_INDEX_TO_NAME[end_day]} {end_hour:02d}:{end_minute:02d}'
    )


def sync_window_label():
    if CONFIG.sync_weekly_enabled:
        return _format_weekly_window(
            CONFIG.sync_weekly_start_day,
            CONFIG.sync_weekly_start_hour,
            CONFIG.sync_weekly_start_minute,
            CONFIG.sync_weekly_end_day,
            CONFIG.sync_weekly_end_hour,
            CONFIG.sync_weekly_end_minute,
        )
    return f'daily {CONFIG.sync_start_hour:02d}:00-{CONFIG.sync_end_hour:02d}:00'


def in_sync_window(now: datetime = None) -> bool:
    if not CONFIG.sync_enabled:
        return False
    now = now or datetime.now()
    if CONFIG.sync_weekly_enabled:
        return _in_weekly_window(
            now,
            CONFIG.sync_weekly_start_day,
            CONFIG.sync_weekly_start_hour,
            CONFIG.sync_weekly_start_minute,
            CONFIG.sync_weekly_end_day,
            CONFIG.sync_weekly_end_hour,
            CONFIG.sync_weekly_end_minute,
        )
    return _in_daily_window(
        now,
        CONFIG.sync_start_hour,
        0,
        CONFIG.sync_end_hour,
        0,
    )


def drive_process_window_label():
    windows = []
    if CONFIG.drive_daily_enabled:
        windows.append(
            f'daily {CONFIG.drive_start_hour:02d}:{CONFIG.drive_start_minute:02d}-'
            f'{CONFIG.drive_stop_hour:02d}:{CONFIG.drive_stop_minute:02d}'
        )
    if CONFIG.drive_weekend_enabled:
        windows.append(
            'weekend ' + _format_weekly_window(
                CONFIG.drive_weekend_start_day,
                CONFIG.drive_weekend_start_hour,
                CONFIG.drive_weekend_start_minute,
                CONFIG.drive_weekend_end_day,
                CONFIG.drive_weekend_end_hour,
                CONFIG.drive_weekend_end_minute,
            )
        )
    return '; '.join(windows) if windows else 'disabled'


def in_drive_process_window(now: datetime = None) -> bool:
    if not CONFIG.drive_guard_enabled:
        return False
    now = now or datetime.now()
    if CONFIG.drive_daily_enabled and _in_daily_window(
        now,
        CONFIG.drive_start_hour,
        CONFIG.drive_start_minute,
        CONFIG.drive_stop_hour,
        CONFIG.drive_stop_minute,
    ):
        return True
    return CONFIG.drive_weekend_enabled and _in_weekly_window(
        now,
        CONFIG.drive_weekend_start_day,
        CONFIG.drive_weekend_start_hour,
        CONFIG.drive_weekend_start_minute,
        CONFIG.drive_weekend_end_day,
        CONFIG.drive_weekend_end_hour,
        CONFIG.drive_weekend_end_minute,
    )


# ---------------------------------------------------------------------------
# Google Drive process guard
# ---------------------------------------------------------------------------
def _drive_maintenance_path() -> Path:
    return Path(__file__).resolve().parent / '.drive_maintenance'


def _drive_maintenance_requested() -> bool:
    path = _drive_maintenance_path()
    try:
        if not path.is_file():
            return False
        # The updater normally removes this marker. Expiry prevents a failed
        # manual update from leaving Drive active during production forever.
        if time.time() - path.stat().st_mtime <= 30 * 60:
            return True
        path.unlink(missing_ok=True)
    except OSError:
        return False
    return False


def _hidden_process_flags(detached=False):
    if os.name != 'nt':
        return 0
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    if detached:
        flags |= getattr(subprocess, 'DETACHED_PROCESS', 0)
        flags |= getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    return flags


def _google_drive_is_running() -> bool:
    if os.name != 'nt':
        return False
    result = subprocess.run(
        ['tasklist.exe', '/FI', 'IMAGENAME eq GoogleDriveFS.exe', '/NH'],
        capture_output=True,
        text=True,
        timeout=10,
        creationflags=_hidden_process_flags(),
    )
    return result.returncode == 0 and 'googledrivefs.exe' in result.stdout.lower()


def _find_google_drive_executable():
    if os.name != 'nt':
        return None

    candidates = []
    program_files = os.environ.get('PROGRAMFILES')
    local_app_data = os.environ.get('LOCALAPPDATA')
    if program_files:
        root = Path(program_files) / 'Google' / 'Drive File Stream'
        candidates.append(root / 'GoogleDriveFS.exe')
        if root.exists():
            candidates.extend(root.glob('*/GoogleDriveFS.exe'))
    if local_app_data:
        root = Path(local_app_data) / 'Google' / 'DriveFS'
        candidates.append(root / 'GoogleDriveFS.exe')
        if root.exists():
            candidates.extend(root.glob('*/GoogleDriveFS.exe'))

    existing = []
    for candidate in candidates:
        try:
            if candidate.is_file():
                existing.append(candidate)
        except OSError:
            continue
    if not existing:
        return None
    return max(existing, key=lambda path: path.stat().st_mtime)


def _disable_google_drive_autostart():
    if os.name != 'nt':
        return
    try:
        import winreg

        key_path = r'Software\Microsoft\Windows\CurrentVersion\Run'
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            key_path,
            0,
            winreg.KEY_READ | winreg.KEY_SET_VALUE,
        ) as key:
            drive_values = []
            index = 0
            while True:
                try:
                    name, value, _ = winreg.EnumValue(key, index)
                except OSError:
                    break
                if 'googledrivefs' in f'{name} {value}'.lower():
                    drive_values.append(name)
                index += 1
            for name in drive_values:
                winreg.DeleteValue(key, name)
                print(f'[DriveGuard] Disabled Google Drive autostart value: {name}')
    except (ImportError, OSError) as exc:
        print(f'[DriveGuard] Could not change Google Drive autostart: {exc}')


def _start_google_drive():
    executable = _find_google_drive_executable()
    if executable is None:
        raise FileNotFoundError('GoogleDriveFS.exe not found')
    subprocess.Popen(
        [str(executable)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=_hidden_process_flags(detached=True),
    )


def _stop_google_drive():
    if os.name != 'nt':
        return
    subprocess.run(
        ['taskkill.exe', '/IM', 'GoogleDriveFS.exe', '/T'],
        capture_output=True,
        text=True,
        timeout=10,
        creationflags=_hidden_process_flags(),
    )
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not _google_drive_is_running():
            return
        time.sleep(0.5)
    subprocess.run(
        ['taskkill.exe', '/IM', 'GoogleDriveFS.exe', '/T', '/F'],
        capture_output=True,
        text=True,
        timeout=10,
        creationflags=_hidden_process_flags(),
    )


def _apply_google_drive_process_policy(now: datetime = None):
    if not CONFIG.drive_guard_enabled or os.name != 'nt':
        return

    action = None
    error = None
    try:
        running = _google_drive_is_running()
        if in_drive_process_window(now) or _drive_maintenance_requested():
            if not running:
                _start_google_drive()
                action = 'started'
                print('[DriveGuard] Google Drive started for a scheduled window.')
        elif running:
            _stop_google_drive()
            action = 'stopped'
            print('[DriveGuard] Google Drive stopped to protect the production kiosk.')
        running = _google_drive_is_running()
    except Exception as exc:
        running = None
        error = str(exc)
        print(f'[DriveGuard] Error: {exc}')

    with _stats_lock:
        _stats['drive_process_running'] = running
        _stats['drive_process_error'] = error
        if action:
            _stats['drive_process_last_action'] = (
                f'{action} {datetime.now().isoformat(timespec="seconds")}'
            )


def google_drive_process_guard_loop():
    if not CONFIG.drive_guard_enabled or os.name != 'nt':
        return
    _disable_google_drive_autostart()
    print(
        f'[DriveGuard] Enabled. Drive process windows={drive_process_window_label()}'
    )
    while True:
        _apply_google_drive_process_policy()
        time.sleep(max(15.0, CONFIG.drive_guard_interval_seconds))


# ---------------------------------------------------------------------------
# Disk usage + purge
# ---------------------------------------------------------------------------
def _mesa_root() -> Path:
    """Google Drive destination root for files that are ready to sync."""
    return CONFIG.output_dir / CONFIG.mesa_id


def _docs_buffer_root() -> Path:
    """Local high-frequency capture buffer, not watched by Google Drive."""
    return CONFIG.local_buffer_dir / CONFIG.mesa_id


def _dir_size_bytes(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            fp = Path(root) / f
            try:
                total += fp.stat().st_size
            except OSError:
                pass
    return total


def _free_disk_bytes():
    try:
        return shutil.disk_usage(CONFIG.local_buffer_dir).free
    except OSError as exc:
        _set_last_error(f'disk usage: {exc}')
        return None


def _local_day_has_complete_drive_copy(day_dir: Path) -> bool:
    dest_dir = _mesa_root() / day_dir.name
    if not dest_dir.is_dir():
        return False

    found_file = False
    for src in day_dir.rglob('*'):
        if not src.is_file():
            continue
        found_file = True
        dest = dest_dir / src.relative_to(day_dir)
        try:
            if not dest.is_file() or dest.stat().st_size != src.stat().st_size:
                return False
        except OSError:
            return False
    return found_file


def _purge_old_synced_local_days():
    """Delete week-old local days only after a complete copy exists in G:."""
    if CONFIG.local_retention_days < 0:
        return 0

    root = _docs_buffer_root()
    if not root.exists() or not _mesa_root().exists():
        return 0

    today = datetime.now().date()
    purged_bytes = 0
    day_dirs = sorted(
        [p for p in root.iterdir() if p.is_dir()],
        key=lambda p: p.name,
    )
    for day_dir in day_dirs:
        try:
            day_date = datetime.strptime(day_dir.name, '%Y-%m-%d').date()
        except ValueError:
            continue
        if (today - day_date).days < CONFIG.local_retention_days:
            continue
        if not _local_day_has_complete_drive_copy(day_dir):
            continue
        try:
            day_bytes = _dir_size_bytes(day_dir)
            shutil.rmtree(day_dir)
            purged_bytes += day_bytes
        except OSError as exc:
            _set_last_error(f'purge {day_dir.name}: {exc}')

    if purged_bytes:
        with _stats_lock:
            _stats['last_local_purge_at'] = datetime.now().isoformat(timespec='seconds')
            _stats['last_local_purge_bytes'] = purged_bytes
    return purged_bytes


def _storage_ready_for_periodic_capture() -> bool:
    """Protect free disk without deleting the only copy of a capture."""
    _purge_old_synced_local_days()
    buffer_root = _docs_buffer_root()
    used = _dir_size_bytes(buffer_root) if buffer_root.exists() else 0
    max_bytes = int(CONFIG.max_local_gb * (1024 ** 3))

    free_bytes = _free_disk_bytes()

    reason = None
    if CONFIG.max_local_gb >= 0 and used >= max_bytes:
        reason = 'local_buffer_limit'
    min_free_bytes = int(CONFIG.min_free_gb * (1024 ** 3))
    if free_bytes is not None and free_bytes < min_free_bytes:
        reason = 'low_free_disk'

    with _stats_lock:
        _stats['local_disk_bytes'] = used
        _stats['free_disk_bytes'] = free_bytes
        _stats['documentation_paused_reason'] = reason
    return reason is None


def _copy_buffered_files_to_drive_once():
    """Copy stable buffered documentation files to Drive during sync window."""
    if not CONFIG.sync_enabled:
        return

    buffer_root = _docs_buffer_root()
    if not buffer_root.exists():
        return

    drive_root = _mesa_root()
    try:
        drive_root.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        with _stats_lock:
            _stats['last_sync_error'] = f'output_dir pending: {exc}'
        return

    # Reclaim any safe week-old duplicates before staging a new batch into
    # DriveFS. This matters on machines carrying a large legacy backlog.
    _purge_old_synced_local_days()

    now = time.time()
    copied_files = 0
    copied_bytes = 0
    try:
        for day_dir in sorted([p for p in buffer_root.iterdir() if p.is_dir()], key=lambda p: p.name):
            dest_day_dir = drive_root / day_dir.name
            dest_day_dir.mkdir(parents=True, exist_ok=True)

            for src in day_dir.rglob('*'):
                if not src.is_file():
                    continue
                try:
                    src_stat = src.stat()
                except OSError:
                    continue
                # Avoid copying a JPEG that may still be being written.
                if now - src_stat.st_mtime < 30:
                    continue

                rel = src.relative_to(day_dir)
                dest = dest_day_dir / rel
                try:
                    if dest.exists() and dest.stat().st_size == src_stat.st_size:
                        continue
                    free_bytes = _free_disk_bytes()
                    min_free_bytes = int(CONFIG.min_free_gb * (1024 ** 3))
                    if free_bytes is not None and free_bytes < min_free_bytes:
                        with _stats_lock:
                            _stats['free_disk_bytes'] = free_bytes
                            _stats['last_sync_error'] = 'sync paused: low free disk'
                        return
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dest)
                    copied_files += 1
                    copied_bytes += src_stat.st_size
                except OSError as exc:
                    with _stats_lock:
                        _stats['last_sync_error'] = f'copy {src.name}: {exc}'
                    return

        _purge_old_synced_local_days()
        pending_bytes = _dir_size_bytes(buffer_root)
        with _stats_lock:
            _stats['pending_sync_bytes'] = pending_bytes
            _stats['last_sync_at'] = datetime.now().isoformat(timespec='seconds')
            _stats['last_sync_files'] = copied_files
            _stats['last_sync_bytes'] = copied_bytes
            _stats['last_sync_error'] = None
    except Exception as exc:
        with _stats_lock:
            _stats['last_sync_error'] = str(exc)


def documentation_sync_loop():
    if not CONFIG.doc_enabled or not CONFIG.sync_enabled:
        return

    print(
        f'[DocsSync] Enabled. output={CONFIG.output_dir} '
        f'window={sync_window_label()} '
        f'every={CONFIG.sync_interval_seconds}s'
    )
    while True:
        if in_sync_window():
            _copy_buffered_files_to_drive_once()
        else:
            root = _docs_buffer_root()
            if root.exists():
                with _stats_lock:
                    _stats['pending_sync_bytes'] = _dir_size_bytes(root)
        time.sleep(max(10.0, CONFIG.sync_interval_seconds))


# ---------------------------------------------------------------------------
# Documentation thread
# ---------------------------------------------------------------------------
def documentation_loop():
    if not CONFIG.doc_enabled:
        print('[Docs] Disabled in config.ini')
        return

    try:
        CONFIG.local_buffer_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        # Keep the loop alive even if the local buffer is temporarily
        # unavailable. Each tick retries and captures start as soon as
        # Windows exposes the path again.
        _set_last_error(f'local_buffer_dir pending: {exc}')
        print(f'[Docs] local_buffer_dir not ready ({exc}); will keep retrying each tick.')

    print(f'[Docs] Enabled. mesa_id={CONFIG.mesa_id!r} '
          f'interval={CONFIG.interval_seconds}s '
          f'size={CONFIG.doc_width}x{CONFIG.doc_height}@q{CONFIG.doc_jpeg_quality}')
    print(f'[Docs] buffer={CONFIG.local_buffer_dir}')
    print(f'[Docs] drive_output={CONFIG.output_dir}')
    print(f'[Docs] schedule={sorted(CONFIG.active_days)} '
          f'{CONFIG.active_start_hour:02d}:{CONFIG.active_start_minute:02d}-'
          f'{CONFIG.active_end_hour:02d}:{CONFIG.active_end_minute:02d}')

    storage_ready = _storage_ready_for_periodic_capture()
    last_storage_check = time.monotonic()
    while True:
        started = time.monotonic()
        now = datetime.now()
        if not in_active_window(now):
            with _stats_lock:
                _stats['skipped_out_of_schedule'] += 1
            # sleep a little longer when out of hours to avoid burning cpu
            time.sleep(min(30.0, max(CONFIG.interval_seconds, 10.0)))
            continue

        if time.monotonic() - last_storage_check >= 300:
            storage_ready = _storage_ready_for_periodic_capture()
            last_storage_check = time.monotonic()
        if not storage_ready:
            with _stats_lock:
                _stats['skipped_storage_pressure'] += 1
            time.sleep(max(CONFIG.interval_seconds, 10.0))
            continue

        # Start the daily self-test and retry any doubtful result later.
        _ensure_sharpness_checked_today()

        try:
            with _camera_lock:
                ret, frame = capture_frame()
            if not ret or frame is None:
                _set_last_error('camera read failed')
            else:
                # Resize to documentation size
                resized = cv2.resize(
                    frame,
                    (CONFIG.doc_width, CONFIG.doc_height),
                    interpolation=cv2.INTER_AREA,
                )

                day_dir = _docs_buffer_root() / now.strftime('%Y-%m-%d')
                day_dir.mkdir(parents=True, exist_ok=True)
                filename = now.strftime('%H-%M-%S.jpg')
                out_path = day_dir / filename

                ok, buf = cv2.imencode(
                    '.jpg', resized,
                    [cv2.IMWRITE_JPEG_QUALITY, CONFIG.doc_jpeg_quality],
                )
                if ok:
                    out_path.write_bytes(buf.tobytes())
                    _update_stats_after_save()
                else:
                    _set_last_error('jpeg encode failed')

        except Exception as exc:
            _set_last_error(str(exc))
            print(f'[Docs] tick error: {exc}')

        elapsed = time.monotonic() - started
        sleep_for = max(0.0, CONFIG.interval_seconds - elapsed)
        time.sleep(sleep_for)


# ---------------------------------------------------------------------------
# Device pairing token, persisted next to the script so it survives a
# Chrome profile reset / Local Storage wipe. The visor reads it back
# via GET /device_token when its localStorage is empty.
# ---------------------------------------------------------------------------
def _token_path() -> Path:
    return Path(__file__).resolve().parent / 'device_token.txt'


def _player_pause_path() -> Path:
    return Path(__file__).resolve().parent / '.player_pause'


def _request_player_pause() -> bool:
    """Keep the watchdog from reopening Chrome after an intentional Q close."""
    try:
        _player_pause_path().write_text(datetime.now().isoformat(), encoding='ascii')
        return True
    except OSError:
        return False


def _player_pause_requested() -> bool:
    path = _player_pause_path()
    try:
        if not path.is_file():
            return False
        if time.time() - path.stat().st_mtime <= 30 * 60:
            return True
        path.unlink(missing_ok=True)
    except OSError:
        return False
    return False


def _read_stored_token() -> str:
    try:
        p = _token_path()
        if p.is_file():
            return p.read_text(encoding='utf-8').strip()
    except OSError:
        pass
    return ''


def _write_stored_token(token: str) -> bool:
    try:
        _token_path().write_text(token, encoding='utf-8')
        return True
    except OSError:
        return False


def _close_chrome_processes():
    """Close the kiosk browser without touching the capture service."""
    try:
        if not _request_player_pause():
            _set_last_error('close browser: could not pause the player watchdog')
        if os.name == 'nt':
            result = subprocess.run(
                ['taskkill', '/IM', 'chrome.exe', '/F'],
                capture_output=True,
                text=True,
                timeout=10,
            )
        else:
            result = subprocess.run(
                ['pkill', '-f', 'chrome'],
                capture_output=True,
                text=True,
                timeout=10,
            )
        if result.returncode != 0:
            message = (result.stderr or result.stdout or '').strip()
            _set_last_error(f'close browser failed: {message or result.returncode}')
    except Exception as exc:
        _set_last_error(f'close browser failed: {exc}')


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class CaptureHandler(BaseHTTPRequestHandler):

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        # X-Filename is sent by the visor on /save_debug_image; if it
        # isn't whitelisted here Chrome rejects the preflight and the
        # POST is never made (visor sees an HTTP error 0 with no
        # status code).
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Moden-Action')

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self._respond_json(200, {'status': 'ok'})
        elif self.path == '/stats':
            with _stats_lock:
                payload = dict(_stats)
            payload['in_active_window'] = in_active_window()
            payload['sync_window_active'] = in_sync_window()
            payload['local_buffer_dir'] = str(CONFIG.local_buffer_dir)
            payload['output_dir'] = str(CONFIG.output_dir)
            payload['sync_enabled'] = CONFIG.sync_enabled
            payload['sync_window'] = sync_window_label()
            payload['drive_process_window_active'] = in_drive_process_window()
            payload['drive_daily_enabled'] = CONFIG.drive_daily_enabled
            payload['drive_maintenance_active'] = _drive_maintenance_requested()
            payload['player_pause_active'] = _player_pause_requested()
            payload['drive_process_window'] = drive_process_window_label()
            payload['local_retention_days'] = CONFIG.local_retention_days
            payload['image_rotation'] = CONFIG.image_rotation
            self._respond_json(200, payload)
        elif self.path == '/device_token':
            self._respond_json(200, {'device_token': _read_stored_token()})
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/capture':
            self._handle_capture()
        elif self.path == '/save_debug_image':
            self._handle_save_debug_image()
        elif self.path == '/device_token':
            self._handle_store_device_token()
        elif self.path == '/close_browser':
            self._handle_close_browser()
        else:
            self.send_error(404)

    def _handle_store_device_token(self):
        """Persist the device pairing token to disk so it survives a
        Chrome profile reset / Local Storage wipe. Body is the raw
        token as text/plain (a short opaque string). An empty body
        clears the file -- used by the visor when it gets a 401 so
        the next cold boot doesn't restore the invalid token.
        """
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length > 4096:
            self.send_error(413, 'Token too large')
            return
        token = ''
        if length > 0:
            token = self.rfile.read(length).decode('utf-8', errors='replace').strip()
        if not token:
            # Clear the persisted token.
            try:
                p = _token_path()
                if p.is_file():
                    p.unlink()
            except OSError as exc:
                self.send_error(500, f'Cannot clear token: {exc}')
                return
            self._respond_json(200, {'status': 'cleared'})
            return
        if _write_stored_token(token):
            self._respond_json(200, {'status': 'ok'})
        else:
            self.send_error(500, 'Cannot persist token')

    def _is_control_request_allowed(self, expected_action: str) -> bool:
        origin = self.headers.get('Origin', '')
        action = self.headers.get('X-Moden-Action', '')
        if origin and origin not in CONTROL_ALLOWED_ORIGINS:
            return False
        return action == expected_action

    def _handle_close_browser(self):
        if not self._is_control_request_allowed('close-browser'):
            self.send_error(403, 'Forbidden')
            return

        self._respond_json(200, {'status': 'closing'})
        timer = threading.Timer(0.35, _close_chrome_processes)
        timer.daemon = True
        timer.start()

    def _handle_capture(self):
        with _camera_lock:
            ret, frame = capture_frame()
        if not ret or frame is None:
            self.send_error(500, 'Camera capture failed')
            return

        ok, jpeg_bytes = cv2.imencode(
            '.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, CONFIG.jpeg_quality]
        )
        if not ok:
            self.send_error(500, 'JPEG encoding failed')
            return

        data = jpeg_bytes.tobytes()
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _handle_save_debug_image(self):
        """Persist a debug image (e.g. an annotated check overlay) to
        Drive next to the raw captures: <output_dir>/<mesa_id>/debug/
        YYYY-MM-DD/<filename>. The visor uses this after a _check
        round-trip when COLOR_CHECK_DEBUG is on, so the bbox-overlay
        ends up alongside the day folders the supervisor already opens
        on Google Drive.

        The body is the raw JPEG bytes; the filename comes in the
        X-Filename header. Path traversal is rejected.
        """
        # Logging to file because pythonw silences stdout. The log
        # lives in <output_dir>/<mesa_id>/debug/log.txt so the
        # supervisor can read it on Drive without touching the box.
        def _log_line(msg):
            try:
                log_dir = _mesa_root() / 'debug'
                log_dir.mkdir(parents=True, exist_ok=True)
                with open(log_dir / 'log.txt', 'a', encoding='utf-8') as fh:
                    fh.write(f'{datetime.now().isoformat(timespec="seconds")} {msg}\n')
            except OSError:
                pass

        raw_filename = self.headers.get('X-Filename', '').strip()
        safe_name = os.path.basename(raw_filename)
        if not safe_name or safe_name in ('.', '..'):
            _log_line(f'400 X-Filename invalid: {raw_filename!r}')
            self.send_error(400, 'X-Filename header missing or invalid')
            return

        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0:
            _log_line(f'400 empty body for {safe_name}')
            self.send_error(400, 'Empty body')
            return
        if length > 10 * 1024 * 1024:
            _log_line(f'413 body too large ({length} bytes) for {safe_name}')
            self.send_error(413, 'Body too large')
            return

        body = self.rfile.read(length)

        day = datetime.now().strftime('%Y-%m-%d')
        dest_dir = _mesa_root() / 'debug' / day
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest_path = dest_dir / safe_name
            with open(dest_path, 'wb') as fh:
                fh.write(body)
        except OSError as exc:
            _log_line(f'500 write failed for {safe_name}: {exc}')
            self.send_error(500, f'Cannot write file: {exc}')
            return

        _log_line(f'200 wrote {safe_name} ({length} bytes) -> {dest_path}')
        self._respond_json(200, {
            'status': 'ok',
            'path': str(dest_path),
        })

    def _respond_json(self, status, payload):
        body = json.dumps(payload, default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Silent per-request logging
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    drive_guard_thread = threading.Thread(
        target=google_drive_process_guard_loop,
        name='GoogleDriveProcessGuard',
        daemon=True,
    )
    drive_guard_thread.start()

    # Start the documentation thread (no-op if disabled in config)
    doc_thread = threading.Thread(
        target=documentation_loop, name='DocumentationLoop', daemon=True
    )
    doc_thread.start()

    sync_thread = threading.Thread(
        target=documentation_sync_loop, name='DocumentationSyncLoop', daemon=True
    )
    sync_thread.start()

    server = HTTPServer((CONFIG.host, CONFIG.port), CaptureHandler)
    print(f'[CaptureService] Listening on http://{CONFIG.host}:{CONFIG.port}')
    print('[CaptureService] POST /capture            -> take a 4K photo')
    print('[CaptureService] POST /save_debug_image   -> persist a debug image to Drive')
    print('[CaptureService] GET  /device_token       -> read stored pairing token')
    print('[CaptureService] POST /device_token       -> persist pairing token to disk')
    print('[CaptureService] POST /close_browser      -> close Chrome kiosk')
    print('[CaptureService] GET  /health             -> health check')
    print('[CaptureService] GET  /stats              -> documentation stats')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[CaptureService] Shutting down...')
    finally:
        if _camera and _camera.isOpened():
            _camera.release()
        server.server_close()


if __name__ == '__main__':
    main()
