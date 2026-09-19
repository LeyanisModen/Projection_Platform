<#
.SYNOPSIS
  Keeps the MODEN capture service and Chrome kiosk running.

.DESCRIPTION
  The script normally stays alive as the scheduled task "MODEN Player" and
  checks the kiosk every 10 seconds and the local service every 30 seconds.
  It also restores keyboard focus to the kiosk when another application takes
  it. An isolated Chrome profile prevents personal profiles, account prompts
  and normal Chrome windows from replacing the production kiosk.

  Second screen (optional, automatic): when Windows reports two displays the
  player goes to the display that is NOT the Windows main display (the
  projector) and a read-only mirror (/monitor) opens on the main display (the
  monitor at operator height). With a single display nothing changes: no extra
  Chrome, same arguments, same checks. Creating the file .single_screen next
  to this script disables the second screen without touching anything else.

  -Once performs a single check for manual recovery.
  -Resume clears the temporary pause created when Q closes the browser.
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [int]$IntervalSeconds = 10,
    [int]$PauseMinutes = 30,
    [switch]$Once,
    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Windows PowerShell 5.1 can evaluate $PSScriptRoot too early when it is used
# directly as a parameter default, leaving Root empty in a scheduled task.
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($Root)) {
    throw 'Could not determine the capture-service root directory.'
}

$captureScript = Join-Path $Root 'capture_service.py'
$python = Join-Path $Root 'venv\Scripts\python.exe'
$maintenanceMarker = Join-Path $Root '.player_maintenance'
$pauseMarker = Join-Path $Root '.player_pause'
$kioskProfile = 'C:\moden\chrome-kiosk-profile'
$kioskCache = 'C:\moden\chrome-kiosk-cache'
$playerUrl = 'https://moden.up.railway.app/player'
# Second screen. The profile path must not contain $kioskProfile as a
# substring: the kiosk is recognised by matching that path on the command line.
$monitorProfile = 'C:\moden\chrome-monitor-profile'
$monitorCache = 'C:\moden\chrome-monitor-cache'
$monitorUrl = 'https://moden.up.railway.app/monitor'
$singleScreenMarker = Join-Path $Root '.single_screen'
$monitorReopenMinutes = 10
$monitorWasRunning = $false
$monitorReopenAfter = [datetime]::MinValue
$dualScreenActive = $false
$displayApiReady = $false
$screenMoveAttempts = @{}
$logPath = Join-Path $Root 'logs\player-watchdog.log'
$captureErrorLog = Join-Path $Root 'logs\capture-service-error.log'
$captureHealthFailures = 0
$lastCaptureHealthCheck = [datetime]::MinValue
$focusRecoveryFailures = 0

