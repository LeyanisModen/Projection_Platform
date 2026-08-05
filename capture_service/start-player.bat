@echo off
REM Idempotent launcher for the MODEN player.
REM The persistent scheduled task runs player-watchdog.ps1. This command is
REM also safe to run manually: it clears an intentional Q pause and starts a
REM persistent watchdog. Its mutex prevents duplicate watchdogs and processes.

set ROOT=C:\moden\capture_service

start "" /B powershell.exe -NoProfile -WindowStyle Hidden ^
  -ExecutionPolicy Bypass -File "%ROOT%\player-watchdog.ps1" -Resume
