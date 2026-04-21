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
a una mesa. Llévate esta tabla a la configuración:

| Mesa física   | `mesa_id`   | Nombre sugerido del equipo | AnyDesk alias |
|---------------|-------------|----------------------------|---------------|
| Inferior 1    | `mesa_inf1` | `MODEN-MESA-INF1`          | `moden-inf1`  |
| Inferior 2    | `mesa_inf2` | `MODEN-MESA-INF2`          | `moden-inf2`  |
| Superiores    | `mesa_sup`  | `MODEN-MESA-SUP`           | `moden-sup`   |

Anota también para cada mini-PC:
- AnyDesk ID + contraseña de acceso desatendido.
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
| AnyDesk | https://anydesk.com/es/downloads/windows | |
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
4. **AnyDesk**:
   - *Set password for unattended access* → la misma contraseña que la
     cuenta `moden` (sencillo para recordar).
   - Anota el ID de AnyDesk del equipo.
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
- `mesa_id = mesa_inf1`  (o `mesa_inf2` / `mesa_sup`)
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

1. `Win + R` → `shell:startup`.
2. Copia el fichero **`start-player.bat`** (o un acceso directo a él)
   dentro de esa carpeta. Vive en
   `C:\Users\moden\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\`.
3. Reinicia: al iniciar sesión debe salir Chrome en kiosk apuntando a
   `https://moden.up.railway.app/`, con el capture service corriendo
   en segundo plano.

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
      AnyDesk ID, fecha.

---

## 9. Mantenimiento desde remoto

- **Cambiar horarios de captura o mesa_id**: AnyDesk → editar
  `C:\moden\capture_service\config.ini` → `taskkill /im python.exe /f`
  → el .bat ya no relanza, así que cierra sesión y vuelve a entrar
  (o reinicia el mini-PC).
- **Actualizar el capture service**: AnyDesk → `robocopy` la carpeta
  nueva sobre `C:\moden\capture_service` (excluyendo `config.ini` y la
  venv) → reinicio.
- **Problema grave**: Alt+F4 para salir del kiosk, revisar `/stats`
  desde PowerShell y decidir.
