<#
.SYNOPSIS
  Repairs a deployed MODEN mini-PC from a known Git revision.

.DESCRIPTION
  Downloads the critical capture-service files directly from GitHub, repairs
  an oversized config.ini without loading it, registers the player and update
  tasks, and verifies the local service before reporting success.

  Run this script from an elevated Windows PowerShell console.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$MesaId,

    [ValidateSet(0, 90, 180, 270)]
    [int]$ImageRotation = 180,

    [ValidatePattern('^[A-Za-z0-9._/-]+$')]
    [string]$Revision = 'develop',

    [string]$Root = 'C:\moden\capture_service'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
}

function Stop-PlayerWatchdogs {
    foreach ($name in @('powershell.exe', 'pwsh.exe')) {
        Get-CimInstance Win32_Process -Filter "Name = '$name'" `
            -ErrorAction SilentlyContinue | Where-Object {
                $_.ProcessId -ne $PID -and
                $_.CommandLine -and
                $_.CommandLine -match '(?i)player-watchdog\.ps1'
            } | ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
    }
}

function Install-SourceFiles {
    $baseUrl = (
        'https://raw.githubusercontent.com/' +
        'LeyanisModen/Projection_Platform/' +
        "$Revision/capture_service"
    )
    $files = @(
        'VERSION',
        'capture_service.py',
        'config.ini.example',
        'player-watchdog.ps1',
        'repair-config.ps1',
        'start-player.bat',
        'update-capture-service.ps1',
        'requirements.txt'
    )

    foreach ($name in $files) {
        $tempPath = Join-Path $env:TEMP "moden-recovery-$PID-$name"
        try {
            & curl.exe --fail --location --silent --show-error `
                "$baseUrl/$name" --output $tempPath
            if ($LASTEXITCODE -ne 0) {
                throw "Download failed for $name with code $LASTEXITCODE."
            }
            if (-not (Test-Path $tempPath) -or (Get-Item $tempPath).Length -eq 0) {
                throw "Downloaded file is empty: $name"
            }
            Move-Item -LiteralPath $tempPath `
                -Destination (Join-Path $Root $name) -Force
        } finally {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Set-RequiredConfigValue(
    [string]$Content,
    [string]$Key,
    [string]$Value
) {
    $pattern = "(?m)^\s*$([regex]::Escape($Key))\s*=.*$"
    if (-not [regex]::IsMatch($Content, $pattern)) {
        throw "Required setting is missing from config.ini: $Key"
    }
    return [regex]::Replace($Content, $pattern, "$Key = $Value")
}

function Set-IniValues([string]$Path, [object[]]$Updates) {
    $configInfo = Get-Item -LiteralPath $Path
    if ($configInfo.Length -gt 1MB) {
        throw "config.ini is too large ($($configInfo.Length) bytes); repair is required."
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in Get-Content -LiteralPath $Path) {
        [void]$lines.Add($line)
    }

    foreach ($update in $Updates) {
        $section = [string]$update.Section
        $key = [string]$update.Key
        $value = [string]$update.Value
        $sectionIndex = -1

        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i].Trim().ToLowerInvariant() -eq "[$($section.ToLowerInvariant())]") {
                $sectionIndex = $i
                break
            }
        }

        if ($sectionIndex -lt 0) {
            if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -ne '') {
                [void]$lines.Add('')
            }
            [void]$lines.Add("[$section]")
            [void]$lines.Add("$key = $value")
            continue
        }

        $insertIndex = $sectionIndex + 1
        $keyIndex = -1
        for ($i = $sectionIndex + 1; $i -lt $lines.Count; $i++) {
            if ($lines[$i].TrimStart().StartsWith('[')) {
                break
            }
            $insertIndex = $i + 1
            if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") {
                $keyIndex = $i
                break
            }
        }

        if ($keyIndex -ge 0) {
            $lines[$keyIndex] = "$key = $value"
        } else {
            $lines.Insert($insertIndex, "$key = $value")
        }
    }

    [System.IO.File]::WriteAllText(
        $Path,
        ($lines -join [Environment]::NewLine) + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Set-CurrentConfigPolicy([string]$Path) {
    $updates = @(
        @{ Section = 'documentation'; Key = 'interval_seconds'; Value = '20' },
        @{ Section = 'documentation'; Key = 'active_start_hour'; Value = '6' },
        @{ Section = 'documentation'; Key = 'active_start_minute'; Value = '50' },
        @{ Section = 'documentation'; Key = 'active_end_hour'; Value = '15' },
        @{ Section = 'documentation'; Key = 'active_end_minute'; Value = '0' },
        @{ Section = 'documentation'; Key = 'max_local_gb'; Value = '30' },
        @{ Section = 'documentation'; Key = 'min_free_gb'; Value = '5' },
        @{ Section = 'documentation'; Key = 'local_retention_days'; Value = '7' },
        @{ Section = 'documentation'; Key = 'sync_interval_seconds'; Value = '1800' },
        @{ Section = 'documentation'; Key = 'sync_weekly_enabled'; Value = 'true' },
        @{ Section = 'documentation'; Key = 'sync_weekly_start_day'; Value = 'FRI' },
        @{ Section = 'documentation'; Key = 'sync_weekly_start_hour'; Value = '15' },
        @{ Section = 'documentation'; Key = 'sync_weekly_start_minute'; Value = '30' },
        @{ Section = 'documentation'; Key = 'sync_weekly_end_day'; Value = 'MON' },
        @{ Section = 'documentation'; Key = 'sync_weekly_end_hour'; Value = '5' },
        @{ Section = 'documentation'; Key = 'sync_weekly_end_minute'; Value = '0' },
        @{ Section = 'documentation'; Key = 'drive_guard_enabled'; Value = 'true' },
        @{ Section = 'documentation'; Key = 'drive_daily_enabled'; Value = 'false' },
        @{ Section = 'documentation'; Key = 'drive_start_hour'; Value = '3' },
        @{ Section = 'documentation'; Key = 'drive_start_minute'; Value = '45' },
        @{ Section = 'documentation'; Key = 'drive_stop_hour'; Value = '4' },
        @{ Section = 'documentation'; Key = 'drive_stop_minute'; Value = '45' },
        @{ Section = 'documentation'; Key = 'drive_weekend_enabled'; Value = 'true' },
        @{ Section = 'documentation'; Key = 'drive_weekend_start_day'; Value = 'FRI' },
        @{ Section = 'documentation'; Key = 'drive_weekend_start_hour'; Value = '15' },
        @{ Section = 'documentation'; Key = 'drive_weekend_start_minute'; Value = '15' },
        @{ Section = 'documentation'; Key = 'drive_weekend_end_day'; Value = 'MON' },
        @{ Section = 'documentation'; Key = 'drive_weekend_end_hour'; Value = '6' },
        @{ Section = 'documentation'; Key = 'drive_weekend_end_minute'; Value = '35' },
        @{ Section = 'documentation'; Key = 'drive_guard_interval_seconds'; Value = '30' },
        @{ Section = 'sharpness'; Key = 'threshold_blurry'; Value = '2' },
        @{ Section = 'sharpness'; Key = 'threshold_warning'; Value = '10' },
        @{ Section = 'sharpness'; Key = 'min_brightness'; Value = '18' },
        @{ Section = 'sharpness'; Key = 'min_contrast'; Value = '8' },
        @{ Section = 'sharpness'; Key = 'retry_minutes'; Value = '15' }
    )
    Set-IniValues -Path $Path -Updates $updates
}

function Repair-LocalConfig {
    $configPath = Join-Path $Root 'config.ini'
    $templatePath = Join-Path $Root 'config.ini.example'
    $backupPath = $null

    if (
        -not (Test-Path $configPath) -or
        (Get-Item -LiteralPath $configPath).Length -gt 1MB
    ) {
        if (Test-Path $configPath) {
            $backupPath = Join-Path $Root (
                'config.ini.corrupt-{0}.bak' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
            )
            Move-Item -LiteralPath $configPath -Destination $backupPath
        }
        Copy-Item -LiteralPath $templatePath -Destination $configPath
    }

    $content = [System.IO.File]::ReadAllText($configPath)
    $content = Set-RequiredConfigValue $content 'mesa_id' $MesaId
    $content = Set-RequiredConfigValue $content 'image_rotation' "$ImageRotation"
    [System.IO.File]::WriteAllText(
        $configPath,
        $content,
        [System.Text.UTF8Encoding]::new($false)
    )
    Set-CurrentConfigPolicy -Path $configPath

    return $backupPath
}

function Register-PlayerTask {
    $watchdog = Join-Path $Root 'player-watchdog.ps1'
    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument (
            "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass " +
            "-File `"$watchdog`" -Root `"$Root`""
        )
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User 'moden'
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'MODEN Player' `
        -Action $action -Trigger $trigger -Settings $settings `
        -RunLevel Limited -User 'moden' -Force | Out-Null
}

