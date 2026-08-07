<#
.SYNOPSIS
  Nightly self-updater for deployed MODEN mini-PCs.

.DESCRIPTION
  Compares C:\moden\capture_service\VERSION with capture_service/VERSION on
  the GitHub deploy branch. It downloads a complete branch snapshot only when
  a new version exists, then stops the local player, preserves local
  config/token, applies the update, and starts the player again.

  UpdateSource can still point to a local folder for transition or recovery.

  The script is intentionally quiet when there is nothing to update.
#>
[CmdletBinding()]
param(
    [string]$UpdateSource = '',
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$GitHubRepository = 'LeyanisModen/Projection_Platform',
    [ValidatePattern('^[A-Za-z0-9._/-]+$')]
    [string]$GitHubBranch = 'deploy',
    [string]$LocalDir = 'C:\moden\capture_service',
    [int]$AllowedStartHour = 2,
    [int]$AllowedEndHour = 5,
    [switch]$Force,
    [switch]$AllowDowngrade,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

function Write-UpdateLog([string]$Message) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "$timestamp $Message"
    try {
        $logDir = Join-Path $LocalDir 'logs'
        if (-not (Test-Path $logDir)) {
            New-Item -Path $logDir -ItemType Directory -Force | Out-Null
        }
        Add-Content -Path (Join-Path $logDir 'auto-update.log') -Value $line -Encoding UTF8
    } catch {
        # Do not fail the update just because logging failed.
    }
    Write-Host $line
}

function Read-Version([string]$Dir) {
    $path = Join-Path $Dir 'VERSION'
    if (-not (Test-Path $path)) { return '' }
    return (Get-Content $path -Raw).Trim()
}

function Compare-CaptureVersion([string]$Left, [string]$Right) {
    $pattern = '^(\d{4})-(\d{2})-(\d{2})\.(\d+)$'
    $leftMatch = [regex]::Match($Left, $pattern)
    $rightMatch = [regex]::Match($Right, $pattern)
    if (-not $leftMatch.Success -or -not $rightMatch.Success) {
        return $null
    }

    try {
        $leftDate = [datetime]::new(
            [int]$leftMatch.Groups[1].Value,
            [int]$leftMatch.Groups[2].Value,
            [int]$leftMatch.Groups[3].Value
        )
        $rightDate = [datetime]::new(
            [int]$rightMatch.Groups[1].Value,
            [int]$rightMatch.Groups[2].Value,
            [int]$rightMatch.Groups[3].Value
        )
    } catch {
        return $null
    }

    $dateComparison = [datetime]::Compare($leftDate, $rightDate)
    if ($dateComparison -ne 0) {
        return $dateComparison
    }

    return ([int]$leftMatch.Groups[4].Value).CompareTo(
        [int]$rightMatch.Groups[4].Value
    )
}

function Invoke-HttpDownload([string]$Url, [string]$Destination) {
    & curl.exe `
        --fail `
        --location `
        --silent `
        --show-error `
        --retry 3 `
        --retry-delay 2 `
        --connect-timeout 15 `
        --max-time 300 `
        $Url `
        --output $Destination
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed with code ${LASTEXITCODE}: $Url"
    }
    if (
        -not (Test-Path -LiteralPath $Destination) -or
        (Get-Item -LiteralPath $Destination).Length -eq 0
    ) {
        throw "Downloaded file is empty: $Url"
    }
}

function New-GitHubUpdateSource([string]$TemporaryRoot) {
    $archivePath = Join-Path $TemporaryRoot 'deploy.zip'
    $extractPath = Join-Path $TemporaryRoot 'expanded'
    $archiveUrl = (
        "https://github.com/$GitHubRepository/archive/refs/heads/" +
        "$GitHubBranch.zip"
    )

    Invoke-HttpDownload $archiveUrl $archivePath
    New-Item -Path $extractPath -ItemType Directory -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force

    $repositoryRoot = Get-ChildItem -LiteralPath $extractPath -Directory |
        Select-Object -First 1
    if ($null -eq $repositoryRoot) {
        throw 'GitHub archive did not contain a repository directory.'
    }

    $source = Join-Path $repositoryRoot.FullName 'capture_service'
    if (-not (Test-Path -LiteralPath $source)) {
        throw 'GitHub archive did not contain capture_service.'
    }
    return $source
}

