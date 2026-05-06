# Setup completo de un mini-PC de mesa

Guía paso a paso para dejar un Intel mini-PC con Windows 11 Pro listo
para producción. Cada mini-PC hace tres cosas:

1. **Proyecta** imágenes de fabricación a pantalla completa (Chrome kiosk
   apuntando a `https://moden.up.railway.app/`).
2. **Captura fotos** con la cámara OBSBOT Tiny 2 cuando el operario
   selecciona ciertos ficheros (`*_foto*.jpg`, `*_check*.jpg`).
3. **Documenta la producción** cada segundo guardando un JPEG en Google
   Drive corporativo.

El detalle del servicio de captura está en el [`README.md`](README.md);
este documento cubre **todo lo demás** (Windows, auto-arranque, apps,
ajuste de cámara, entrega al cliente).

---

## 0. Material y valores por mesa

Cada mini-PC es idéntico salvo por el `mesa_id` y la asignación física
a una mesa. El nombre del equipo es `<CLI>-G<N>-<ROL>` (cliente +
número de grupo + rol); el `mesa_id` es el mismo en minúscula con
guiones bajos. Esa pareja se usa como carpeta de Drive y evita
colisiones entre clientes / grupos distintos.

| Cliente    | Grupo | Mesa física | `mesa_id`     | Nombre del equipo |
|------------|-------|-------------|---------------|-------------------|
| Ferralia   | G1    | Inferior 1  | `fer_g1_inf1` | `FER-G1-INF1`     |
| Ferralia   | G1    | Inferior 2  | `fer_g1_inf2` | `FER-G1-INF2`     |
| Ferralia   | G1    | Superiores  | `fer_g1_sup`  | `FER-G1-SUP`      |
| Ferralia   | G2    | Inferior 1  | `fer_g2_inf1` | `FER-G2-INF1`     |
| Ferralia   | G2    | …           | …             | …                 |

Anota también para cada mini-PC:
- Nombre del dispositivo en Chrome Remote Desktop (= computer name) y
  PIN de 6 dígitos (compartida entre los 3 mini-PCs de la ferralla).
- Cuenta Google corporativa de la ferralla (la misma del Drive y de CRD).
- Código de emparejamiento del visor (aparece en pantalla la primera vez
  que se abre — se introduce en el dashboard para vincularlo a la mesa).

---

## 1. Descargas (hazlas antes, así no dependes de la wifi del cliente)

Deja todo en `C:\moden\installers\` para que cualquier reinstalación
futura esté autocontenida.

| Paquete | Enlace oficial | Notas |
|---------|----------------|-------|
| Python 3.12 (Windows x64) | https://www.python.org/downloads/ | Marca **Add Python to PATH** al instalar |
| Google Chrome | https://www.google.com/chrome/ | |
| Google Drive Desktop | https://www.google.com/drive/download/ | Modo *Virtual drive* para tener `G:\` |
| Chrome Remote Desktop host | https://dl.google.com/edgedl/chrome-remote-desktop/chromeremotedesktophost.msi | El instalador lo descarga solo; aquí por si lo quieres pre-cargar en el pendrive |
| OBSBOT WebCam (controla la Tiny 2) | https://www.obsbot.com/download/tiny-2-lite | Incluye los presets de movimiento |
| Este repo, subcarpeta `capture_service\` | `git clone` o zip del repo | |

---

## 2. Primer arranque de Windows 11

1. **Cuenta local**: en el OOBE usa `Shift + F10` → `OOBE\BYPASSNRO` si
   Windows te obliga a cuenta Microsoft. Crea una cuenta **local** llamada
   `moden` con contraseña estándar (la misma en los tres mini-PCs para
   simplificar el soporte remoto).
2. **Nombre del equipo**: Ajustes → Sistema → Acerca de → *Cambiar nombre*.
   Usa `MODEN-MESA-INF1` (o el que corresponda).
3. **Actualizaciones**: deja que termine la primera tanda de Windows
   Update. Luego aplica las restricciones del paso 3.

---

## 3-6. Atajo automatizado (recomendado)

Si ya clonaste/copiaste este repo en el mini-PC, los pasos 3 a 6 están
encapsulados en [`install-minipc.ps1`](install-minipc.ps1). Abre
PowerShell **como administrador** desde la carpeta `capture_service/`
del repo y lanza:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install-minipc.ps1 -MesaId fer_g1_inf1 -ModenPassword "tu-clave"
```

Cambia `fer_g1_inf1` por el `mesa_id` que toque según la tabla de
arriba (formato `<cli>_g<N>_<rol>`). Omite `-ModenPassword` si prefieres
configurar el auto-login después con `netplwiz`.

El script es idempotente: lo puedes volver a ejecutar para
reinstalar el capture service o re-endurecer Windows sin que afecte
a la configuración ya presente. Deja un log en `%TEMP%\moden-minipc-setup-*.log`.

Los tres apartados siguientes describen lo mismo paso a paso por si
necesitas revisarlo a mano o revertir algo.

---

## 3. Endurecer Windows (script único)