function Register-UpdateTask {
    $updateScript = Join-Path $Root 'update-capture-service.ps1'
    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$updateScript`""
    $trigger = New-ScheduledTaskTrigger -Daily -At '4:15am'
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal `
        -UserId 'moden' `
        -LogonType Interactive `
        -RunLevel Highest
    Register-ScheduledTask -TaskName 'MODEN Auto Update' `
        -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force | Out-Null
}

function Wait-CaptureService([int]$TimeoutSeconds = 35) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $health = Invoke-RestMethod `
                -Uri 'http://127.0.0.1:5555/health' `
                -TimeoutSec 3
            if ($health.status -eq 'ok') {
                return $true
            }
        } catch {
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $deadline)
    return $false
}

if (-not (Test-IsAdministrator)) {
    throw 'Access denied: open Windows PowerShell as Administrator and run again.'
}

Write-Host "Recovering MODEN mini-PC $MesaId from revision $Revision..."
New-Item -Path $Root -ItemType Directory -Force | Out-Null

Stop-ScheduledTask -TaskName 'MODEN Player' -ErrorAction SilentlyContinue
Stop-PlayerWatchdogs
Get-Process -Name python, pythonw, chrome -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

Install-SourceFiles
$backupPath = Repair-LocalConfig
Register-PlayerTask
Register-UpdateTask

foreach ($marker in @('.player_maintenance', '.player_pause', '.drive_maintenance')) {
    Remove-Item -LiteralPath (Join-Path $Root $marker) `
        -Force -ErrorAction SilentlyContinue
}

