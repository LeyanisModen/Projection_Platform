<#
.SYNOPSIS
  Setup desatendido de un mini-PC de mesa (Windows 11 Pro).

.DESCRIPTION
  Cubre los pasos 3 a 6 del runbook SETUP_MINIPC.md:
    - Endurecer Windows (energía, widgets, Copilot, news, barra de tareas,
      no reinicio automático por Windows Update).
    - Instalar las apps core: Python 3.12, Chrome y Google Drive Desktop
      vía winget; Chrome Remote Desktop host vía MSI directo de Google
      (no está en winget). OBSBOT WebCam se instala manualmente.
    - Desplegar el capture_service en C:\moden\capture_service (robocopy,
      venv, pip install -r requirements.txt, config.ini con mesa_id).
    - Registrar la tarea programada 'MODEN Player' (at logon) que lanza
      start-player.bat. También limpia un posible shortcut viejo en
      shell:startup si una versión anterior lo dejó.
    - (Opcional) Auto-login para la cuenta 'moden'.

  Ejecuta este script desde la propia carpeta capture_service/ del repo
  (misma carpeta que start-player.bat). Abre PowerShell COMO ADMINISTRADOR
  y lanza:

      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
      .\install-minipc.ps1 -MesaId fer_g1_inf1

.PARAMETER MesaId
  Identificador de la mesa con formato <cliente>_g<N>_<rol>, donde
  <cliente> es un código corto del cliente (fer = Ferralia, …), <N> es
  el número de grupo operativo dentro de ese cliente y <rol> es inf1,
  inf2 o sup. Ejemplos: fer_g1_inf1, fer_g1_sup, fer_g2_inf1. Va 1-a-1
  con el nombre del equipo (FER-G1-INF1, FER-G1-SUP, FER-G2-INF1).

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
    # Formato <cliente>_g<N>_<rol>: código cliente (minúsculas + dígitos)
    # + _g + número de grupo + _ + rol fijo (inf1, inf2, sup). Admite
    # también formas sin _gN si algún cliente solo tiene un grupo.
    # Ejemplos válidos: fer_g1_inf1, fer_g2_sup, xyz1_g10_inf2.
    [ValidatePattern('^[a-z][a-z0-9_]*_(inf[12]|sup)$')]
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

function Sync-EnvPath {
    # Cuando winget instala Python (o cualquier app que toca PATH) en mitad
    # del script, las nuevas entradas viven en HKLM\Environment y
    # HKCU\Environment del registro pero NO en el $env:Path de este
    # proceso de PowerShell — Windows solo hereda PATH al CREAR el proceso.
    # Esto refresca PATH leyendo Machine + User del registro, así no hace
    # falta cerrar la PowerShell y abrir otra para ver el python recién
    # instalado.
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
}

