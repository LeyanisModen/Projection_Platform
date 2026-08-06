<#
.SYNOPSIS
  Rebuilds a damaged MODEN capture-service config without loading it in memory.

.DESCRIPTION
  Reads only a bounded prefix of config.ini, recovers the first value found for
  every known setting, and overlays those values on config.ini.example. The
  damaged file is renamed in place so even a multi-gigabyte config is not copied.
#>
[CmdletBinding()]
param(
    [string]$LocalDir = 'C:\moden\capture_service',
    [int]$MaxPrefixBytes = 1048576,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$MaxHealthyConfigBytes = 1048576

function Read-FilePrefix([string]$Path, [int]$MaxBytes) {
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )
    try {
        $length = [int][Math]::Min([long]$MaxBytes, $stream.Length)
        $buffer = [byte[]]::new($length)
        $offset = 0
        while ($offset -lt $length) {
            $read = $stream.Read($buffer, $offset, $length - $offset)
            if ($read -le 0) { break }
            $offset += $read
        }
        return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $offset)
    } finally {
        $stream.Dispose()
    }
}

function Read-FirstIniValues([string]$Text) {
    $values = @{}
    $section = ''

    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*\[([A-Za-z0-9_.-]+)\]\s*$') {
            $section = $Matches[1].ToLowerInvariant()
            continue
        }
        if (
            $section -and
            $line.Length -le 4096 -and
            $line -match '^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$'
        ) {
            $key = $Matches[1].ToLowerInvariant()
            $value = $Matches[2]
            $id = "$section.$key"
            if (-not $values.ContainsKey($id) -and $value.Length -le 2048) {
                $values[$id] = $value
            }
        }
    }
    return $values
}

function Merge-IniTemplate([string]$TemplatePath, [hashtable]$Recovered) {
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in Get-Content -LiteralPath $TemplatePath) {
        [void]$lines.Add($line)
    }

    $section = ''
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match '^\s*\[([A-Za-z0-9_.-]+)\]\s*$') {
            $section = $Matches[1].ToLowerInvariant()
            continue
        }
        if ($section -and $line -match '^\s*([A-Za-z0-9_.-]+)\s*=') {
            $key = $Matches[1].ToLowerInvariant()
            $id = "$section.$key"
            if ($Recovered.ContainsKey($id)) {
                $lines[$i] = "$key = $($Recovered[$id])"
            }
        }
    }

    return ($lines -join [Environment]::NewLine) + [Environment]::NewLine
}

$configPath = Join-Path $LocalDir 'config.ini'
$templatePath = Join-Path $LocalDir 'config.ini.example'

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "config.ini not found at $configPath"
}
if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "config.ini.example not found at $templatePath"
}

$configInfo = Get-Item -LiteralPath $configPath
if (-not $Force -and $configInfo.Length -le $MaxHealthyConfigBytes) {
    Write-Host "Config size is healthy ($($configInfo.Length) bytes); no repair needed."
    exit 0
}

$prefix = Read-FilePrefix $configPath $MaxPrefixBytes
$recovered = Read-FirstIniValues $prefix
$mesaKey = 'documentation.mesa_id'
if (-not $recovered.ContainsKey($mesaKey)) {
    throw 'Could not recover documentation.mesa_id; original config was left untouched.'
}
if ($recovered[$mesaKey] -notmatch '^[A-Za-z0-9_.-]+$') {
    throw 'Recovered mesa_id is invalid; original config was left untouched.'
}

$cleanContent = Merge-IniTemplate $templatePath $recovered
$tempPath = Join-Path $LocalDir "config.ini.repair-$PID.tmp"
$backupPath = Join-Path $LocalDir (
    'config.ini.corrupt-{0}.bak' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
)

try {
    [System.IO.File]::WriteAllText(
        $tempPath,
        $cleanContent,
        [System.Text.UTF8Encoding]::new($false)
    )
    if ((Get-Item -LiteralPath $tempPath).Length -gt $MaxHealthyConfigBytes) {
        throw 'Generated config exceeds the safety limit.'
    }

    Move-Item -LiteralPath $configPath -Destination $backupPath
    try {
        Move-Item -LiteralPath $tempPath -Destination $configPath
    } catch {
        Move-Item -LiteralPath $backupPath -Destination $configPath
        throw
    }
} finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Config repaired for mesa_id=$($recovered[$mesaKey])."
Write-Host "Damaged file kept temporarily at: $backupPath"
Write-Host 'Delete that backup only after /health and /stats work correctly.'
