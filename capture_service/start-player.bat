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

REM 2. Give the camera a moment to warm up before Chrome asks for a picture.
timeout /t 5 /nobreak > nul

REM 3. Chrome fullscreen kiosk. Alt+F4 closes it; anything else is blocked.
REM    --disable-translate keeps the bilingual UI steady.
REM    --disable-features=TranslateUI hides the translate bar.
start "" chrome.exe ^
  --kiosk ^
  --noerrdialogs ^
  --disable-translate ^
  --disable-features=TranslateUI ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  "https://moden.up.railway.app/player"