function Remove-TemporaryUpdateRoot([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path $Path)) {
        return
    }

    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (
        -not $fullPath.StartsWith(
            $tempRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        (Split-Path $fullPath -Leaf) -notlike 'moden-capture-update-*'
    ) {
        throw "Refusing to remove unexpected temporary path: $fullPath"
    }
    Remove-Item -LiteralPath $fullPath -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-RelativePath([string]$BaseDir, [string]$Path) {
    $base = [System.IO.Path]::GetFullPath($BaseDir).TrimEnd('\')
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.Substring($base.Length).TrimStart('\')
}

function Test-IncludedUpdateFile([string]$RelativePath) {
    $parts = $RelativePath -split '[\\/]'
    foreach ($part in $parts) {
        if ($part -in @('venv', '__pycache__', 'logs')) {
            return $false
        }
    }

    $name = Split-Path $RelativePath -Leaf
    if (
        $name -like 'config.ini.corrupt-*.bak' -or
        $name -like 'config.ini.repair-*.tmp'
    ) {
        return $false
    }
    if ($name -in @(
        'config.ini',
        'device_token.txt',
        '.last_update_source.txt',
        '.drive_maintenance',
        '.player_maintenance',
        '.player_pause'
    )) {
        return $false
    }

    return $true
}

function Get-IncludedUpdateFiles([string]$Dir) {
    $root = Get-Item -LiteralPath $Dir -Force
    $pending = [System.Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
    $pending.Push($root)

    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        foreach ($file in Get-ChildItem -LiteralPath $current.FullName -File -Force) {
            $rel = Get-RelativePath $Dir $file.FullName
            if (Test-IncludedUpdateFile $rel) {
                [PSCustomObject]@{
                    RelativePath = $rel
                    FullName = $file.FullName
                }
            }
        }

        foreach ($child in Get-ChildItem -LiteralPath $current.FullName -Directory -Force) {
            if ($child.Name -notin @('venv', '__pycache__', 'logs')) {
                $pending.Push($child)
            }
        }
    }
}

function Get-TreeFingerprint([string]$Dir) {
    if (-not (Test-Path $Dir)) { return '' }

    $files = @(Get-IncludedUpdateFiles $Dir | Sort-Object RelativePath)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        foreach ($file in $files) {
            $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
            $line = [System.Text.Encoding]::UTF8.GetBytes(
                "$($file.RelativePath)|$hash`n"
            )
            [void]$sha.TransformBlock($line, 0, $line.Length, $line, 0)
        }
        $empty = [byte[]]::new(0)
        [void]$sha.TransformFinalBlock($empty, 0, 0)
        return ([BitConverter]::ToString($sha.Hash)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Test-AllowedWindow {
    if ($Force) { return $true }
    if ($AllowedStartHour -eq $AllowedEndHour) { return $true }

    $hour = (Get-Date).Hour
    if ($AllowedStartHour -lt $AllowedEndHour) {
        return ($hour -ge $AllowedStartHour -and $hour -lt $AllowedEndHour)
    }
    return ($hour -ge $AllowedStartHour -or $hour -lt $AllowedEndHour)
}

function Start-GoogleDriveForMaintenance {
    if (Get-Process -Name GoogleDriveFS -ErrorAction SilentlyContinue) {
        return
    }

    $candidates = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    foreach ($root in @(
        (Join-Path $env:ProgramFiles 'Google\Drive File Stream'),
        (Join-Path $env:LOCALAPPDATA 'Google\DriveFS')
    )) {
        if (-not [string]::IsNullOrWhiteSpace($root) -and (Test-Path $root)) {
            Get-ChildItem -Path $root -Filter 'GoogleDriveFS.exe' -File -Recurse `
                -ErrorAction SilentlyContinue | ForEach-Object { [void]$candidates.Add($_) }
        }
    }

    $executable = $candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($null -eq $executable) {
        throw 'GoogleDriveFS.exe not found; cannot access the daytime update source.'
    }
    Start-Process -FilePath $executable.FullName -WindowStyle Hidden
}

function Set-IniValues([string]$Path, [object[]]$Updates) {
    $configInfo = Get-Item -LiteralPath $Path
    if ($configInfo.Length -gt 1048576) {
        throw "config.ini is too large ($($configInfo.Length) bytes); repair is required."
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path $Path) {
        foreach ($line in Get-Content $Path) {
            [void]$lines.Add($line)
        }
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
        } else {
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
    }

    [System.IO.File]::WriteAllText(
        $Path,
        ($lines -join [Environment]::NewLine) + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Register-PlayerWatchdogTask {
    $watchdog = Join-Path $LocalDir 'player-watchdog.ps1'
    if (-not (Test-Path $watchdog)) {
        throw 'player-watchdog.ps1 is missing; cannot register MODEN Player.'
    }

    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`" -Root `"$LocalDir`""
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

$driveMaintenanceMarker = Join-Path $LocalDir '.drive_maintenance'
$maintenanceRequested = $false
$playerMaintenanceMarker = Join-Path $LocalDir '.player_maintenance'
$playerPauseMarker = Join-Path $LocalDir '.player_pause'
$playerMaintenanceRequested = $false
$playerRestartPending = $false
$temporaryUpdateRoot = ''
$usingGitHub = [string]::IsNullOrWhiteSpace($UpdateSource)
$sourceLabel = $UpdateSource

try {
    if ($usingGitHub) {
        $sourceLabel = "GitHub $GitHubRepository@$GitHubBranch"
        $temporaryUpdateRoot = Join-Path $env:TEMP (
            'moden-capture-update-{0}-{1}' -f $PID, (Get-Date -Format 'yyyyMMddHHmmss')
        )
        New-Item -Path $temporaryUpdateRoot -ItemType Directory -Force | Out-Null

        $remoteVersionPath = Join-Path $temporaryUpdateRoot 'VERSION'
        $remoteVersionUrl = (
            "https://raw.githubusercontent.com/$GitHubRepository/" +
            "$GitHubBranch/capture_service/VERSION"
        )
        Write-UpdateLog "Checking updates from $sourceLabel"
        Invoke-HttpDownload $remoteVersionUrl $remoteVersionPath

        $remoteVersion = Read-Version $temporaryUpdateRoot
        $currentVersion = Read-Version $LocalDir
        if ([string]::IsNullOrWhiteSpace($remoteVersion)) {
            Write-UpdateLog 'GitHub VERSION is empty; skipping.'
            exit 0
        }

        if (-not $AllowDowngrade -and -not [string]::IsNullOrWhiteSpace($currentVersion)) {
            $versionComparison = Compare-CaptureVersion $remoteVersion $currentVersion
            if ($null -ne $versionComparison -and $versionComparison -lt 0) {
                Write-UpdateLog "GitHub version $remoteVersion is older than local $currentVersion; refusing downgrade."
                exit 0
            }
        }

        if (-not $Force -and $remoteVersion -eq $currentVersion) {
            Write-UpdateLog "Already up to date ($currentVersion)."
            exit 0
        }
        if (-not (Test-AllowedWindow)) {
            Write-UpdateLog "Update $currentVersion -> $remoteVersion pending, but outside allowed window $AllowedStartHour-$AllowedEndHour."
            exit 0
        }

        Write-UpdateLog "Downloading $sourceLabel snapshot."
        $UpdateSource = New-GitHubUpdateSource $temporaryUpdateRoot
    } elseif ($Force) {
        if (-not (Test-Path $LocalDir)) {
            New-Item -Path $LocalDir -ItemType Directory -Force | Out-Null
        }
        Set-Content -Path $driveMaintenanceMarker -Value (Get-Date -Format o) -Encoding ASCII
        $maintenanceRequested = $true
        Start-GoogleDriveForMaintenance

        $driveDeadline = (Get-Date).AddSeconds(90)
        while (-not (Test-Path $UpdateSource) -and (Get-Date) -lt $driveDeadline) {
            Start-Sleep -Seconds 2
        }
    }

    if (-not $usingGitHub) {
        Write-UpdateLog "Checking updates from '$UpdateSource'"
    }

    if (-not (Test-Path $UpdateSource)) {
        Write-UpdateLog 'Update source is not available; skipping.'
        exit 0
    }

    foreach ($required in @(
        'VERSION',
        'capture_service.py',
        'config.ini.example',
        'player-watchdog.ps1',
        'repair-config.ps1',
        'start-player.bat',
        'requirements.txt'
    )) {
        if (-not (Test-Path (Join-Path $UpdateSource $required))) {
            Write-UpdateLog "Update source is incomplete: missing $required; skipping."
            exit 0
        }
    }

    $sourceVersion = Read-Version $UpdateSource
    $localVersion = Read-Version $LocalDir
    $sourceFingerprint = Get-TreeFingerprint $UpdateSource
    $localFingerprint = if ($Force) { '' } else { Get-TreeFingerprint $LocalDir }

    if ([string]::IsNullOrWhiteSpace($sourceVersion)) {
        Write-UpdateLog 'Source VERSION is empty; skipping.'
        exit 0
    }

    if (-not $AllowDowngrade -and -not [string]::IsNullOrWhiteSpace($localVersion)) {
        $versionComparison = Compare-CaptureVersion $sourceVersion $localVersion
        if ($null -ne $versionComparison -and $versionComparison -lt 0) {
            Write-UpdateLog "Source version $sourceVersion is older than local $localVersion; refusing downgrade."
            exit 0
        }
    }

    if (-not $Force -and $sourceFingerprint -eq $localFingerprint) {
        Write-UpdateLog "Already up to date ($localVersion, $($localFingerprint.Substring(0, 8)))."
        exit 0
    }

    if (-not (Test-AllowedWindow)) {
        Write-UpdateLog "Update $localVersion -> $sourceVersion pending, but outside allowed window $AllowedStartHour-$AllowedEndHour."
        exit 0
    }

    if (-not $usingGitHub) {
        Start-Sleep -Seconds 3
        $sourceVersionAfterWait = Read-Version $UpdateSource
        $sourceFingerprintAfterWait = Get-TreeFingerprint $UpdateSource
        if ($sourceVersionAfterWait -ne $sourceVersion -or $sourceFingerprintAfterWait -ne $sourceFingerprint) {
            Write-UpdateLog 'Source changed while checking; Drive may still be syncing. Skipping this run.'
            exit 0
        }
    }

    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()

    if ($localVersion -eq $sourceVersion) {
        Write-UpdateLog "Repairing installation $sourceVersion"
    } else {
        Write-UpdateLog "Updating $localVersion -> $sourceVersion"
    }

    Set-Content -Path $playerMaintenanceMarker `
        -Value (Get-Date -Format o) -Encoding ASCII
    $playerMaintenanceRequested = $true
    $playerRestartPending = -not $NoRestart

    Stop-ScheduledTask -TaskName 'MODEN Player' -ErrorAction SilentlyContinue
    Stop-PlayerWatchdogs
    Get-Process -Name python, pythonw, chrome -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue

    $sourceRequirements = Join-Path $UpdateSource 'requirements.txt'
    $localRequirements = Join-Path $LocalDir 'requirements.txt'
    $requirementsChanged = -not (Test-Path $localRequirements)
    if (-not $requirementsChanged) {
        $requirementsChanged = (
            (Get-FileHash $sourceRequirements -Algorithm SHA256).Hash -ne
            (Get-FileHash $localRequirements -Algorithm SHA256).Hash
        )
    }

    & robocopy $UpdateSource $LocalDir /MIR /XD venv __pycache__ logs /XF config.ini 'config.ini.corrupt-*.bak' 'config.ini.repair-*.tmp' device_token.txt .drive_maintenance .player_maintenance .player_pause /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with code $LASTEXITCODE"
    }

    $venvPython = Join-Path $LocalDir 'venv\Scripts\python.exe'
    $requirements = Join-Path $LocalDir 'requirements.txt'
    if ((Test-Path $venvPython) -and (Test-Path $requirements)) {
        & $venvPython -c 'import cv2' 2>$null
        $dependenciesHealthy = $LASTEXITCODE -eq 0
        if ($requirementsChanged -or -not $dependenciesHealthy) {
            & $venvPython -m pip install --disable-pip-version-check `
                --no-cache-dir -r $requirements --quiet
            if ($LASTEXITCODE -ne 0) {
                Write-UpdateLog "pip install returned code $LASTEXITCODE; continuing with copied files."
            }
        } else {
            Write-UpdateLog 'Python dependencies unchanged; skipping pip install.'
        }
    } else {
        Write-UpdateLog 'venv or requirements.txt not found; skipping pip install.'
    }

    Register-PlayerWatchdogTask

    $configPath = Join-Path $LocalDir 'config.ini'
    if (Test-Path $configPath) {
        if ((Get-Item -LiteralPath $configPath).Length -gt 1048576) {
            $repairScript = Join-Path $LocalDir 'repair-config.ps1'
            Write-UpdateLog 'Oversized config.ini detected; rebuilding it safely.'
            & powershell.exe -NoProfile -ExecutionPolicy Bypass `
                -File $repairScript -LocalDir $LocalDir
            if ($LASTEXITCODE -ne 0) {
                throw "config.ini repair failed with code $LASTEXITCODE"
            }
        }

        $safeConfigUpdates = @(
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
        Set-IniValues $configPath $safeConfigUpdates
    }

    [System.IO.File]::WriteAllText(
        (Join-Path $LocalDir '.last_update_source.txt'),
        "$sourceLabel`r`n$sourceVersion`r`n$(Get-Date -Format o)`r`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    Remove-Item -LiteralPath $playerMaintenanceMarker -Force -ErrorAction SilentlyContinue
    $playerMaintenanceRequested = $false

    if (-not $NoRestart) {
        Remove-Item -LiteralPath $playerPauseMarker -Force -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName 'MODEN Player'
    }
    $playerRestartPending = $false

    Write-UpdateLog "Update complete ($sourceVersion)."
    exit 0
} catch {
    $errorLine = $_.InvocationInfo.ScriptLineNumber
    Write-UpdateLog "ERROR at line ${errorLine}: $($_.Exception.Message)"
    exit 1
} finally {
    if ($playerMaintenanceRequested) {
        Remove-Item -LiteralPath $playerMaintenanceMarker -Force -ErrorAction SilentlyContinue
    }
    if ($playerRestartPending) {
        try {
            Start-ScheduledTask -TaskName 'MODEN Player' -ErrorAction Stop
        } catch {
            $fallback = Join-Path $LocalDir 'start-player.bat'
            if (Test-Path $fallback) {
                Start-Process $fallback
            }
        }
    }
    if ($maintenanceRequested) {
        Remove-Item -LiteralPath $driveMaintenanceMarker -Force -ErrorAction SilentlyContinue
    }
    Remove-TemporaryUpdateRoot $temporaryUpdateRoot
}
