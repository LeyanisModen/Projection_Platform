<#
.SYNOPSIS
  Setup desatendido de un mini-PC de mesa (Windows 11 Pro).

.DESCRIPTION
  Cubre los pasos 3 a 6 del runbook SETUP_MINIPC.md:
    - Endurecer Windows (energía, widgets, Copilot, news, barra de tareas,
      no reinicio automático por Windows Update).
    - Instalar las apps core vía winget (Python, Chrome, Drive, AnyDesk).
      OBSBOT WebCam se instala manualmente (no está publicado en winget).
    - Desplegar el capture_service en C:\moden\capture_service (robocopy,
      venv, pip install -r requirements.txt, config.ini con mesa_id).
    - Crear el acceso directo de start-player.bat en shell:startup.
    - (Opcional) Auto-login para la cuenta 'moden'.

  Ejecuta este script desde la propia carpeta capture_service/ del repo
  (misma carpeta que start-player.bat). Abre PowerShell COMO ADMINISTRADOR
  y lanza:

      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
      .\install-minipc.ps1 -MesaId mesa_inf1

.PARAMETER MesaId
  Identificador físico de la mesa. Debe coincidir con los usados en el
  dashboard: mesa_inf1, mesa_inf2 o mesa_sup.

.PARAMETER ModenPassword
  Contraseña de la cuenta local 'moden' para auto-login sin intervención.
  Si se omite, el bloque de auto-login se salta (puedes configurarlo
  después con netplwiz).

.PARAMETER SkipApps
  Omite la instalación de apps vía winget (útil si ya están puestas).

.PARAMETER SkipHardening
  Omite los ajustes de registro / powercfg.

.PARAMETER SkipCaptureService
  Omite el despliegue del capture_service y el shortcut de inicio
  (útil si solo quieres re-endurecer Windows).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('mesa_inf1','mesa_inf2','mesa_sup')]
    [string]$MesaId,

    [string]$ModenPassword = '',

    [switch]$SkipApps,
    [switch]$SkipHardening,
    [switch]$SkipCaptureService
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $env:TEMP ("moden-minipc-setup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Start-Transcript -Path $logPath -Force | Out-Null

function Require-Admin {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
               ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw "Este script debe ejecutarse como Administrador."
    }
}

function Step([string]$name) {
    Write-Host ""
    Write-Host ("=== {0} ===" -f $name) -ForegroundColor Cyan
}

function Set-RegValue([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
    # Windows 11 protects some registry paths (taskbar, explorer,
    # policies propagated by the enterprise). If a single key fails we
    # warn but keep going — the rest of the hardening + app install +
    # capture service deploy are more important than a couple of
    # cosmetic toggles.
    try {
        if (-not (Test-Path $Path)) {
            New-Item -Path $Path -Force -ErrorAction Stop | Out-Null
        }
        Set-ItemProperty -Path $Path -Name $Name -Value $Value -Type $Type -Force -ErrorAction Stop
    } catch {
        Write-Warning ("No se pudo escribir {0}\{1}: {2}" -f $Path, $Name, $_.Exception.Message)
    }
}

Require-Admin
Write-Host "Mini-PC setup: mesa = $MesaId" -ForegroundColor Yellow
Write-Host "Log: $logPath"

# ------------------------------------------------------------------ 3. Hardening
if (-not $SkipHardening) {
    Step "Energía (no suspender, no apagar pantalla)"
    foreach ($a in @('standby-timeout-ac','monitor-timeout-ac','hibernate-timeout-ac','disk-timeout-ac',
                     'standby-timeout-dc','monitor-timeout-dc','disk-timeout-dc')) {
        & powercfg /change $a 0 | Out-Null
    }

    Step "Quitar Widgets, Copilot, Newsfeed, Chat"
    Set-RegValue "HKCU:\Software\Policies\Microsoft\Dsh" "AllowNewsAndInterests" 0
    Set-RegValue "HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot" "TurnOffWindowsCopilot" 1

    $cd = "HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"
    foreach ($n in @('SubscribedContent-338389Enabled','SubscribedContent-338393Enabled',
                     'SubscribedContent-353694Enabled','SubscribedContent-353696Enabled',
                     'SystemPaneSuggestionsEnabled')) {
        Set-RegValue $cd $n 0
    }

    Step "Windows Update: nunca reinicia cuando hay sesión iniciada"
    Set-RegValue "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" "NoAutoRebootWithLoggedOnUsers" 1

    Step "Barra de tareas: sin Widgets / Chat / Task View / Search box"
    $adv = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
    Set-RegValue $adv "TaskbarDa" 0
    Set-RegValue $adv "TaskbarMn" 0
    Set-RegValue $adv "ShowTaskViewButton" 0
    Set-RegValue "HKCU:\Software\Microsoft\Windows\CurrentVersion\Search" "SearchboxTaskbarMode" 0

    Step "Edge sin splash ni background mode"
    $edge = "HKCU:\Software\Policies\Microsoft\Edge"
    Set-RegValue $edge "HideFirstRunExperience" 1
    Set-RegValue $edge "StartupBoostEnabled" 0
    Set-RegValue $edge "BackgroundModeEnabled" 0
}

# ------------------------------------------------------------------ 4. Apps
if (-not $SkipApps) {
    Step "Instalando apps con winget"
    $apps = @(
        @{ Id='Python.Python.3.12';    Name='Python 3.12' },
        @{ Id='Google.Chrome';         Name='Google Chrome' },
        @{ Id='Google.GoogleDrive';    Name='Google Drive Desktop' },
        @{ Id='AnyDesk.AnyDesk';       Name='AnyDesk' }
    )
    foreach ($app in $apps) {
        Write-Host ("  · {0} ({1})" -f $app.Name, $app.Id)
        & winget install --id $app.Id --silent --accept-source-agreements --accept-package-agreements | Out-Null
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
            Write-Warning "winget devolvió $LASTEXITCODE para $($app.Id). Revisa manualmente."
        }
    }
    Write-Host ""
    Write-Host "OBSBOT WebCam: no está en winget." -ForegroundColor Yellow
    Write-Host "  → descarga manual desde https://www.obsbot.com/download/tiny-2-lite"
}