function Get-RealPython {
    # Devuelve la ruta a un python.exe utilizable, evitando la "app
    # execution alias" del Microsoft Store (C:\...\WindowsApps\python.exe)
    # que es un stub que solo abre el Store. Si nada va, devuelve $null.
    Sync-EnvPath
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch 'WindowsApps') {
        return $cmd.Source
    }
    # Fallback: rutas típicas donde winget pone Python user-scope (lo más
    # común en estos mini-PCs) o machine-scope.
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        'C:\Program Files\Python312\python.exe',
        'C:\Program Files\Python313\python.exe'
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
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
    # -e + --source winget: evita la fuente msstore, que en los Mele de
    # fábrica lleva un winget viejo (v1.6) con huella de certificado
    # caducada y rompe con 0x8a15005e. Los 3 paquetes están todos en
    # la fuente winget (GitHub), así que forzarla es seguro.

    Write-Host "  · Python 3.12"
    winget install --id Python.Python.3.12 -e --source winget --accept-source-agreements --accept-package-agreements

    Write-Host "  · Google Chrome"
    winget install --id Google.Chrome      -e --source winget --accept-source-agreements --accept-package-agreements

    Write-Host "  · Google Drive Desktop"
    winget install --id Google.GoogleDrive -e --source winget --accept-source-agreements --accept-package-agreements

    # Chrome Remote Desktop: el host se instala vía MSI desde Google (no
    # está en winget). El emparejamiento con la cuenta Google de la
    # ferralla se hace después a mano desde el navegador (paso 6 del
    # runbook).
    Step "Chrome Remote Desktop (host MSI)"
    $crdMsi = Join-Path $env:TEMP 'chromeremotedesktophost.msi'
    try {
        Write-Host "  · descargando MSI"
        Invoke-WebRequest 'https://dl.google.com/edgedl/chrome-remote-desktop/chromeremotedesktophost.msi' `
            -OutFile $crdMsi -UseBasicParsing
        Write-Host "  · msiexec /i /qn /norestart"
        Start-Process msiexec.exe -ArgumentList "/i `"$crdMsi`" /qn /norestart" -Wait -NoNewWindow
        Remove-Item $crdMsi -Force -ErrorAction SilentlyContinue
        Write-Host "  · host instalado. Empareja con la cuenta Google"
        Write-Host "    de la ferralla en https://remotedesktop.google.com/access"
    } catch {
        Write-Warning "No se pudo instalar Chrome Remote Desktop: $($_.Exception.Message)"
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
        $python = Get-RealPython
        if (-not $python) {
            throw @"
No encontré python.exe utilizable. Si winget acaba de instalar Python en
esta misma sesión, cierra esta PowerShell, abre una nueva como admin y
relanza el instalador (el PATH solo se refresca al crear el proceso).
"@
        }
        Write-Host "  · python: $python"

        # Validar venv existente: si hay un venv heredado (p.ej. de un
        # despliegue anterior bajo otro usuario) cuyo python.exe interno
        # apunta a un Python que ya no existe, nos lo cargamos para
        # recrearlo limpio. Un Test-Path solo no basta — el .exe puede
        # estar ahí pero ser un stub roto.
        $venvPython = Join-Path $dest 'venv\Scripts\python.exe'
        $venvOk = $false
        if (Test-Path $venvPython) {
            & $venvPython --version > $null 2>&1
            $venvOk = ($LASTEXITCODE -eq 0)
            if (-not $venvOk) {
                Write-Host "  · venv existente está roto (apunta a un Python que ya no existe), lo borro"
                Remove-Item (Join-Path $dest 'venv') -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        if (-not $venvOk) {
            Write-Host "  · creando venv"
            & $python -m venv venv
            if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el venv (python -m venv falló con código $LASTEXITCODE)" }
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
        # PowerShell 5.1's `Set-Content -Encoding UTF8` sneaks a BOM in
        # at the start of the file, which Python's configparser reads
        # as a non-comment character and blows up with
        # MissingSectionHeaderError. Write with .NET to guarantee
        # UTF-8 WITHOUT BOM.
        # Sustituimos el valor actual de mesa_id sea cual sea (el example
        # puede traer 'ferralla_inf1' u otro placeholder). Anclamos al
        # inicio de línea y al fin para no pisar otras cosas.
        $content = (Get-Content $examplePath -Raw) `
            -replace '(?m)^\s*mesa_id\s*=\s*\S+\s*$', "mesa_id = $MesaId"
        [System.IO.File]::WriteAllText(
            $configPath, $content, [System.Text.UTF8Encoding]::new($false)
        )
        Write-Host "  · creado desde config.ini.example"
    } else {
        Write-Warning "No encontré config.ini.example; crea el config.ini a mano."
    }

    Step "Auto-arranque (tarea programada 'MODEN Player')"
    # Tarea programada "at logon" en lugar de shortcut en shell:startup.
    # shell:startup sufre el StartupDelayInMSec (~10-15 s) que Windows 11
    # aplica a todo lo que vive en esa carpeta; la tarea programada arranca
    # sin ese retardo, que en un kiosko de producción se nota.
    $batPath = Join-Path $dest 'start-player.bat'
    $action   = New-ScheduledTaskAction  -Execute $batPath
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User 'moden'
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                  -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName 'MODEN Player' `
        -Action $action -Trigger $trigger -Settings $settings `
        -RunLevel Limited -User 'moden' -Force | Out-Null
    Write-Host "  · tarea 'MODEN Player' registrada (trigger: at logon de 'moden')"

    # Si una versión anterior del instalador dejó un shortcut en
    # shell:startup, lo quitamos para que start-player.bat no se lance
    # dos veces al iniciar sesión.
    $oldLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Moden Player.lnk'
    if (Test-Path $oldLnk) {
        Remove-Item $oldLnk -Force
        Write-Host "  · borrado shortcut viejo en shell:startup ($oldLnk)"
    }
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