Abre **PowerShell como administrador** y ejecuta todo este bloque.
Cada sección está comentada para que sepas qué hace y la puedas
revertir si hace falta.

```powershell
# --- a) No apagar pantalla ni suspender ---
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
# Desactivar "turn off display" también en batería (por si es un mini PC con UPS)
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-dc 0

# --- b) Ocultar el widget de noticias/clima y desactivar Copilot ---
New-Item  -Path "HKCU:\Software\Policies\Microsoft\Dsh" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Policies\Microsoft\Dsh" `
  -Name "AllowNewsAndInterests" -Value 0 -Type DWord
New-Item -Path "HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot" `
  -Name "TurnOffWindowsCopilot" -Value 1 -Type DWord

# --- c) Silenciar notificaciones del sistema (tips, anuncios, "suggerencias") ---
$explorer = "HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager"
Set-ItemProperty -Path $explorer -Name "SubscribedContent-338389Enabled" -Value 0 -Type DWord
Set-ItemProperty -Path $explorer -Name "SubscribedContent-338393Enabled" -Value 0 -Type DWord
Set-ItemProperty -Path $explorer -Name "SubscribedContent-353694Enabled" -Value 0 -Type DWord
Set-ItemProperty -Path $explorer -Name "SubscribedContent-353696Enabled" -Value 0 -Type DWord
Set-ItemProperty -Path $explorer -Name "SystemPaneSuggestionsEnabled" -Value 0 -Type DWord

# --- d) Windows Update: permitir descargas pero NUNCA reinicio automático ---
# Maneja la activación de "Horas activas" 24/7 para que no reinicie cuando quiera.
$au = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
New-Item -Path $au -Force | Out-Null
Set-ItemProperty -Path $au -Name "NoAutoRebootWithLoggedOnUsers" -Value 1 -Type DWord
# Aviso: seguimos recibiendo parches de seguridad, solo bloqueamos el reinicio.

# --- e) Auto-login para la cuenta 'moden' ---
$winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty -Path $winlogon -Name "AutoAdminLogon"    -Value "1"      -Type String
Set-ItemProperty -Path $winlogon -Name "DefaultUsername"   -Value "moden"  -Type String
Set-ItemProperty -Path $winlogon -Name "DefaultPassword"   -Value "<TU_PASS_AQUI>" -Type String
Set-ItemProperty -Path $winlogon -Name "DefaultDomainName" -Value $env:COMPUTERNAME -Type String

# --- f) Barra de tareas: ocultar widgets, chat y búsqueda ---
$explorerAdvanced = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
Set-ItemProperty -Path $explorerAdvanced -Name "TaskbarDa"   -Value 0 -Type DWord  # Widgets
Set-ItemProperty -Path $explorerAdvanced -Name "TaskbarMn"   -Value 0 -Type DWord  # Chat
Set-ItemProperty -Path $explorerAdvanced -Name "ShowTaskViewButton" -Value 0 -Type DWord
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Search" `
  -Name "SearchboxTaskbarMode" -Value 0 -Type DWord

# --- g) Desactivar Edge como navegador por defecto pop-ups ---
$edge = "HKCU:\Software\Policies\Microsoft\Edge"
New-Item -Path $edge -Force | Out-Null
Set-ItemProperty -Path $edge -Name "HideFirstRunExperience" -Value 1 -Type DWord
Set-ItemProperty -Path $edge -Name "StartupBoostEnabled"    -Value 0 -Type DWord
Set-ItemProperty -Path $edge -Name "BackgroundModeEnabled"  -Value 0 -Type DWord

# --- h) Reinicia explorer.exe para aplicar lo que depende de la barra ---
Stop-Process -Name explorer -Force
Start-Process explorer
```

> **Importante**: cambia `<TU_PASS_AQUI>` por la contraseña real de la
> cuenta `moden` antes de ejecutar el bloque (e). Si no quieres
> almacenar la contraseña en texto plano, usa `netplwiz` → desmarca
> *"Los usuarios deben escribir su nombre y contraseña"* y escribe la
> contraseña dos veces en el cuadro que aparece (Windows la almacena
> cifrada en LSA en vez de en el registro).

---

## 4. Instalar aplicaciones

En el orden en el que conviene (cada una deja algo que la siguiente
puede necesitar):

1. **Python 3.12** — `python --version` en PowerShell debe responder
   `Python 3.12.x`.
2. **Google Chrome** — al abrirlo la primera vez salta al default
   browser diálogo: ponlo como predeterminado.
3. **Google Drive Desktop**:
   - Iniciar sesión con la **cuenta corporativa Moden** que posee la
     unidad compartida de 30 TB.
   - Configuración → *Mi unidad* → **Transmitir archivos** (esto es el
     modo "virtual drive"). Deja `G:` como letra.
   - Pausar copias USB y fotos (no queremos que Drive suba nada más).
4. **Chrome Remote Desktop** — emparejar contra la cuenta Google
   corporativa de la ferralla:
   - Abre Chrome (sesión iniciada con esa cuenta) →
     `https://remotedesktop.google.com/access` → *"Configurar el acceso
     remoto"* → **Activar**.
   - Nombre del dispositivo = computer name (`FER-G1-INF1`, etc.).
   - PIN de 6 dígitos compartida entre los 3 mini-PCs de la ferralla.
   - Anota el nombre y la PIN.
