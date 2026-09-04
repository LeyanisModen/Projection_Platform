# Capture service (mini-PC)

HTTP service + documentation loop that runs on every mesa mini-PC next
to the Chrome kiosk. Single Python process:

- `POST http://127.0.0.1:5555/capture` — on-demand 4K photo for the
  visor (fires when a filename contains `_foto`, `_photo` or `_check`).
- `POST http://127.0.0.1:5555/shutdown_pc` - protected local control used
  only after the player detects a five-second Left + Space + Right hold.
- `GET  http://127.0.0.1:5555/health` — 200 OK while running.
- `GET  http://127.0.0.1:5555/stats` — documentation counters, last
  capture timestamp, local disk usage, error details.
- Background thread that saves one FullHD JPEG every 20 seconds into a
  local buffer, so Marketing + QA have a record of the whole shift without
  competing with production for internet bandwidth.
- Google Drive Desktop process guard: Drive runs Friday 15:15 through Monday
  06:35 for photo sync. Outside that window it is closed so no error dialog
  can cover Chrome kiosk. Software updates come directly from GitHub.

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

6. **Auto-start and recovery** — register the persistent watchdog for the
   `moden` account. It restores the local service or kiosk if either stops:

   ```powershell
   $watchdog = 'C:\moden\capture_service\player-watchdog.ps1'
   $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
       -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`""
   $trigger  = New-ScheduledTaskTrigger -AtLogOn -User 'moden'
   $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
       -DontStopIfGoingOnBatteries -StartWhenAvailable `
       -MultipleInstances IgnoreNew -RestartCount 5 `
       -RestartInterval (New-TimeSpan -Minutes 1) `
       -ExecutionTimeLimit ([TimeSpan]::Zero)
   Register-ScheduledTask -TaskName 'MODEN Player' `
       -Action $action -Trigger $trigger -Settings $settings `
       -RunLevel Limited -User 'moden' -Force
   ```

   Next reboot, Windows will launch the watchdog. It checks Chrome and restores
   its keyboard focus every 10 seconds, while checking the capture service every
   30 seconds. The double `Q` maintenance pause disables both kiosk reopening
   and focus recovery. Chrome uses the isolated
   `C:\moden\chrome-kiosk-profile`, not a
   personal Google profile, and its cache is capped. `install-minipc.ps1` already
   does this step — only run it by hand if you're setting up the
   service outside the installer.

## Manual smoke test

Do not call `/shutdown_pc` during a smoke test: a valid request schedules a
real forced Windows shutdown. Test it only through the player chord after the
new capture-service version and frontend bundle are both installed.

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
to `G:\Mi unidad\capturas_moden\...` from Friday 15:30 through Monday 05:00.

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
- Local folders are retained for seven days and removed only when every file
  has a matching path and size in `G:`. If the buffer reaches `max_local_gb`
  or the disk falls below `min_free_gb`, periodic documentation pauses rather
  than deleting a unique copy. Player and required flow captures continue.

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
  - Drive is intentionally closed throughout production. A weekday Drive
    error cannot interrupt projection; pending files stay in the local buffer.
  - The weekly photo batch is staged into `G:` during the weekend and retried
    every 30 minutes. Drive remains open until Monday 06:35 for cloud upload.
  - The automatic updater checks GitHub `deploy` at 04:15. It downloads only
    `VERSION` when nothing changed and does not need to start Google Drive.
    A manual update with `-Force` downloads and reapplies the current release.

- **Change working hours / mesa id / resolution**
  - Edit `config.ini` and restart the service (easiest: log off +
    log on, or `taskkill /im python.exe` and let the .bat relaunch).
