@echo off
REM ---------------------------------------------------------------------------
REM start-player.bat — lanza el capture service y Chrome kiosk en paralelo.
REM
REM Pensado para estar enganchado en shell:startup. Los dos `start` salen
REM inmediatamente (no bloquean), así que Windows termina el login rápido
REM y cada proceso resuelve su propio arranque:
REM   - Python hace su import de OpenCV (2-3 s) y abre el puerto 5555.
REM   - Chrome arranca en kiosk; si la red aún no está resuelta, reintenta
REM     por su cuenta — más rápido que un ping loop bloqueante.
REM ---------------------------------------------------------------------------

set ROOT=C:\moden\capture_service

REM 1. Capture service en background con pythonw.exe (sin consola).
REM    Usando python.exe cada print del servicio hacía parpadear la
REM    barra de tareas sobre el kiosko; pythonw no tiene stdout en
REM    consola, así que no existe ese problema. Los mensajes siguen
REM    disponibles vía /stats (last_error, last_capture_at, ...).
start "CaptureService" /B "%ROOT%\venv\Scripts\pythonw.exe" "%ROOT%\capture_service.py"

REM 2. Chrome fullscreen kiosk. Flags:
REM    --no-first-run / --no-default-browser-check → sin splash inicial.
REM    --disable-background-networking → sin checks de sync al boot.
REM    --disable-features=CalculateNativeWinOcclusion → el renderer no se
REM       auto-pausa cuando Windows cree que la ventana está oculta
REM       (esa era la razón de que al clicar "despertase").
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
