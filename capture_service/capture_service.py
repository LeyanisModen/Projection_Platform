"""
Local camera capture HTTP service for OBSBOT Tiny 2.
Runs on each mini-PC alongside the browser Player.
Listens on localhost:5555.

Endpoints:
  POST /capture  -> Captures a photo from camera, returns JPEG bytes
  GET  /health   -> Health check

Usage:
  python capture_service.py
"""
import time
import json
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

import cv2

# Camera settings (matches detector.pyw 4K config)
CAMERA_INDEX = 0
CAPTURE_WIDTH = 3840
CAPTURE_HEIGHT = 2160
JPEG_QUALITY = 95

HOST = '127.0.0.1'
PORT = 5555

# Lazy camera singleton
_camera = None
_camera_lock = threading.Lock()


def get_camera():
    global _camera
    with _camera_lock:
        if _camera is None or not _camera.isOpened():
            _camera = cv2.VideoCapture(CAMERA_INDEX)
            _camera.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_WIDTH)
            _camera.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_HEIGHT)
            # Allow auto-exposure to settle
            time.sleep(0.5)
        return _camera


class CaptureHandler(BaseHTTPRequestHandler):

    def do_POST(self):
        if self.path == '/capture':
            self._handle_capture()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok'}).encode())
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        """CORS preflight for cross-origin requests from the Player."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _handle_capture(self):
        cam = get_camera()

        # Discard stale buffered frames to get a fresh capture
        for _ in range(3):
            cam.read()

        ret, frame = cam.read()
        if not ret:
            self.send_error(500, 'Camera capture failed')
            return

        success, jpeg_bytes = cv2.imencode(
            '.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]
        )
        if not success:
            self.send_error(500, 'JPEG encoding failed')
            return

        data = jpeg_bytes.tobytes()

        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # Suppress default per-request logging noise
        pass


def main():
    server = HTTPServer((HOST, PORT), CaptureHandler)
    print(f'[CaptureService] Listening on http://{HOST}:{PORT}')
    print('[CaptureService] POST /capture -> take photo')
    print('[CaptureService] GET  /health  -> health check')
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
