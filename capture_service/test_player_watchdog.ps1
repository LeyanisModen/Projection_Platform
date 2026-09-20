<#
  Decision-logic test for player-watchdog.ps1 (no Chrome is launched).
  Loads the watchdog functions without its main loop, replaces the pieces that
  touch the machine with recorders, and checks what Repair-Kiosk starts, closes
  and focuses with one and with two displays.

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File test_player_watchdog.ps1
#>
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'player-watchdog.ps1'
$text = Get-Content $source -Raw
$body = $text.Substring(0, $text.IndexOf('if ($Resume) {'))
$tempRoot = Join-Path $env:TEMP ('moden-wd-logic-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
. ([scriptblock]::Create($body)) -Root $tempRoot

# ---- mocks (defined after the real ones, same scope)
$fakeRoots = @()
$fakeLayout = $null
$events = [System.Collections.Generic.List[string]]::new()
function Get-ChromeExecutable { 'chrome.exe' }
function Get-RootChromeProcesses { return @($script:fakeRoots) }
function Get-DualScreenLayout { return $script:fakeLayout }
function Stop-ChromeTree([int]$ProcessId) { $script:events.Add("kill:$ProcessId") }
function Start-Kiosk([string]$ChromeExecutable, [object]$Display = $null) {
    $script:events.Add("start-player:" + $(if ($Display) { "$($Display.Left),$($Display.Top)" } else { 'default' }))
}
function Start-MonitorView([string]$ChromeExecutable, [object]$Display) { $script:events.Add("start-monitor:$($Display.Left),$($Display.Top)") }
function Set-ChromeOnDisplay([object[]]$ChromeRoots, [object]$Display, [string]$Label) { $script:events.Add("place:$Label@$($Display.Left)") }
function Repair-KioskFocus([object[]]$KioskRoots) { $script:events.Add("focus:" + (($KioskRoots | ForEach-Object { $_.ProcessId }) -join '+')) }
function Start-Sleep { }

function New-Root([int]$Id, [string]$CommandLine) { [pscustomobject]@{ ProcessId = $Id; CommandLine = $CommandLine } }
$player  = New-Root 100 "chrome.exe --kiosk --user-data-dir=$kioskProfile https://moden.up.railway.app/player"
$monitor = New-Root 200 "chrome.exe --kiosk --user-data-dir=$monitorProfile https://moden.up.railway.app/monitor"
$stray   = New-Root 300 'chrome.exe --profile-directory=Default'
$dual = @{
    Monitor   = [pscustomobject]@{ Left = 0; Top = 0; Width = 1920; Height = 1080; Primary = $true }
    Projector = [pscustomobject]@{ Left = 1920; Top = 0; Width = 1920; Height = 1080; Primary = $false }
}

$failures = 0
function Assert-Scenario([string]$Name, [object[]]$Roots, $Layout, [string]$Expected) {
    $script:fakeRoots = $Roots
    $script:fakeLayout = $Layout
    $script:events.Clear()
    Repair-Kiosk
    $actual = ($script:events -join ' | ')
    if ($actual -eq $Expected) { "PASS  $Name" }
    else { $script:failures++; "FAIL  $Name`n      expected: $Expected`n      actual:   $actual" }
}

# ---- single screen: must be what the watchdog has always done
Assert-Scenario 'single: player running'            @($player)           $null 'focus:100'
Assert-Scenario 'single: nothing running'           @()                  $null 'start-player:default | focus:'
Assert-Scenario 'single: stray chrome'              @($player, $stray)   $null 'kill:300 | focus:100'
Assert-Scenario 'single: leftover monitor view'     @($player, $monitor) $null 'kill:200 | focus:100'

# ---- two screens
$monitorWasRunning = $false; $monitorReopenAfter = [datetime]::MinValue
Assert-Scenario 'dual: only player -> open monitor' @($player)           $dual 'place:Player@1920 | start-monitor:0,0 | focus:100'
Assert-Scenario 'dual: both running'                @($player, $monitor) $dual 'place:Player@1920 | place:Monitor view@0 | focus:100'
Assert-Scenario 'dual: stray closed, monitor kept'  @($player, $monitor, $stray) $dual 'kill:300 | place:Player@1920 | place:Monitor view@0 | focus:100'
Assert-Scenario 'dual: every chrome died at once -> both back, no cool-down' @() $dual 'start-player:1920,0 | place:Player@1920 | start-monitor:0,0 | focus:'
$monitorWasRunning = $false; $monitorReopenAfter = [datetime]::MinValue
Assert-Scenario 'dual: both, then someone closes the monitor view (1/2)' @($player, $monitor) $dual 'place:Player@1920 | place:Monitor view@0 | focus:100'
Assert-Scenario 'dual: both, then someone closes the monitor view (2/2): no reopen, keyboard left alone' @($player) $dual 'place:Player@1920'
Assert-Scenario 'dual: still inside the cool-down'  @($player)           $dual 'place:Player@1920'
$monitorReopenAfter = (Get-Date).AddSeconds(-1)
Assert-Scenario 'dual: cool-down over -> reopen'    @($player)           $dual 'place:Player@1920 | start-monitor:0,0 | focus:100'

# ---- Q pause: nothing is touched and it does not count as "monitor closed"
$monitorWasRunning = $true
New-Item -ItemType File -Path $pauseMarker | Out-Null
Assert-Scenario 'pause: nothing happens'            @()                  $dual ''
Remove-Item $pauseMarker
"MONITOR_WAS_RUNNING_AFTER_PAUSE=$monitorWasRunning"
$monitorReopenAfter = [datetime]::MinValue
Assert-Scenario 'after pause: both come back at once' @()                $dual 'start-player:1920,0 | place:Player@1920 | start-monitor:0,0 | focus:'

# ---- a failure inside the monitor branch must not break the player checks
function Set-ChromeOnDisplay { throw 'simulated display failure' }
Assert-Scenario 'dual: monitor branch throws, player focus still repaired' @($player, $monitor) $dual 'focus:100'

"FAILURES=$failures"
Remove-Item -Recurse -Force $tempRoot
exit $failures
