<#
.SYNOPSIS
  Genera el PDF del runbook de mini-PC (docs/04_minipc_setup.md ->
  capture_service/04_minipc_setup.pdf) para que viaje en el pendrive
  de setup junto al instalador.

.DESCRIPTION
  El markdown de docs/ es la fuente de la verdad. El PDF es un
  derivado que NO se commitea (ver .gitignore). Lanza este script
  justo antes de copiar la carpeta capture_service/ al pendrive.

  Requisitos (instalar una vez por maquina):
      winget install --id JohnMacFarlane.Pandoc      --source winget
      winget install --id wkhtmltopdf.wkhtmltox      --source winget
  (cierra y reabre la PowerShell tras instalar para refrescar PATH).

  Uso:
      .\scripts\build-pendrive.ps1

  El script:
   - Verifica que pandoc y wkhtmltopdf esten en PATH.
   - Convierte docs/04_minipc_setup.md a PDF con indice (TOC).
   - Lo deja en capture_service/04_minipc_setup.pdf.

  Nota sobre encoding: este .ps1 esta escrito en ASCII puro a
  proposito. Windows PowerShell 5.1 lee .ps1 sin BOM como ANSI
  (Windows-1252), asi que cualquier acento o raya larga rompe el
  parser. Mantener ASCII evita el problema en cualquier maquina.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# El script vive en repo/scripts/. El repo root es el padre.
$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot 'docs\04_minipc_setup.md'
$dst = Join-Path $repoRoot 'capture_service\04_minipc_setup.pdf'

# --- 1. Resolver herramientas ----------------------------------------------
# Busca el .exe primero en PATH y, si no, en las rutas donde lo deja el
# instalador. winget NO mete wkhtmltopdf en PATH (queda en
# C:\Program Files\wkhtmltopdf\bin\), asi que sin este fallback el script
# fallaria aunque este instalado.
function Resolve-Tool([string]$Name, [string[]]$Fallbacks) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($f in $Fallbacks) {
        if (Test-Path $f) { return $f }
    }
    return $null
}

$pandoc = Resolve-Tool 'pandoc' @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\JohnMacFarlane.Pandoc_Microsoft.Winget.Source_8wekyb3d8bbwe\*\pandoc.exe"
)
$wkhtml = Resolve-Tool 'wkhtmltopdf' @(
    'C:\Program Files\wkhtmltopdf\bin\wkhtmltopdf.exe',
    'C:\Program Files (x86)\wkhtmltopdf\bin\wkhtmltopdf.exe'
)

# El glob de pandoc puede devolver varias versiones; quedate con la real.
if ($pandoc -and $pandoc -match '\*') {
    $pandoc = (Get-Item $pandoc -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}

$missing = @()
if (-not $pandoc) { $missing += 'pandoc' }
if (-not $wkhtml) { $missing += 'wkhtmltopdf' }
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Faltan herramientas: $($missing -join ', ')" -ForegroundColor Red
    Write-Host ""
    Write-Host "Instalalas con (IDs correctos de winget):" -ForegroundColor Yellow
    if ($missing -contains 'pandoc') {
        Write-Host "  winget install --id JohnMacFarlane.Pandoc --source winget"
    }
    if ($missing -contains 'wkhtmltopdf') {
        Write-Host "  winget install --id wkhtmltopdf.wkhtmltox --source winget"
    }
    Write-Host ""
    Write-Host "Tras instalar, vuelve a lanzar este script (no hace falta reabrir"
    Write-Host "la PowerShell: el script busca los .exe en su ruta de instalacion)."
    exit 1
}

if (-not (Test-Path $src)) {
    Write-Host "No encuentro el markdown fuente: $src" -ForegroundColor Red
    exit 1
}

# --- 2. Generar PDF --------------------------------------------------------
Write-Host "pandoc:      $pandoc" -ForegroundColor DarkGray
Write-Host "wkhtmltopdf: $wkhtml" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Generando $dst" -ForegroundColor Cyan

$today = Get-Date -Format 'yyyy-MM-dd'

& $pandoc $src `
    --output=$dst `
    --pdf-engine=$wkhtml `
    --toc --toc-depth=2 `
    --metadata "title=Setup Mini-PC Moden" `
    --metadata "subtitle=Runbook de despliegue (Dell / Mele)" `
    --metadata "date=$today" `
    --variable "margin-top=18mm" `
    --variable "margin-bottom=18mm" `
    --variable "margin-left=18mm" `
    --variable "margin-right=18mm"

if ($LASTEXITCODE -ne 0) {
    Write-Host "pandoc devolvio codigo $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

$size = (Get-Item $dst).Length / 1KB
Write-Host ""
Write-Host ("Listo: {0} ({1:N0} KB)" -f $dst, $size) -ForegroundColor Green
Write-Host "El PDF esta en .gitignore - no se commitea, regenerarlo antes de cada pendrive."
