# Capture service (mini-PC)

HTTP service + documentation loop that runs on every mesa mini-PC next
to the Chrome kiosk. Single Python process:

- `POST http://127.0.0.1:5555/capture` — on-demand 4K photo for the
  visor (fires when a filename contains `_foto`, `_photo` or `_check`).
- `GET  http://127.0.0.1:5555/health` — 200 OK while running.
- `GET  http://127.0.0.1:5555/stats` — documentation counters, last
  capture timestamp, local disk usage, error details.
- Background thread that saves one FullHD JPEG every second into a
  Google-Drive-synced folder, so Marketing + QA have a record of the
  whole shift without touching the server.

## One-time install on a mini-PC

1. **Python 3.10+**
   ```powershell
   winget install Python.Python.3.12
   ```

2. **Copy the `capture_service/` folder** to `C:\moden\capture_service\`.

3. **Virtualenv + deps**
   ```powershell
   cd C:\moden\capture_service
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
   ```

4. **Google Drive Desktop** (for the documentation buffer)
   - Install from google.com/drive/download.
   - Sign in with the shared Moden account that owns the 30 TB pool.
   - Configure it as **virtual drive G:** (recommended) so `G:\Mi
     unidad\…` is the Google Drive root.
   - If you prefer "Mirror", change `output_dir` in `config.ini` to a
     local folder that lives inside the mirrored root.

5. **Per-mesa config**
   ```powershell
   copy config.ini.example config.ini
   notepad config.ini
   ```
   Edit **at least** these fields:
   - `mesa_id = mesa_inf1` (or `mesa_inf2`, `mesa_sup`, …)
   - `output_dir = G:\Mi unidad\capturas_moden`

6. **Auto-start**
   - Press `Win+R` → `shell:startup` → drop a shortcut to
     `start-player.bat` (or the .bat itself).
   - Next reboot Windows will launch the capture service and open
     Chrome in kiosk mode automatically.

## Manual smoke test

```powershell
# From a terminal on the mini-PC:
curl http://127.0.0.1:5555/health
#   -> {"status": "ok"}

curl -X POST http://127.0.0.1:5555/capture -o test.jpg
#   -> test.jpg should open as a fresh picture from the webcam.

curl http://127.0.0.1:5555/stats
#   -> counters, output_dir, last_capture_at, in_active_window, etc.
```

Also check that new files start appearing under
`G:\Mi unidad\capturas_moden\<mesa_id>\<YYYY-MM-DD>\HH-MM-SS.jpg`
and that Google Drive Desktop shows them "uploaded".

## What the documentation loop writes

```
G:\Mi unidad\capturas_moden\
└── mesa_inf1\
    ├── 2026-04-20\
    │   ├── 05-00-00.jpg
    │   ├── 05-00-01.jpg
    │   └── …
    └── 2026-04-21\
        └── …
```

- JPEG FullHD (1920x1080) @ quality 88 → ~350-500 KB per frame.
- Outside the configured working window the loop sleeps and writes
  nothing (default window: Mon-Fri, 05:00–19:00 local time).
- When the local footprint of `<output_dir>/<mesa_id>` exceeds
  `max_local_gb`, the **oldest day folders are removed**. Today's
  folder is never touched.

## Troubleshooting

- **No capture on `_foto`/`_check` images**
  - Check `/health` on the mini-PC.
  - Confirm Chrome is opened on the actual Moden URL (not a stale
    tab) and look at DevTools network to see if the POST to
    `http://127.0.0.1:5555/capture` returns 200.

- **Camera returns a black frame**
  - Close any other app holding the camera (Teams / Zoom / Windows
    Camera).
  - Windows Privacy → Camera → make sure Python is allowed.

- **Google Drive desync**
  - Drive Desktop keeps a queue; until it uploads, files pile up in
    the local mirror. The service won't write beyond `max_local_gb`
    so you're safe against runaway disk usage.

- **Change working hours / mesa id / resolution**
  - Edit `config.ini` and restart the service (easiest: log off +
    log on, or `taskkill /im python.exe` and let the .bat relaunch).