Start-ScheduledTask -TaskName 'MODEN Player'
if (-not (Wait-CaptureService)) {
    Write-Host '--- player-watchdog.log ---'
    Get-Content (Join-Path $Root 'logs\player-watchdog.log') `
        -Tail 20 -ErrorAction SilentlyContinue
    Write-Host '--- capture-service-error.log ---'
    Get-Content (Join-Path $Root 'logs\capture-service-error.log') `
        -Tail 20 -ErrorAction SilentlyContinue
    throw 'Capture service did not become healthy after recovery.'
}

$stats = Invoke-RestMethod -Uri 'http://127.0.0.1:5555/stats' -TimeoutSec 5
if ($stats.mesa_id -ne $MesaId -or [int]$stats.image_rotation -ne $ImageRotation) {
    throw "Service started with unexpected identity or rotation: $($stats | ConvertTo-Json -Compress)"
}

Write-Host "Recovery complete. VERSION=$(Get-Content (Join-Path $Root 'VERSION') -Raw)"
Write-Host "mesa_id=$($stats.mesa_id); image_rotation=$($stats.image_rotation); camera_available=$($stats.camera_available)"
if ($backupPath) {
    Write-Host "Damaged config retained temporarily at: $backupPath"
    Write-Host 'Delete it only after confirming the table works correctly.'
}
