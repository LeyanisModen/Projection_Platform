<#
.SYNOPSIS
  Nightly self-updater for deployed MODEN mini-PCs.

.DESCRIPTION
  Compares C:\moden\capture_service\VERSION with the version published in
  Google Drive (default: G:\Mi unidad\MODEN_UPDATE\capture_service). If the
  Drive version is newer/different, it stops the local player, mirrors the
  folder while preserving local config/token, reapplies safe config defaults,
  and starts the player again.

  The script is intentionally quiet when there is nothing to update.
#>
[CmdletBinding()]
param(
    [string]$UpdateSource = 'G:\Mi unidad\MODEN_UPDATE\capture_service',
    [string]$LocalDir = 'C:\moden\capture_service',
    [int]$AllowedStartHour = 2,
    [int]$AllowedEndHour = 5,
    [switch]$Force,
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

function Get-RelativePath([string]$BaseDir, [string]$Path) {
    $base = [System.IO.Path]::GetFullPath($BaseDir).TrimEnd('\')
    $full = [System.IO.Path]::GetFullPath($Path)
    return $full.Substring($base.Length).TrimStart('\')
}

function Test-IncludedUpdateFile([string]$RelativePath) {
    $parts = $RelativePath -split '[\\/]'
    if ($parts.Count -gt 0 -and $parts[0] -in @('venv', '__pycache__', 'logs')) {
        return $false
    }

    $name = Split-Path $RelativePath -Leaf
    if ($name -in @('config.ini', 'device_token.txt', '.last_update_source.txt')) {
        return $false
    }

    return $true
}

function Get-TreeFingerprint([string]$Dir) {
    if (-not (Test-Path $Dir)) { return '' }

    $lines = [System.Collections.Generic.List[string]]::new()
    $files = Get-ChildItem $Dir -Recurse -File -Force |
        ForEach-Object {
            $rel = Get-RelativePath $Dir $_.FullName
            if (Test-IncludedUpdateFile $rel) {
                [PSCustomObject]@{ RelativePath = $rel; FullName = $_.FullName }
            }
        } |
        Sort-Object RelativePath

    foreach ($file in $files) {
        $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
        [void]$lines.Add("$($file.RelativePath)|$hash")
    }

    $payload = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($payload))).Replace('-', '')
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

function Set-IniValue([string]$Path, [string]$Section, [string]$Key, [string]$Value) {
    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path $Path) {
        foreach ($line in Get-Content $Path) {
            [void]$lines.Add($line)
        }
    }

    $sectionIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim().ToLowerInvariant() -eq "[$($Section.ToLowerInvariant())]") {
            $sectionIndex = $i
            break
        }
    }

    if ($sectionIndex -lt 0) {
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -ne '') {
            [void]$lines.Add('')
        }
        [void]$lines.Add("[$Section]")
        [void]$lines.Add("$Key = $Value")
    } else {
        $insertIndex = $sectionIndex + 1
        $keyIndex = -1
        for ($i = $sectionIndex + 1; $i -lt $lines.Count; $i++) {
            if ($lines[$i].TrimStart().StartsWith('[')) {
                break
            }
            $insertIndex = $i + 1
            if ($lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") {
                $keyIndex = $i
                break
            }
        }

        if ($keyIndex -ge 0) {
            $lines[$keyIndex] = "$Key = $Value"
        } else {
            $lines.Insert($insertIndex, "$Key = $Value")
        }
    }

    [System.IO.File]::WriteAllText(
        $Path,
        ($lines -join [Environment]::NewLine) + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

try {
    Write-UpdateLog "Checking updates from '$UpdateSource'"

    if (-not (Test-Path $UpdateSource)) {
        Write-UpdateLog 'Update source is not available; skipping.'
        exit 0
    }

    foreach ($required in @('VERSION', 'capture_service.py', 'start-player.bat', 'requirements.txt')) {
        if (-not (Test-Path (Join-Path $UpdateSource $required))) {
            Write-UpdateLog "Update source is incomplete: missing $required; skipping."
            exit 0
        }
    }

    $sourceVersion = Read-Version $UpdateSource
    $localVersion = Read-Version $LocalDir
    $sourceFingerprint = Get-TreeFingerprint $UpdateSource
    $localFingerprint = Get-TreeFingerprint $LocalDir

    if ([string]::IsNullOrWhiteSpace($sourceVersion)) {
        Write-UpdateLog 'Source VERSION is empty; skipping.'
        exit 0
    }

    if (-not $Force -and $sourceFingerprint -eq $localFingerprint) {
        Write-UpdateLog "Already up to date ($localVersion, $($localFingerprint.Substring(0, 8)))."
        exit 0
    }

    if (-not (Test-AllowedWindow)) {
        Write-UpdateLog "Update $localVersion -> $sourceVersion pending, but outside allowed window $AllowedStartHour-$AllowedEndHour."
        exit 0
    }

    Start-Sleep -Seconds 3
    $sourceVersionAfterWait = Read-Version $UpdateSource
    $sourceFingerprintAfterWait = Get-TreeFingerprint $UpdateSource
    if ($sourceVersionAfterWait -ne $sourceVersion -or $sourceFingerprintAfterWait -ne $sourceFingerprint) {
        Write-UpdateLog 'Source changed while checking; Drive may still be syncing. Skipping this run.'
        exit 0
    }

    Write-UpdateLog "Updating $localVersion -> $sourceVersion"

    Get-Process -Name python, pythonw, chrome -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue

    & robocopy $UpdateSource $LocalDir /MIR /XD venv __pycache__ logs /XF config.ini device_token.txt /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed with code $LASTEXITCODE"
    }

    $venvPython = Join-Path $LocalDir 'venv\Scripts\python.exe'
    $requirements = Join-Path $LocalDir 'requirements.txt'
    if ((Test-Path $venvPython) -and (Test-Path $requirements)) {
        & $venvPython -m pip install -r $requirements --quiet
        if ($LASTEXITCODE -ne 0) {
            Write-UpdateLog "pip install returned code $LASTEXITCODE; continuing with copied files."
        }
    } else {
        Write-UpdateLog 'venv or requirements.txt not found; skipping pip install.'
    }

    $configPath = Join-Path $LocalDir 'config.ini'
    if (Test-Path $configPath) {
        Set-IniValue $configPath 'sharpness' 'threshold_blurry' '2'
        Set-IniValue $configPath 'sharpness' 'threshold_warning' '10'
        Set-IniValue $configPath 'sharpness' 'min_brightness' '18'
        Set-IniValue $configPath 'sharpness' 'min_contrast' '8'
        Set-IniValue $configPath 'sharpness' 'retry_minutes' '15'
    }

    [System.IO.File]::WriteAllText(
        (Join-Path $LocalDir '.last_update_source.txt'),
        "$UpdateSource`r`n$sourceVersion`r`n$(Get-Date -Format o)`r`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    if (-not $NoRestart) {
        Start-Process (Join-Path $LocalDir 'start-player.bat')
    }

    Write-UpdateLog "Update complete ($sourceVersion)."
    exit 0
} catch {
    Write-UpdateLog "ERROR: $($_.Exception.Message)"
    exit 1
}
