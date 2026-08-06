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

function Find-MesaIdInFile([string]$Path, [int]$BlockBytes = 1048576) {
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )
    try {
        $buffer = [byte[]]::new($BlockBytes)
        $overlap = ''
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $text = $overlap + [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
            if ($text -match '(?im)^\s*mesa_id\s*=\s*([A-Za-z0-9_.-]+)\s*$') {
                return $Matches[1]
            }
            $overlapLength = [Math]::Min(4096, $text.Length)
            $overlap = $text.Substring($text.Length - $overlapLength)
        }
    } finally {
        $stream.Dispose()
    }
    return ''
}

function Infer-MesaId([string]$LocalPath) {
    if ($env:COMPUTERNAME -match '(?i)^(?<client>[A-Z0-9]+)-G(?<group>\d+)-MESA(?<mesa>\d+)$') {
        return ('{0}_g{1}_mesa{2}' -f
            $Matches.client.ToLowerInvariant(),
            $Matches.group,
            $Matches.mesa
        )
    }

    $bufferRoot = 'C:\moden\capture_buffer'
    if (Test-Path -LiteralPath $bufferRoot) {
        $candidates = @(
            Get-ChildItem -LiteralPath $bufferRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '(?i)^[A-Z0-9]+_g\d+_mesa\d+$' } |
                Select-Object -ExpandProperty Name -Unique
        )
        if ($candidates.Count -eq 1) {
            return $candidates[0]
        }
    }

    return ''
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
    Write-Host 'mesa_id was not found in the initial config block; scanning safely.'
    $recoveredMesaId = Find-MesaIdInFile $configPath
    if ([string]::IsNullOrWhiteSpace($recoveredMesaId)) {
        $recoveredMesaId = Infer-MesaId $LocalDir
        if (-not [string]::IsNullOrWhiteSpace($recoveredMesaId)) {
            Write-Host "mesa_id inferred from this mini-PC: $recoveredMesaId"
        }
    }
    if ([string]::IsNullOrWhiteSpace($recoveredMesaId)) {
        throw 'Could not recover or infer documentation.mesa_id; original config was left untouched.'
    }
    $recovered[$mesaKey] = $recoveredMesaId
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
