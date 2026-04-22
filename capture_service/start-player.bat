@echo off
REM ---------------------------------------------------------------------------
REM start-player.bat — launches the capture service in the background and then
REM opens Chrome in kiosk mode pointing to the Moden player.
REM
REM Deploy: drop this file (and the capture_service folder) on the mini-PC,
REM then copy a shortcut to `shell:startup` so Windows runs it at login.
REM ---------------------------------------------------------------------------

set ROOT=C:\moden\capture_service

REM 1. Launch the capture service (Python + OpenCV). Runs detached.
pushd "%ROOT%"
start "CaptureService" /B "%ROOT%\venv\Scripts\python.exe" "%ROOT%\capture_service.py"
popd

REM 2. Wait until the network is actually up before asking Chrome to load
REM    an HTTPS URL; otherwise Chrome spends a while retrying DNS.
REM    Up to ~30 s, pinging Railway's IP every 2 s.
set /A WAIT_COUNT=0
:waitnet
ping -n 1 -w 1000 moden.up.railway.app > nul 2>&1
if %errorlevel%==0 goto netok
set /A WAIT_COUNT+=1
if %WAIT_COUNT% geq 15 goto netok
timeout /t 2 /nobreak > nul
goto waitnet
:netok

REM 3. Small pause so Python + OpenCV finish importing before Chrome starts
REM    asking for captures.
timeout /t 3 /nobreak > nul

REM 4. Chrome fullscreen kiosk. Flags:
REM    --no-first-run              → skip welcome/default-browser prompts
REM    --no-default-browser-check  → idem
REM    --disable-background-networking → no sync/usage checks at boot
REM    --disable-features=...      → no translate bar, no occlusion pause
REM      (CalculateNativeWinOcclusion makes Chrome idle when it thinks the
REM      window is hidden — bit this the kiosk during the first seconds)
start "" chrome.exe ^
  --kiosk ^
  --noerrdialogs ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-networking ^
  --disable-translate ^
  --disable-features=TranslateUI,CalculateNativeWinOcclusion ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  "https://moden.up.railway.app/player"
