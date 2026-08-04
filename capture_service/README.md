# Capture service (mini-PC)

HTTP service + documentation loop that runs on every mesa mini-PC next
to the Chrome kiosk. Single Python process:

- `POST http://127.0.0.1:5555/capture` — on-demand 4K photo for the
  visor (fires when a filename contains `_foto`, `_photo` or `_check`).
- `GET  http://127.0.0.1:5555/health` — 200 OK while running.
- `GET  http://127.0.0.1:5555/stats` — documentation counters, last
  capture timestamp, local disk usage, error details.
- Background thread that saves one FullHD JPEG every 20 seconds into a
  local buffer, so Marketing + QA have a record of the whole shift without
  competing with production for internet bandwidth.
- Google Drive Desktop process guard: Drive runs only from 00:45 to 06:35.
  Outside that window it is closed so no sync-error dialog can cover Chrome
  kiosk. Buffered photos remain safe in `C:\moden\capture_buffer`.

## One-time install on a mini-PC

1. **Python 3.10+**
   ```powershell
   winget install Python.Python.3.12
   ```

2. **Copy the `capture_service/` folder** to `C:\moden\capture_service\`.
   The bundled `branding-wallpaper.jpg` and `branding-user.jpg` are
   applied automatically by the installer as desktop wallpaper and
   Windows account picture.

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
   - `mesa_id = fer_g1_mesa1` (format `<cli>_g<N>_mesa<M>`, e.g.
     `fer_g1_mesa2`, `fer_g2_mesa1`, …).
   - `output_dir = G:\Mi unidad\capturas_moden`

6. **Auto-start** — register a scheduled task "at logon" for the
   `moden` account so `start-player.bat` fires without the
   `shell:startup` delay:

   ```powershell
   $bat = 'C:\moden\capture_service\start-player.bat'
   $action   = New-ScheduledTaskAction  -Execute $bat
   $trigger  = New-ScheduledTaskTrigger -AtLogOn -User 'moden'
   $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                 -DontStopIfGoingOnBatteries -StartWhenAvailable
   Register-ScheduledTask -TaskName 'MODEN Player' `
       -Action $action -Trigger $trigger -Settings $settings `
       -RunLevel Limited -User 'moden' -Force
   ```

   Next reboot, Windows will launch the capture service and open
   Chrome in kiosk mode automatically. `install-minipc.ps1` already
   does this step — only run it by hand if you're setting up the
   service outside the installer.

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

During production, check that new files appear under
`C:\moden\capture_buffer\<mesa_id>\<YYYY-MM-DD>\HH-MM-SS.jpg`. They are copied
to `G:\Mi unidad\capturas_moden\...` during the 01:00-05:00 sync window.

## What the documentation loop writes

```
G:\Mi unidad\capturas_moden\
└── fer_g1_mesa1\
    ├── 2026-04-20\
    │   ├── 05-00-00.jpg
    │   ├── 05-00-01.jpg
    │   └── …
    └── 2026-04-21\
        └── …
```

- JPEG FullHD (1920x1080) @ quality 88 → ~350-500 KB per frame.
- Outside the configured working window the loop sleeps and writes
  nothing (default window: Mon-Fri, 06:50-15:00 local time).
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
  - Drive is intentionally closed from 06:35 until 00:45. A daytime Drive
    error cannot interrupt projection; pending files stay in the local buffer.
  - The automatic updater runs at 04:15, inside the Drive window. A manual
    update with `-Force` opens Drive temporarily and keeps it available until
    the update finishes; no extra preparation is needed.

- **Change working hours / mesa id / resolution**
  - Edit `config.ini` and restart the service (easiest: log off +
    log on, or `taskkill /im python.exe` and let the .bat relaunch).
