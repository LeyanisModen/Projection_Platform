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
     GET  /health             -> { "status": "ok" }
     GET  /stats              -> { documentation / counters / local
                                  disk usage }

  2. Documentation thread (periodic, configurable)
     Every `interval_seconds` saves a resized JPEG into
       <output_dir>/<mesa_id>/YYYY-MM-DD/HH-MM-SS.jpg
     so Google Drive Desktop (pointing at output_dir) syncs it to the
     cloud. Runs only inside the configured working window (days + hours)
     and prunes the oldest day folders when the local footprint exceeds
     `max_local_gb`.

All settings come from `config.ini` next to this script.
"""
import configparser
import json
import os
import shutil
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


class Config:
    def __init__(self, path: Path):
        self.capture_width = 3840
        self.capture_height = 2160
        self.jpeg_quality = 95
        self.host = '127.0.0.1'
        self.port = 5555
        self.camera_index = 0
        # Backend name (resolved later as cv2.<name>). CAP_ANY lets OpenCV
        # pick; override to CAP_DSHOW or CAP_MSMF if a given PC needs it.
        self.camera_backend = 'CAP_ANY'

        # documentation defaults (disabled until the .ini turns it on)
        self.doc_enabled = False
        self.output_dir = Path('C:/moden/capturas')
        self.mesa_id = 'mesa_unknown'
        self.interval_seconds = 1.0
        self.doc_width = 1920
        self.doc_height = 1080
        self.doc_jpeg_quality = 88
        self.max_local_gb = 30.0
        self.active_days = {0, 1, 2, 3, 4}  # MON..FRI
        self.active_start_hour = 5
        self.active_end_hour = 19

        # Daily sharpness check (uses variance of Laplacian on the first
        # frame of the day; low variance = blurry / dirty lens).
        self.sharpness_enabled = True
        self.sharpness_threshold_blurry = 50.0
        self.sharpness_threshold_warning = 150.0

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

        if cp.has_section('documentation'):
            d = cp['documentation']
            self.doc_enabled = d.getboolean('enabled', self.doc_enabled)
            self.output_dir = Path(d.get('output_dir', str(self.output_dir)))
            self.mesa_id = d.get('mesa_id', self.mesa_id)
            self.interval_seconds = d.getfloat('interval_seconds', self.interval_seconds)
            self.doc_width = d.getint('width', self.doc_width)
            self.doc_height = d.getint('height', self.doc_height)
            self.doc_jpeg_quality = d.getint('jpeg_quality', self.doc_jpeg_quality)
            self.max_local_gb = d.getfloat('max_local_gb', self.max_local_gb)
            days_raw = d.get('active_days', 'MON,TUE,WED,THU,FRI')
            self.active_days = {
                DAY_NAME_TO_INDEX[x.strip().upper()]
                for x in days_raw.split(',')
                if x.strip().upper() in DAY_NAME_TO_INDEX
            }
            self.active_start_hour = d.getint('active_start_hour', self.active_start_hour)
            self.active_end_hour = d.getint('active_end_hour', self.active_end_hour)

        if cp.has_section('sharpness'):
            s = cp['sharpness']
            self.sharpness_enabled = s.getboolean('enabled', self.sharpness_enabled)
            self.sharpness_threshold_blurry = s.getfloat(
                'threshold_blurry', self.sharpness_threshold_blurry
            )
            self.sharpness_threshold_warning = s.getfloat(
                'threshold_warning', self.sharpness_threshold_warning
            )


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
    # Discard a few buffered frames so we get a fresh one.
    for _ in range(3):
        cam.read()
    return cam.read()


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
    'last_error': None,
    'skipped_out_of_schedule': 0,
    # Sharpness check (runs once per day on the first active tick)
    'sharpness_status': 'unknown',  # unknown | ok | warning | blurry
    'sharpness_score': None,
    'sharpness_checked_at': None,
    'sharpness_checked_date': None,
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


# ---------------------------------------------------------------------------
# Sharpness check — detects a dirty / blurry lens once per day.
# ---------------------------------------------------------------------------
def _laplacian_variance(frame) -> float:
    """Higher variance = sharper image. A dirty / smudged lens softens
    edges and drops the variance significantly."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _sharpness_status_for(score: float) -> str:
    if score < CONFIG.sharpness_threshold_blurry:
        return 'blurry'
    if score < CONFIG.sharpness_threshold_warning:
        return 'warning'
    return 'ok'


def _ensure_sharpness_checked_today():
    """Runs the sharpness analysis once per active day. Needs _camera_lock
    on entry. No-op if already checked today, disabled, or we already
    have a fresh capture in flight."""
    if not CONFIG.sharpness_enabled:
        return
    today_iso = datetime.now().date().isoformat()
    with _stats_lock:
        if _stats['sharpness_checked_date'] == today_iso:
            return
    try:
        with _camera_lock:
            ret, frame = capture_frame()
        if not ret or frame is None:
            return
        score = _laplacian_variance(frame)
        status = _sharpness_status_for(score)
        now_iso = datetime.now().isoformat(timespec='seconds')
        with _stats_lock:
            _stats['sharpness_score'] = round(score, 2)
            _stats['sharpness_status'] = status
            _stats['sharpness_checked_at'] = now_iso
            _stats['sharpness_checked_date'] = today_iso
        print(f'[Sharpness] {status} (score={score:.1f}) for {CONFIG.mesa_id}')
    except Exception as exc:
        _set_last_error(f'sharpness: {exc}')