# ------------------------------------------------------------------ 5-6. Capture service + auto-start
if (-not $SkipCaptureService) {
    Step "Desplegando capture_service en C:\moden\capture_service"

    $source = $PSScriptRoot
    $dest   = 'C:\moden\capture_service'
    $root   = 'C:\moden'

    if (-not (Test-Path $root)) {
        New-Item -Path $root -ItemType Directory -Force | Out-Null
    }

    # /MIR mantiene el árbol espejo pero excluye venv (se regenera) y
    # config.ini (lo generamos con el mesa_id correcto más abajo).
    Write-Host "  · robocopy"
    & robocopy $source $dest /MIR /XD venv __pycache__ /XF config.ini /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy falló con código $LASTEXITCODE"
    }

    Step "Virtualenv y dependencias de Python"
    Push-Location $dest
    try {
        if (-not (Test-Path (Join-Path $dest 'venv\Scripts\python.exe'))) {
            Write-Host "  · creando venv"
            & python -m venv venv
            if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el venv (¿está Python en PATH?)" }
        }
        Write-Host "  · pip install -r requirements.txt"
        & "$dest\venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
        & "$dest\venv\Scripts\python.exe" -m pip install -r "$dest\requirements.txt" --quiet
    } finally {
        Pop-Location
    }

    Step "config.ini con mesa_id = $MesaId"
    $configPath  = Join-Path $dest 'config.ini'
    $examplePath = Join-Path $dest 'config.ini.example'
    if (Test-Path $configPath) {
        Write-Host "  · ya existe, lo dejo intacto (edita a mano si hay que cambiar algo)"
    } elseif (Test-Path $examplePath) {
        (Get-Content $examplePath -Raw) `
            -replace 'mesa_id\s*=\s*mesa_inf1', "mesa_id = $MesaId" |
            Set-Content -Path $configPath -Encoding UTF8
        Write-Host "  · creado desde config.ini.example"
    } else {
        Write-Warning "No encontré config.ini.example; crea el config.ini a mano."
    }

    Step "Auto-arranque (shortcut en shell:startup)"
    $startup  = [Environment]::GetFolderPath('Startup')
    $lnkPath  = Join-Path $startup 'Moden Player.lnk'
    $batPath  = Join-Path $dest 'start-player.bat'
    $wshell   = New-Object -ComObject WScript.Shell
    $shortcut = $wshell.CreateShortcut($lnkPath)
    $shortcut.TargetPath       = $batPath
    $shortcut.WorkingDirectory = $dest
    $shortcut.WindowStyle      = 7     # minimized
    $shortcut.Description      = 'Moden projection + capture service'
    $shortcut.Save()
    Write-Host "  · $lnkPath"
}

# ------------------------------------------------------------------ Auto-login opcional
if ($ModenPassword) {
    Step "Auto-login para la cuenta 'moden'"
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-RegValue $winlogon "AutoAdminLogon"    "1"                -Type String
    Set-RegValue $winlogon "DefaultUsername"   "moden"            -Type String
    Set-RegValue $winlogon "DefaultPassword"   $ModenPassword     -Type String
    Set-RegValue $winlogon "DefaultDomainName" $env:COMPUTERNAME  -Type String
    Write-Host "  · OK (si prefieres no guardar la password en registro, usa netplwiz)."
} elseif (-not $SkipHardening) {
    Write-Host ""
    Write-Host "Auto-login: no pasaste -ModenPassword, configúralo después con netplwiz." -ForegroundColor Yellow
}

Stop-Transcript | Out-Null
Write-Host ""
Write-Host "Listo." -ForegroundColor Green
Write-Host "Log completo en: $logPath"
Write-Host "Reinicia el equipo para que entren los cambios de registro y arranque el player."