5. **OBSBOT Tiny 2 (WebCam)**:
   - Conecta la cámara por USB-C.
   - Abre la app → comprueba vídeo → ajusta zoom/ángulo al plano de
     trabajo de la mesa → **guarda un preset** para poder restaurar el
     encuadre si alguien mueve la cámara.

---

## 5. Desplegar el capture service

Idéntico a lo que ya pone `README.md`; lo resumo aquí para no tener
que saltar de un documento al otro:

```powershell
# 1) Copia de la subcarpeta capture_service/ del repo:
robocopy <carpeta-repo>\capture_service C:\moden\capture_service /E

# 2) Virtualenv y dependencias
cd C:\moden\capture_service
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt

# 3) Config por mesa
copy config.ini.example config.ini
notepad config.ini
```

Ajusta en `config.ini`:
- `mesa_id = fer_g1_inf1`  (formato `<cli>_g<N>_<rol>` — ver tabla arriba)
- `output_dir = G:\Mi unidad\capturas_moden`
- Si el equipo tiene cámara integrada **además** de la OBSBOT revisa
  `camera_index` (0 = primera detectada — normalmente la OBSBOT si no
  hay webcam de portátil).

Verifica antes de seguir:

```powershell
curl http://127.0.0.1:5555/health   # debe responder {"status":"ok"}
curl -X POST http://127.0.0.1:5555/capture -o prueba.jpg
start prueba.jpg                    # foto nítida de la mesa
```

Y que aparezcan JPEGs nuevos bajo `G:\Mi unidad\capturas_moden\<mesa_id>\<fecha>\`.

---

## 6. Auto-arranque al iniciar sesión

Registramos una tarea programada *at logon* (en lugar de un shortcut
en `shell:startup`, que sufre el delay de ~10-15 s de Windows 11).
Desde PowerShell admin:

```powershell
$bat = 'C:\moden\capture_service\start-player.bat'
$action   = New-ScheduledTaskAction  -Execute $bat
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User 'moden'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'MODEN Player' `
    -Action $action -Trigger $trigger -Settings $settings `
    -RunLevel Limited -User 'moden' -Force
```

Reinicia: al iniciar sesión debe salir Chrome en kiosk apuntando a
`https://moden.up.railway.app/`, con el capture service corriendo en
segundo plano. `install-minipc.ps1` ya ejecuta este bloque; solo
hazlo a mano si estás montando el servicio fuera del instalador.

La **primera vez** que Chrome cargue el visor te pedirá permiso de
cámara/micrófono → *Permitir siempre para este sitio*. Queda grabado
para los siguientes arranques.

---

## 7. Vinculación al dashboard

En el primer arranque el visor muestra un código de emparejamiento de
6 dígitos. Desde otro equipo:

1. Entra al dashboard de moden.
2. **Gestionar** → abre el modal del grupo operativo → verás un botón
   por mesa sin vincular.
3. Introduce el código → el visor queda emparejado y el botón de
   conexión pasa a verde (el icono del monitor en la cabecera de la
   mesa).

---

## 8. Checklist de entrega al cliente

Al llegar al sitio:

- [ ] Conectar cada mini-PC a la red del cliente (Wi-Fi).
- [ ] Salir del kiosk: `Alt + F4` (solo con teclado externo).
- [ ] Configurar Wi-Fi desde la bandeja del sistema.
- [ ] Volver a lanzar `start-player.bat` — o reiniciar, auto-arranca.
- [ ] Abrir el dashboard desde otro equipo y confirmar que la mesa
      aparece **vinculada**.
- [ ] Comprobar que Google Drive Desktop muestra "Sincronizado" (icono
      verde) — si no, revisar Wi-Fi y credenciales.
- [ ] Probar una captura manual con un `_foto` y verificar que aparece
      tanto en el dashboard como en la carpeta de Drive.
- [ ] Anotar en la hoja de entrega: nombre del equipo, mesa asignada,
      nombre + PIN de Chrome Remote Desktop, fecha.

---

## 9. Mantenimiento desde remoto

Acceso por **Chrome Remote Desktop** desde
<https://remotedesktop.google.com/access> con la cuenta Google de la
ferralla (la del Drive). Casos típicos:

- **Cambiar horarios de captura o mesa_id**: CRD → editar
  `C:\moden\capture_service\config.ini` → `taskkill /im python.exe /f`
  → el .bat ya no relanza, así que cierra sesión y vuelve a entrar
  (o reinicia el mini-PC).
- **Actualizar el capture service**: CRD → `robocopy` la carpeta
  nueva sobre `C:\moden\capture_service` (excluyendo `config.ini` y la
  venv) → reinicio.
- **Problema grave**: Alt+F4 para salir del kiosk, revisar `/stats`
  desde PowerShell y decidir.