# ---------------------------------------------------------------------------
# Schedule check
# ---------------------------------------------------------------------------
def in_active_window(now: datetime = None) -> bool:
    now = now or datetime.now()
    if now.weekday() not in CONFIG.active_days:
        return False
    start = dtime(CONFIG.active_start_hour, 0)
    end = dtime(CONFIG.active_end_hour, 0)
    current = now.time()
    return start <= current < end


# ---------------------------------------------------------------------------
# Disk usage + purge (only inside output_dir/mesa_id)
# ---------------------------------------------------------------------------
def _mesa_root() -> Path:
    return CONFIG.output_dir / CONFIG.mesa_id


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


def _prune_if_needed():
    """Drop the oldest day folders until we're back under max_local_gb."""
    root = _mesa_root()
    if not root.exists():
        return
    max_bytes = int(CONFIG.max_local_gb * (1024 ** 3))
    used = _dir_size_bytes(root)
    with _stats_lock:
        _stats['local_disk_bytes'] = used
    if used <= max_bytes:
        return

    # Day folders are YYYY-MM-DD so alphabetical == chronological.
    day_dirs = sorted(
        [p for p in root.iterdir() if p.is_dir()],
        key=lambda p: p.name,
    )
    today = datetime.now().date().isoformat()
    for day_dir in day_dirs:
        if used <= max_bytes:
            break
        if day_dir.name == today:
            break  # never touch today's folder
        try:
            freed = _dir_size_bytes(day_dir)
            shutil.rmtree(day_dir, ignore_errors=True)
            used = max(0, used - freed)
        except Exception as exc:
            _set_last_error(f'prune: {exc}')
            break

    with _stats_lock:
        _stats['local_disk_bytes'] = used


# ---------------------------------------------------------------------------
# Documentation thread
# ---------------------------------------------------------------------------
def documentation_loop():
    if not CONFIG.doc_enabled:
        print('[Docs] Disabled in config.ini')
        return

    try:
        CONFIG.output_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        # Most common cause on boot: Google Drive Desktop hasn't
        # finished mounting G:\ yet. Don't kill the loop — each tick
        # re-tries creating its day_dir, and as soon as Drive comes up
        # captures start flowing.
        _set_last_error(f'output_dir pending: {exc}')
        print(f'[Docs] output_dir not ready ({exc}); will keep retrying each tick.')

    print(f'[Docs] Enabled. mesa_id={CONFIG.mesa_id!r} '
          f'interval={CONFIG.interval_seconds}s '
          f'size={CONFIG.doc_width}x{CONFIG.doc_height}@q{CONFIG.doc_jpeg_quality}')
    print(f'[Docs] output={CONFIG.output_dir}')
    print(f'[Docs] schedule={sorted(CONFIG.active_days)} '
          f'{CONFIG.active_start_hour:02d}:00-{CONFIG.active_end_hour:02d}:00')

    prune_counter = 0
    while True:
        started = time.monotonic()
        now = datetime.now()
        if not in_active_window(now):
            with _stats_lock:
                _stats['skipped_out_of_schedule'] += 1
            # sleep a little longer when out of hours to avoid burning cpu
            time.sleep(min(30.0, max(CONFIG.interval_seconds, 10.0)))
            continue

        # First active tick of the day: run the sharpness self-test so
        # the operator is warned early if the lens is dirty.
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

                day_dir = _mesa_root() / now.strftime('%Y-%m-%d')
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

            # Prune disk usage once every ~60 captures (i.e. ~once per minute
            # at 1s interval) so we don't stat the whole tree on every tick.
            prune_counter += 1
            if prune_counter >= 60:
                _prune_if_needed()
                prune_counter = 0
        except Exception as exc:
            _set_last_error(str(exc))
            print(f'[Docs] tick error: {exc}')

        elapsed = time.monotonic() - started
        sleep_for = max(0.0, CONFIG.interval_seconds - elapsed)
        time.sleep(sleep_for)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class CaptureHandler(BaseHTTPRequestHandler):

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

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
            payload['output_dir'] = str(CONFIG.output_dir)
            self._respond_json(200, payload)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/capture':
            self._handle_capture()
        elif self.path == '/save_debug_image':
            self._handle_save_debug_image()
        else:
            self.send_error(404)

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
        raw_filename = self.headers.get('X-Filename', '').strip()
        # Strip any path component the caller may have sneaked in.
        safe_name = os.path.basename(raw_filename)
        if not safe_name or safe_name in ('.', '..'):
            self.send_error(400, 'X-Filename header missing or invalid')
            return

        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0:
            self.send_error(400, 'Empty body')
            return
        # Cap accepted size at 10 MB to avoid runaway uploads.
        if length > 10 * 1024 * 1024:
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
            self.send_error(500, f'Cannot write file: {exc}')
            return

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
    # Start the documentation thread (no-op if disabled in config)
    doc_thread = threading.Thread(
        target=documentation_loop, name='DocumentationLoop', daemon=True
    )
    doc_thread.start()

    server = HTTPServer((CONFIG.host, CONFIG.port), CaptureHandler)
    print(f'[CaptureService] Listening on http://{CONFIG.host}:{CONFIG.port}')
    print('[CaptureService] POST /capture            -> take a 4K photo')
    print('[CaptureService] POST /save_debug_image   -> persist a debug image to Drive')
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