if (-not ('ModenPlayer.NativeWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ModenPlayer
{
    public static class NativeWindow
    {
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(
            IntPtr windowHandle,
            out uint processId
        );

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AttachThreadInput(
            uint attachThread,
            uint attachToThread,
            [MarshalAs(UnmanagedType.Bool)] bool attach
        );

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool BringWindowToTop(IntPtr windowHandle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr windowHandle);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindowAsync(
            IntPtr windowHandle,
            int command
        );

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsIconic(IntPtr windowHandle);

        public static uint GetForegroundProcessId()
        {
            uint processId;
            GetWindowThreadProcessId(GetForegroundWindow(), out processId);
            return processId;
        }

        public static bool RestoreForegroundWindow(IntPtr target)
        {
            if (target == IntPtr.Zero)
            {
                return false;
            }

            IntPtr foreground = GetForegroundWindow();
            if (foreground == target)
            {
                return true;
            }

            ShowWindowAsync(target, IsIconic(target) ? SW_RESTORE : SW_SHOW);

            uint ignoredProcessId;
            uint currentThread = GetCurrentThreadId();
            uint foregroundThread = foreground == IntPtr.Zero
                ? 0
                : GetWindowThreadProcessId(foreground, out ignoredProcessId);
            uint targetThread = GetWindowThreadProcessId(
                target,
                out ignoredProcessId
            );
            bool attachedForeground = false;
            bool attachedTarget = false;

            try
            {
                if (foregroundThread != 0 && foregroundThread != currentThread)
                {
                    attachedForeground = AttachThreadInput(
                        currentThread,
                        foregroundThread,
                        true
                    );
                }
                if (targetThread != 0 &&
                    targetThread != currentThread &&
                    targetThread != foregroundThread)
                {
                    attachedTarget = AttachThreadInput(
                        currentThread,
                        targetThread,
                        true
                    );
                }

                BringWindowToTop(target);
                SetForegroundWindow(target);
                return GetForegroundWindow() == target;
            }
            finally
            {
                if (attachedTarget)
                {
                    AttachThreadInput(currentThread, targetThread, false);
                }
                if (attachedForeground)
                {
                    AttachThreadInput(currentThread, foregroundThread, false);
                }
            }
        }
    }
}
'@
}

# Display enumeration lives in its own type and its own try/catch: if it
# cannot be compiled the watchdog keeps working exactly as a single-screen one.
try {
    if (-not ('ModenPlayer.Displays' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace ModenPlayer
{
    public class DisplayInfo
    {
        public int Left;
        public int Top;
        public int Width;
        public int Height;
        public bool Primary;
    }

    public static class Displays
    {
        private const uint MONITORINFOF_PRIMARY = 1;
        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOACTIVATE = 0x0010;
        private static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        private delegate bool MonitorEnumProc(
            IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);

        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(
            IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);

        [DllImport("user32.dll")]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetWindowPos(
            IntPtr window, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

        // Physical pixels on every display, whatever scaling each one uses.
        private static void UsePhysicalPixels()
        {
            try { SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2); }
            catch (EntryPointNotFoundException) { }
        }

        private static bool TryGetInfo(IntPtr monitor, out MONITORINFO info)
        {
            info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            return GetMonitorInfo(monitor, ref info);
        }

        public static DisplayInfo[] GetDisplays()
        {
            UsePhysicalPixels();
            List<DisplayInfo> displays = new List<DisplayInfo>();
            MonitorEnumProc callback = delegate(
                IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data)
            {
                MONITORINFO info;
                if (TryGetInfo(monitor, out info))
                {
                    DisplayInfo display = new DisplayInfo();
                    display.Left = info.rcMonitor.Left;
                    display.Top = info.rcMonitor.Top;
                    display.Width = info.rcMonitor.Right - info.rcMonitor.Left;
                    display.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
                    display.Primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
                    displays.Add(display);
                }
                return true;
            };
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return displays.ToArray();
        }

        public static bool IsWindowOn(IntPtr window, DisplayInfo display)
        {
            UsePhysicalPixels();
            MONITORINFO info;
            IntPtr monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
            return monitor != IntPtr.Zero
                && TryGetInfo(monitor, out info)
                && info.rcMonitor.Left == display.Left
                && info.rcMonitor.Top == display.Top;
        }

        public static bool MoveWindowTo(IntPtr window, DisplayInfo display)
        {
            UsePhysicalPixels();
            return SetWindowPos(
                window, IntPtr.Zero,
                display.Left, display.Top, display.Width, display.Height,
                SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }
}
'@
    }
    $displayApiReady = $true
} catch {
    $displayApiReady = $false
}

function Write-WatchdogLog([string]$Message) {
    try {
        $logDir = Split-Path $logPath -Parent
        if (-not (Test-Path $logDir)) {
            New-Item -Path $logDir -ItemType Directory -Force | Out-Null
        }
        if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 1MB) {
            Clear-Content -Path $logPath -ErrorAction SilentlyContinue
        }
        Add-Content -Path $logPath `
            -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" `
            -Encoding UTF8
    } catch {
        # Recovery must not fail because its diagnostic log is unavailable.
    }
}

function Get-ChromeExecutable {
    foreach ($basePath in @(
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:LOCALAPPDATA
    )) {
        if ([string]::IsNullOrWhiteSpace($basePath)) {
            continue
        }
        $candidate = Join-Path $basePath 'Google\Chrome\Application\chrome.exe'
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    return $null
}

function Get-CaptureProcesses {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($name in @('python.exe', 'pythonw.exe')) {
        Get-CimInstance Win32_Process -Filter "Name = '$name'" `
            -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.CommandLine -and $_.CommandLine -match '(?i)capture_service\.py') {
                    [void]$result.Add($_)
                }
            }
    }
    return @($result)
}

function Test-CaptureServiceHealthy {
    try {
        $response = Invoke-WebRequest `
            -Uri 'http://127.0.0.1:5555/health' `
            -UseBasicParsing `
            -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Start-CaptureService {
    if (-not (Test-Path $python) -or -not (Test-Path $captureScript)) {
        Write-WatchdogLog 'Capture service files are missing; cannot start it.'
        return
    }

    $logDir = Split-Path $captureErrorLog -Parent
    if (-not (Test-Path $logDir)) {
        New-Item -Path $logDir -ItemType Directory -Force | Out-Null
    }
    if ((Test-Path $captureErrorLog) -and (Get-Item $captureErrorLog).Length -gt 1MB) {
        Clear-Content -Path $captureErrorLog -ErrorAction SilentlyContinue
    }

    $process = Start-Process -FilePath $python `
        -ArgumentList "-u `"$captureScript`"" `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardError $captureErrorLog `
        -PassThru
    Start-Sleep -Seconds 3

    if ($process.HasExited) {
        $details = ''
        if (Test-Path $captureErrorLog) {
            $details = (@(Get-Content $captureErrorLog -Tail 8) -join ' | ').Trim()
        }
        if ([string]::IsNullOrWhiteSpace($details)) {
            $details = 'No Python error output was produced.'
        }
        Write-WatchdogLog "Capture service exited immediately (code $($process.ExitCode)): $details"
        return
    }

    Write-WatchdogLog "Capture service started (PID $($process.Id))."
}

function Repair-CaptureService {
    $healthy = Test-CaptureServiceHealthy
    $processes = @(Get-CaptureProcesses)
    if ($healthy) {
        $script:captureHealthFailures = 0
        return
    }

    if ($processes.Count -eq 0) {
        $script:captureHealthFailures = 0
        Start-CaptureService
        return
    }

    # A real photo request can temporarily occupy the single HTTP worker.
    # Require three consecutive failures before replacing a running process.
    $script:captureHealthFailures++
    if ($script:captureHealthFailures -lt 3) {
        return
    }

    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
    Write-WatchdogLog 'Capture service was unresponsive for three checks; restarting it.'
    $script:captureHealthFailures = 0
    Start-CaptureService
}

function Get-RootChromeProcesses {
    return @(
        Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" `
            -ErrorAction SilentlyContinue | Where-Object {
                -not $_.CommandLine -or $_.CommandLine -notmatch '(?i)(^|\s)--type='
            }
    )
}

function Get-KioskWindowHandle([object[]]$KioskRoots) {
    foreach ($rootProcess in $KioskRoots) {
        try {
            $nativeProcess = Get-Process -Id $rootProcess.ProcessId `
                -ErrorAction Stop
            $windowHandle = [IntPtr]$nativeProcess.MainWindowHandle
            if ($windowHandle -ne [IntPtr]::Zero) {
                return $windowHandle
            }
        } catch {
            continue
        }
    }
    return [IntPtr]::Zero
}

function Get-ForegroundWindowDescription {
    $ownerProcessId = [uint32][ModenPlayer.NativeWindow]::GetForegroundProcessId()
    if ($ownerProcessId -eq 0) {
        return 'unknown window'
    }
    try {
        $owner = Get-Process -Id $ownerProcessId -ErrorAction Stop
        $title = ($owner.MainWindowTitle -replace '[\r\n]+', ' ').Trim()
        if ([string]::IsNullOrWhiteSpace($title)) {
            $title = '-'
        }
        return "$($owner.ProcessName) pid=$ownerProcessId title='$title'"
    } catch {
        return "pid=$ownerProcessId"
    }
}

function Repair-KioskFocus([object[]]$KioskRoots) {
    $windowHandle = Get-KioskWindowHandle $KioskRoots
    if ($windowHandle -eq [IntPtr]::Zero) {
        $script:focusRecoveryFailures++
        if ($script:focusRecoveryFailures -eq 1 -or
            $script:focusRecoveryFailures % 6 -eq 0) {
            Write-WatchdogLog 'Kiosk is running but its window handle is unavailable.'
        }
        return
    }

    $foregroundHandle = [ModenPlayer.NativeWindow]::GetForegroundWindow()
    if ($foregroundHandle -eq $windowHandle) {
        $script:focusRecoveryFailures = 0
        return
    }

    $previousForeground = Get-ForegroundWindowDescription
    if ([ModenPlayer.NativeWindow]::RestoreForegroundWindow($windowHandle)) {
        $script:focusRecoveryFailures = 0
        Write-WatchdogLog (
            "Kiosk keyboard focus restored; previous foreground: " +
            $previousForeground
        )
        return
    }

    $script:focusRecoveryFailures++
    if ($script:focusRecoveryFailures -eq 1 -or
        $script:focusRecoveryFailures % 6 -eq 0) {
        Write-WatchdogLog (
            "Could not restore kiosk keyboard focus; foreground: " +
            $previousForeground
        )
    }
}

function Stop-ChromeTree([int]$ProcessId) {
    Start-Process -FilePath 'taskkill.exe' `
        -ArgumentList "/PID $ProcessId /T /F" `
        -WindowStyle Hidden `
        -Wait | Out-Null
}

function Test-PlayerPause {
    if (-not (Test-Path $pauseMarker)) {
        return $false
    }
    try {
        $age = (Get-Date) - (Get-Item $pauseMarker).LastWriteTime
        if ($age.TotalMinutes -le $PauseMinutes) {
            return $true
        }
        Remove-Item -LiteralPath $pauseMarker -Force -ErrorAction SilentlyContinue
        Write-WatchdogLog 'Intentional player pause expired; kiosk recovery enabled.'
    } catch {
        return $false
    }
    return $false
}

function Test-PlayerMaintenance {
    if (-not (Test-Path $maintenanceMarker)) {
        return $false
    }
    try {
        $age = (Get-Date) - (Get-Item $maintenanceMarker).LastWriteTime
        if ($age.TotalMinutes -le 30) {
            return $true
        }
        Remove-Item -LiteralPath $maintenanceMarker -Force -ErrorAction SilentlyContinue
        Write-WatchdogLog 'Stale update marker removed; player recovery enabled.'
    } catch {
        return $false
    }
    return $false
}

# Returns $null for "behave as a single-screen mini-PC" (one display, the
# .single_screen switch, or any problem reading the displays). Otherwise the
# projector (first display that is not the Windows main one) and the monitor.
function Get-DualScreenLayout {
    $layout = $null
    try {
        if ($script:displayApiReady -and -not (Test-Path $singleScreenMarker)) {
            $displays = [ModenPlayer.Displays]::GetDisplays()
            if ($displays.Length -ge 2) {
                $monitor = $null
                $projector = $null
                foreach ($display in $displays) {
                    if ($display.Primary -and -not $monitor) {
                        $monitor = $display
                    } elseif (-not $display.Primary -and -not $projector) {
                        $projector = $display
                    }
                }
                if ($monitor -and $projector) {
                    $layout = @{ Monitor = $monitor; Projector = $projector }
                }
            }
        }
    } catch {
        $layout = $null
    }

    $active = $null -ne $layout
    if ($active -ne $script:dualScreenActive) {
        $script:dualScreenActive = $active
        if ($active) {
            Write-WatchdogLog (
                "Second screen detected: player on " +
                "$($layout.Projector.Left),$($layout.Projector.Top) " +
                "$($layout.Projector.Width)x$($layout.Projector.Height); monitor view on " +
                "$($layout.Monitor.Left),$($layout.Monitor.Top) " +
                "$($layout.Monitor.Width)x$($layout.Monitor.Height)."
            )
        } else {
            Write-WatchdogLog 'Single screen: monitor view disabled.'
        }
    }
    return $layout
}

function Set-ChromeOnDisplay([object[]]$ChromeRoots, [object]$Display, [string]$Label) {
    $windowHandle = Get-KioskWindowHandle $ChromeRoots
    if ($windowHandle -eq [IntPtr]::Zero) {
        return
    }
    if ([ModenPlayer.Displays]::IsWindowOn($windowHandle, $Display)) {
        $script:screenMoveAttempts[$Label] = 0
        return
    }
    $moved = [ModenPlayer.Displays]::MoveWindowTo($windowHandle, $Display)
    $attempts = 1 + [int]$script:screenMoveAttempts[$Label]
    $script:screenMoveAttempts[$Label] = $attempts
    if ($attempts -eq 1 -or $attempts % 30 -eq 0) {
        Write-WatchdogLog (
            "$Label moved to the display at $($Display.Left),$($Display.Top) " +
            "(attempt $attempts, accepted=$moved)."
        )
    }
}

function Start-MonitorView([string]$ChromeExecutable, [object]$Display) {
    New-Item -Path $monitorProfile -ItemType Directory -Force | Out-Null
    New-Item -Path $monitorCache -ItemType Directory -Force | Out-Null

    $arguments = @(
        '--kiosk',
        "--window-position=$($Display.Left),$($Display.Top)",
        '--noerrdialogs',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-session-crashed-bubble',
        '--disable-features=TranslateUI,CalculateNativeWinOcclusion,SigninInterception',
        '--disable-pinch',
        '--overscroll-history-navigation=0',
        '--profile-directory=Default',
        "--user-data-dir=$monitorProfile",
        "--disk-cache-dir=$monitorCache",
        '--disk-cache-size=67108864',
        $monitorUrl
    )
    Start-Process -FilePath $ChromeExecutable -ArgumentList $arguments
    Write-WatchdogLog 'Monitor view started on the main display.'
}

# Only called with two displays. Keeps the player on the projector and the
# read-only mirror on the monitor. If somebody closes the mirror to use the
# mini-PC, it stays closed for $monitorReopenMinutes.
function Repair-MonitorView(
    [string]$ChromeExecutable,
    [hashtable]$Layout,
    [object[]]$KioskRoots,
    [object[]]$MonitorRoots,
    [bool]$PlayerWasMissing
) {
    Set-ChromeOnDisplay $KioskRoots $Layout.Projector 'Player'

    if ($MonitorRoots.Count -gt 0) {
        $script:monitorWasRunning = $true
        Set-ChromeOnDisplay $MonitorRoots $Layout.Monitor 'Monitor view'
        return
    }

    if ($script:monitorWasRunning -and $PlayerWasMissing) {
        # Every Chrome disappeared at once (crash, update, taskkill): that is
        # not somebody closing the monitor view, so bring it straight back.
        $script:monitorWasRunning = $false
    }
    if ($script:monitorWasRunning) {
        $script:monitorWasRunning = $false
        $script:monitorReopenAfter = (Get-Date).AddMinutes($monitorReopenMinutes)
        Write-WatchdogLog "Monitor view was closed; reopening it in $monitorReopenMinutes minutes."
        return
    }
    if ((Get-Date) -lt $script:monitorReopenAfter) {
        return
    }
    Start-MonitorView $ChromeExecutable $Layout.Monitor
}

function Start-Kiosk([string]$ChromeExecutable, [object]$Display = $null) {
    New-Item -Path $kioskProfile -ItemType Directory -Force | Out-Null
    New-Item -Path $kioskCache -ItemType Directory -Force | Out-Null

    $arguments = @(
        '--kiosk',
        '--noerrdialogs',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-session-crashed-bubble',
        '--disable-features=TranslateUI,CalculateNativeWinOcclusion,SigninInterception',
        '--disable-pinch',
        '--overscroll-history-navigation=0',
        '--profile-directory=Default',
        "--user-data-dir=$kioskProfile",
        "--disk-cache-dir=$kioskCache",
        '--disk-cache-size=268435456',
        '--media-cache-size=134217728',
        $playerUrl
    )
    if ($Display) {
        # Two displays: open straight on the projector.
        $arguments = @("--window-position=$($Display.Left),$($Display.Top)") + $arguments
    }
    Start-Process -FilePath $ChromeExecutable -ArgumentList $arguments
    Write-WatchdogLog 'Chrome kiosk started with the isolated MODEN profile.'
}

function Repair-Kiosk {
    if (Test-PlayerPause) {
        # Q closed every Chrome on purpose: not a "monitor view was closed".
        $script:monitorWasRunning = $false
        return
    }

    $chrome = Get-ChromeExecutable
    if (-not $chrome) {
        Write-WatchdogLog 'Chrome executable was not found.'
        return
    }

    # $null with a single display: everything below then runs as it always has.
    $layout = Get-DualScreenLayout
    $projector = $null
    if ($layout) {
        $projector = $layout.Projector
    }

    $profilePattern = [regex]::Escape($kioskProfile)
    $monitorPattern = [regex]::Escape($monitorProfile)
    $roots = @(Get-RootChromeProcesses)
    $kioskRoots = @($roots | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $profilePattern
    })
    $monitorRoots = @()
    if ($layout) {
        $monitorRoots = @($roots | Where-Object {
            $_.CommandLine -and $_.CommandLine -match $monitorPattern
        })
    }
    # With a single display the monitor view is one more stray Chrome, so
    # unplugging the second screen closes it on the next check.
    $strayRoots = @($roots | Where-Object {
        (-not $_.CommandLine -or $_.CommandLine -notmatch $profilePattern) -and
        -not ($layout -and $_.CommandLine -and $_.CommandLine -match $monitorPattern)
    })

    foreach ($process in $strayRoots) {
        Write-WatchdogLog "Closing stray Chrome process $($process.ProcessId)."
        Stop-ChromeTree $process.ProcessId
    }

    $playerWasMissing = $kioskRoots.Count -eq 0
    if ($kioskRoots.Count -eq 0) {
        if ($strayRoots.Count -gt 0) {
            Start-Sleep -Seconds 1
        }
        Start-Kiosk $chrome $projector
        Start-Sleep -Seconds 2
        $roots = @(Get-RootChromeProcesses)
        $kioskRoots = @($roots | Where-Object {
            $_.CommandLine -and $_.CommandLine -match $profilePattern
        })
    }

    if ($layout) {
        try {
            Repair-MonitorView $chrome $layout $kioskRoots $monitorRoots $playerWasMissing
        } catch {
            Write-WatchdogLog "Monitor view check failed: $($_.Exception.Message)"
        }
        if ((Get-Date) -lt $script:monitorReopenAfter) {
            # Somebody closed the monitor view to use the mini-PC: do not pull
            # the keyboard back to the player until the view returns.
            return
        }
    }

    Repair-KioskFocus $kioskRoots
}

function Invoke-PlayerCheck {
    if (Test-PlayerMaintenance) {
        return
    }
    $now = Get-Date
    if (($now - $script:lastCaptureHealthCheck).TotalSeconds -ge 30) {
        $script:lastCaptureHealthCheck = $now
        Repair-CaptureService
    }
    Repair-Kiosk
}

if ($Resume) {
    Remove-Item -LiteralPath $pauseMarker -Force -ErrorAction SilentlyContinue
}

$mutex = [System.Threading.Mutex]::new($false, 'Local\MODENPlayerWatchdog')
$ownsMutex = $false
try {
    try {
        $ownsMutex = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        exit 0
    }

    do {
        try {
            Invoke-PlayerCheck
        } catch {
            Write-WatchdogLog "Recovery check failed: $($_.Exception.Message)"
        }
        if (-not $Once) {
            Start-Sleep -Seconds ([Math]::Max(5, $IntervalSeconds))
        }
    } while (-not $Once)
} finally {
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
