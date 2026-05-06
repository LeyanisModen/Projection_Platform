# 04. Configuración Mini-PC (Zero Touch Setup)

Runbook completo para dejar un mini-PC Windows 11 Pro listo para producción.
Objetivo: se enciende, inicia sesión solo, arranca Chrome kiosk apuntando al
player de Moden, la cámara graba fotos continuas y los operarios pueden
disparar capturas de "foto fabricada" sin tocar el mini-PC.

> Para la instalación automática (pasos 4 y 9) hay un script de PowerShell
> en [`capture_service/install-minipc.ps1`](../capture_service/install-minipc.ps1)
> que cubre el endurecimiento del sistema, winget installs, deploy del
> capture service y shortcut de arranque. Este documento añade los pasos
> manuales (BIOS, Drive, OBSBOT, tarea programada, vinculación) y la guía
> de entrega al cliente.

---

## 0. Antes de empezar: preparar el pendrive

En tu ordenador de oficina, copia al pendrive:

```
pendrive/
├── capture_service/                ← la carpeta tal cual del repo
│   ├── capture_service.py
│   ├── COMANDOS.txt                ← cheatsheet copy-paste para el mini-PC
│   ├── config.ini.example
│   ├── install-minipc.ps1
│   ├── requirements.txt
│   ├── start-player.bat
│   ├── README.md
│   └── SETUP_MINIPC.md
└── obsbot-webcam-setup.exe         ← descárgalo aparte, no está en winget
```

La carpeta `capture_service/` se obtiene del repositorio:
<https://github.com/LeyanisModen/Projection_Platform/tree/main/capture_service>

**OBSBOT WebCam** se descarga desde:
<https://www.obsbot.com/download/tiny-2-lite>

Llévate también un **teclado USB** (harás falta al menos una vez para salir
del Chrome kiosk con `Alt + F4`) y anota las credenciales corporativas de la
cuenta Google Drive de Moden.

Tabla de valores por mini-PC. El nombre del equipo sigue el formato
`(<CLI>-G<N>-<ROL>)` y el `mesa_id` es el mismo en minúsculas con
guiones bajos (`<cli>_g<N>_<rol>`):

- `<CLI>` — código corto del cliente (3-4 letras). Ferralia = `FER`.
- `G<N>` — número de grupo operativo dentro de ese cliente
  (`G1`, `G2`, …). Cada grupo agrupa 3 mini-PCs.
- `<ROL>` — papel físico de la mesa: `INF1`, `INF2` o `SUP`.

El `mesa_id` se usa como subcarpeta en Google Drive (y se muestra en el
dashboard), así que la misma separación entre clientes / grupos impide
que las capturas colisionen.

| Cliente    | Grupo | Mesa física | `mesa_id`     | Nombre del equipo |
|------------|-------|-------------|---------------|-------------------|
| Ferralia   | G1    | Inferior 1  | `fer_g1_inf1` | `FER-G1-INF1`     |
| Ferralia   | G1    | Inferior 2  | `fer_g1_inf2` | `FER-G1-INF2`     |
| Ferralia   | G1    | Superiores  | `fer_g1_sup`  | `FER-G1-SUP`      |
| Ferralia   | G2    | Inferior 1  | `fer_g2_inf1` | `FER-G2-INF1`     |
| Ferralia   | G2    | …           | …             | …                 |

El nombre del equipo cabe holgadamente en los 15 caracteres que
permite NetBIOS, así que caben clientes con código de hasta 4 letras
y hasta 9 grupos sin rozar el límite.

---

## 0.1. Imprime etiquetas para identificar los equipos

## 0.5. Si el mini-PC ya viene con Windows preinstalado (Mele fanless y similares)

Los Mele fanless (y otros mini-PCs de marca blanca) llegan con Windows 11
Pro ya configurado y una cuenta local administradora llamada `Usuario`
(sin contraseña). No hay OOBE que completar; en su lugar, hay que crear
`moden` y borrar `Usuario` antes de seguir.

> No intentes renombrar `Usuario` → `moden` desde `netplwiz` o
> `lusrmgr.msc`. Eso cambia solo el display name y deja la carpeta de
> perfil en `C:\Users\Usuario`, lo que rompe el `-User 'moden'` de la
> tarea programada del paso 9 y el `-ModenPassword` del instalador.

1. Inicia sesión como `Usuario` y abre **PowerShell como Administrador**.
2. Crea la cuenta `moden` como administrador:

   ```powershell
   $pw = Read-Host "Contraseña para moden" -AsSecureString
   New-LocalUser -Name 'moden' -Password $pw -FullName 'Moden' `
       -Description 'Cuenta de producción' -PasswordNeverExpires
   Add-LocalGroupMember -Group 'Administradores' -Member 'moden'
   # Si el Windows está en inglés: -Group 'Administrators'
   ```

3. **Cierra sesión** de `Usuario` → **inicia sesión como `moden`**. La
   primera vez Windows tarda 30-60 s creando `C:\Users\moden`.
4. Verifica que `moden` quedó en el grupo de administradores:

   ```powershell
   net localgroup Administradores    # o Administrators si está en inglés
   ```

5. Desde la sesión de `moden`, borra la cuenta antigua y su perfil:

   ```powershell
   Remove-LocalUser -Name 'Usuario'
   Remove-Item 'C:\Users\Usuario' -Recurse -Force -ErrorAction SilentlyContinue
   ```

   Si `Remove-Item` se queja por archivos en uso, reinicia y repite.

Hecho esto, **salta los puntos 1.1 y 1.2** del siguiente apartado y
continúa directamente en **1.3** (nombre del equipo).

---

## 1. Primer arranque de Windows 11

> Si seguiste el paso 0.5 (Mele u otro mini-PC preinstalado) ya tienes
> la cuenta `moden` creada: salta al punto 3.

1. En el OOBE, cuando Windows te fuerce a cuenta Microsoft, pulsa
   `Shift + F10` → teclea `OOBE\BYPASSNRO` → Enter. Te deja crear **cuenta
   local**.
2. Usuario local: `moden` (mismo nombre en los tres mini-PCs para que el
   soporte remoto sea sencillo). Contraseña simple de producción — anótala.
3. Conecta a la wifi de la oficina
4. Nombre del equipo: Ajustes → Sistema → Acerca de → **Cambiar nombre**:
   `FER-G1-INF1` (o el que toque según tabla arriba).
5. Reinicia y deja que termine la primera ronda de Windows Update.

---

## 2. BIOS: arranque automático al volver la luz

Mode

1. Reinicia y entra al BIOS (normalmente `F7` o `Del` al arrancar presionando continuamente).
2. Localiza la opción de encendido tras corte de corriente — según
   modelo se llama `Restore on AC Power Loss`, `State After Power
   Failure`, `Auto Power On` o similar.

   **En los Mele Quieter 4C** (BIOS AMI Aptio v2.22.x) está oculta en
   un menú OEM, no en los sitios habituales:

   > `Advanced` → `Customer Exclusive Functions` → **`Auto Power On`**

   El resto de ubicaciones habituales en AMI Aptio para otros modelos:
   `Chipset → PCH-IO Configuration → State After G3`,
   `Chipset → PCH-IO Configuration → State After G3`,
   `Advanced → APM Configuration → Restore AC Power Loss`,
   `Advanced → Power & Performance → AC Loss`.

3. Cámbialo a **Enabled** / **Power On** (no `Last State`).
4. `F4` → Save & Exit → Yes.

**Prueba**: desenchufa el cable 5 segundos y vuelve a enchufarlo sin
tocar el botón. Debe arrancar solo.

---

## 3. Ejecutar el instalador automatizado

En el mini-PC, con el pendrive conectado:

1. Abre **Terminal (Administrador)** → verifica que estás en PowerShell
   (si abre CMD, teclea `powershell` y Enter).
2. Navega a la carpeta del pendrive:

   ```powershell
   cd D:\capture_service    # cambia D: por la letra del pendrive
   ```

3. Permite ejecutar scripts solo en esta sesión:

   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   ```

4. Lanza el instalador (reemplaza `fer_g1_inf1` por el `mesa_id` que
   toque según la tabla del paso 0):

   ```powershell
   .\install-minipc.ps1 -MesaId fer_g1_inf1 -ModenPassword "Moden1234"
   ```

- **Hardening**: apaga widgets, Copilot, news, Windows Update sin reinicio
  automático, energía sin suspender, limpia barra de tareas. Si alguna
  entrada del registro está protegida por Windows 11 el script avisa
  (`WARNING`) y sigue.
- **Apps base**: Python 3.12, Chrome y Google Drive Desktop vía winget;
  Chrome Remote Desktop host vía MSI directo de Google. El script fuerza
  `--source winget` para saltarse la fuente `msstore`, que en los Mele
  de fábrica trae un winget v1.6 con certificado caducado y rompe con
  `0x8a15005e`.
- **Capture service**: `robocopy` a `C:\moden\capture_service\`, crea la
  venv, `pip install -r requirements.txt`, genera `config.ini` con el
  `mesa_id` correcto (sin BOM — importante, el BOM rompía configparser).
- **Acceso directo** en `shell:startup` apuntando a `start-player.bat`.

Al terminar imprime `Listo.` en verde y guarda un log en
`%TEMP%\moden-minipc-setup-*.log`.

---

## 4. Auto-login — (rescate, normalmente no hace falta)

Si pasaste `-ModenPassword` al instalador en el paso 3, el auto-login
**ya está configurado** (el script escribe las 4 claves de
`HKLM:\...\Winlogon`: `AutoAdminLogon`, `DefaultUsername`,
`DefaultPassword`, `DefaultDomainName`). Salta directo al paso 5.

Solo necesitas tocar algo aquí si olvidaste el flag o quieres
cambiarlo después. Opciones:

- **Registro directo** (mismo efecto que el flag, PowerShell admin):

  ```powershell
  $w = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $w 'AutoAdminLogon'    '1'               -Type String -Force
  Set-ItemProperty $w 'DefaultUsername'   'moden'           -Type String -Force
  Set-ItemProperty $w 'DefaultPassword'   'Moden1234'       -Type String -Force
  Set-ItemProperty $w 'DefaultDomainName' $env:COMPUTERNAME -Type String -Force
  ```

- **Vía netplwiz** (Windows 11 oculta la casilla por defecto, hay que
  habilitarla primero):

  ```powershell
  Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device' 'DevicePasswordLessBuildVersion' 0 -Type DWord -Force
  ```

  Luego `Win+R` → `netplwiz` → seleccionar `moden` → desmarcar *"Los
  usuarios deben escribir su nombre y contraseña"* → Aplicar → pedir
  la contraseña dos veces.

---

## 5. Google Drive Desktop

Lo instaló winget, pero hay que configurarlo a mano:

1. Abre **Google Drive** (se instala como `Drive File Stream` en la bandeja
   del sistema).
2. Inicia sesión con la **cuenta corporativa Moden** que posee la unidad
   compartida de 30 TB.
3. Configuración → **Mi unidad** → **Transmitir archivos** (virtual drive).
4. Deja la letra en **`G:`**. Si la asigna a otra por un pendrive conectado,
   desconecta el pendrive y vuelve a pedir `G:`.
5. Verifica:

   ```powershell
   Test-Path 'G:\Mi unidad\capturas_moden'
   ```

   Debe salir `True` después de que Drive termine la primera sincronización.

Google Drive debe quedarse **activo al inicio** — es quien monta `G:\` y
sincroniza las capturas al cloud. No lo desactives en la limpieza del paso 8.

---

## 6. Chrome Remote Desktop — emparejamiento

El instalador del paso 3 ya descargó e instaló el host de Chrome Remote
Desktop como servicio de Windows. Lo que queda es **emparejar** el
mini-PC a la cuenta de Google corporativa de la ferralla (la misma del
Drive, paso 5) para activar el acceso remoto.

> **Mini-PCs antiguos**: los que ya están desplegados con AnyDesk se
> quedan como están — Moden los soporta vía AnyDesk hasta el reemplazo
> natural. Los nuevos mini-PCs van solo con Chrome Remote Desktop.

1. Abre **Chrome** en el mini-PC. Inicia sesión con la **cuenta Google
   corporativa de la ferralla** (la del Drive).
2. Ve a:

   ```text
   https://remotedesktop.google.com/access
   ```

3. Sección **"Configurar el acceso remoto"** → click en **"Activar"**
   / *Turn on*.
4. **Nombre del dispositivo**: pon el computer name (`FER-G1-INF1`,
   `FER-G1-INF2`, `FER-G1-SUP`, …) para que en la lista de Moden
   aparezca cada mini-PC con su nombre real.
5. **PIN de 6 dígitos**: misma PIN para los tres mini-PCs de cada
   ferralla (simplifica soporte), distinta entre ferrallas distintas.
   Anótala en la hoja de entrega.
6. Cuando Windows pida permisos UAC al instalar el servicio host,
   acepta.

Anota en la hoja de entrega de cada mini-PC:

- Nombre del dispositivo en CRD (= computer name)
- PIN de 6 dígitos (123456789)
- Cuenta Google de la ferralla (la misma del Drive)

Verifica desde tu portátil: entra a
<https://remotedesktop.google.com/access> con la misma cuenta de Google
→ debe aparecer el mini-PC en la lista de **"Equipos remotos"** →
click → introduce la PIN → conecta.

---

## 7. OBSBOT Tiny 2

### Instalación

Instala **OBSBOT WebCam** desde el `.exe` que trajiste en el pendrive
(no está en winget).

### Desactivar auto-sleep (¡importante!)

La Tiny 2 apaga el sensor y parca el cabezal tras unos minutos sin uso.
OpenCV luego no puede abrirla aunque el USB esté conectado:

1. Abre **OBSBOT Center** / **WebCam**.
2. Settings / más → busca **Sleep Mode** / **Auto Sleep** / *"Modo de
   suspensión"*.
3. Pon **OFF** o **Nunca**.
4. Desactivar el seguimiento también

El setting queda grabado en el firmware de la cámara, así que aunque
después desinstales OBSBOT Center la cámara sigue despierta.

### Encuadre

Con la app abierta, mueve el cabezal para apuntar a la zona de fabricación
de la mesa. Guarda un **preset** de posición — si alguien golpea la cámara
con un cartón la puedes restaurar sin re-aimar.

### Cerrar OBSBOT Center

Una vez hecho lo anterior, **cierra OBSBOT Center** completamente (click
derecho en el icono de bandeja → *Quit* / *Salir*). Mientras la app está
abierta, OpenCV **no puede** abrir la cámara — Windows solo permite una app
a la vez.

### Permiso de Python para la cámara

Ajustes → Privacidad y seguridad → **Cámara**:

- Acceso a cámara: **On**.
- Permitir que las aplicaciones accedan a la cámara: **On**.
- **Permitir que las aplicaciones de escritorio accedan a la cámara: On**
  ← Windows 11 lo deja en OFF por defecto y bloquea Python en silencio.

---

## 8. Limpiar el arranque de Windows

### Quitar el delay intencional de Startup (Win 11)

Por defecto Windows espera ~10-15 s antes de lanzar lo de `shell:startup`
para que el escritorio "se sienta rápido". En un kiosko eso es un lastre:

```cmd
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Serialize" /v StartupDelayInMSec /t REG_DWORD /d 0 /f
```

(ejecutar como el usuario `moden`, en CMD o PowerShell).

### Desactivar apps de inicio innecesarias

Ajustes → Aplicaciones → **Inicio**. Apaga todo salvo:

- ✅ **Google Drive** — monta `G:\`, necesario.

Apaga sin problema: OneDrive, Teams personal, Edge, Cortana, Widgets,
Centro de Opiniones, etc. **Moden Player** y **Chrome Remote Desktop**
no aparecen en esta lista porque arrancan por tarea programada y
servicio de Windows respectivamente, no por `shell:startup`.

### Deshabilitar tareas programadas basura

`Win + R` → `taskschd.msc`. Click derecho → **Deshabilitar** (no borres):

- `MicrosoftEdgeUpdateTaskMachineCore`
- `MicrosoftEdgeUpdateTaskMachineUA`
- `OneDrive Reporting Task`
- `OneDrive Standalone Update Task`
- `OneDrive Startup Task`

---

## 9. Verifica la tarea programada "MODEN Player"

El instalador del paso 3 ya crea la tarea programada `MODEN Player`
con trigger *at logon* para la cuenta `moden`. No hace falta crearla
a mano ni tocar `shell:startup` (usamos tarea programada precisamente
para evitar el delay de Windows 11 sobre la carpeta de inicio).

`Win + R` → `taskschd.msc` → **Biblioteca del Programador de tareas**:
debe aparecer **MODEN Player** con desencadenador *"Cuando el usuario
`moden` inicie sesión"*.

Si por lo que sea falta (mini-PC configurado antes de tener este paso
integrado), la recreas así en PowerShell admin:

```powershell
$bat = 'C:\moden\capture_service\start-player.bat'
$action   = New-ScheduledTaskAction  -Execute $bat
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User 'moden'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'MODEN Player' `
    -Action $action -Trigger $trigger -Settings $settings `
    -RunLevel Limited -User 'moden' -Force

# Limpia un posible shortcut heredado:
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'Moden Player.lnk') -Force -ErrorAction SilentlyContinue
```

---

## 10. Vinculación con el dashboard

1. Cierra sesión y vuelve a entrar (o reinicia) → debe salir Chrome en
   kiosk en 2-3 segundos mostrando el **código de emparejamiento** de 6
   caracteres hexadecimales.
2. Desde tu portátil, entra al dashboard de Moden.
3. En el grupo operativo de la ferralla → botón **Gestionar**.
4. Busca la mesa correspondiente (INF1 / INF2 / SUP) → pega el código.
5. El icono del monitor en la cabecera de la mesa pasa a verde — mesa
   vinculada.

Si el código caduca mientras lo tecleas (TTL 2 min), el visor genera uno
nuevo automáticamente.

---

## 11. Pruebas finales antes de entrega

En el mini-PC, PowerShell:

```powershell
# Health del capture service
curl.exe http://127.0.0.1:5555/health
# → {"status":"ok"}

# Foto manual — debe abrir una foto fresca
curl.exe -X POST http://127.0.0.1:5555/capture -o test.jpg --max-time 15
start test.jpg

# Stats: in_active_window=true, last_capture_at con fecha de hoy,
# captures_today incrementando cada segundo si estás dentro del horario.
(Invoke-WebRequest http://127.0.0.1:5555/stats -UseBasicParsing).Content

# Drive montado y escribiendo (reemplaza fer_g1_inf1 por el mesa_id que toque)
Test-Path 'G:\Mi unidad\capturas_moden\fer_g1_inf1'
```

Y en el dashboard (desde tu laptop):

- El icono de monitor de la mesa es verde (vinculada).
- No aparece el chip rojo ni ámbar de "cámara" en la cabecera.

---

## 12. Checklist de entrega al cliente

Antes de empacar cada mini-PC:

- [ ] Nombre del equipo = `<CLI>-G<N>-<ROL>` (según tabla, p.ej. `FER-G1-INF1`).
- [ ] Cuenta `moden` (con o sin contraseña documentada).
- [ ] Chrome Remote Desktop: dispositivo emparejado con la cuenta Google
      de la ferralla, PIN configurada y probada desde el portátil
      (conecta entrando en `remotedesktop.google.com/access`).
- [ ] `config.ini` en `C:\moden\capture_service` tiene el `mesa_id` correcto.
- [ ] `/health` responde 200.
- [ ] `/capture` devuelve foto real.
- [ ] `G:\Mi unidad\capturas_moden\<mesa_id>\<hoy>\` tiene JPEGs frescos.
- [ ] Mesa vinculada en el dashboard.
- [ ] Chrome kiosk arranca solo tras reinicio en < 10 segundos.
- [ ] OBSBOT apuntando a la mesa con preset guardado.

En el cliente, al conectarlo a su red:

- [ ] `Alt + F4` para salir del kiosk (necesitas teclado externo una vez).
- [ ] Conectar la Wi-Fi del cliente desde la bandeja.
- [ ] Reiniciar — debe arrancar solo en el entorno del cliente.
- [ ] Confirmar desde el dashboard (vía Chrome Remote Desktop si no
      tienes VPN) que la mesa sigue vinculada y las fotos suben a Drive.

---

## Mantenimiento remoto

Todo el mantenimiento posterior se hace con **Chrome Remote Desktop**
(emparejamiento ya configurado). Desde tu portátil, entra a
<https://remotedesktop.google.com/access> con la cuenta Google
corporativa de la ferralla, elige el mini-PC en la lista y conecta con
la PIN. Casos habituales:

- **Cambiar mesa_id / horarios / resolución**: edita
  `C:\moden\capture_service\config.ini` → mata el proceso Python y reinicia
  sesión o el equipo.
- **Actualizar el capture service**: `robocopy` la carpeta nueva del repo
  sobre `C:\moden\capture_service` excluyendo `venv` y `config.ini`, y
  reinicia el proceso.
- **Revisar por qué no sube una foto**:
  `(Invoke-WebRequest http://127.0.0.1:5555/stats -UseBasicParsing).Content`
  → mira `last_error`, `in_active_window`, `skipped_out_of_schedule`.
- **Cámara colgada**: habitualmente OBSBOT Center se quedó abriendo la
  cámara. `Get-Process -Name *obsbot* | Stop-Process -Force` y
  `Get-Process python | Stop-Process -Force` → cerrar sesión + entrar.

---

## Troubleshooting rápido

| Síntoma | Causa habitual | Arreglo |
|---------|----------------|---------|
| Chrome tarda 1 min en arrancar | Windows 11 startup delay + apps parasitas | Paso 8 (StartupDelayInMSec=0 + limpiar Inicio) |
| El visor queda "dormido" hasta clicar | `CalculateNativeWinOcclusion` | Ya incluido en los flags de `start-player.bat` |
| `/capture` tarda 30s sin responder | MSMF hang / OBSBOT Center ocupada | `CAP_DSHOW` (ya en el .py) + matar `*obsbot*` |
| `MissingSectionHeaderError` en el capture service | BOM en `config.ini` por PowerShell | Reescribir sin BOM (one-liner al final) |
| `last_error: null` pero `captures_today: 0` | Fuera del `active_start_hour`-`active_end_hour` | Ajustar en `config.ini` y reiniciar |
| Código de vinculación cambia cada pocos segundos | Ya resuelto en el backend; refresca el visor | — |

**Arreglo del BOM en `config.ini`** (si pasa, one-liner):

```powershell
$p = 'C:\moden\capture_service\config.ini'
$raw = Get-Content $p -Raw
[IO.File]::WriteAllText($p, $raw, [Text.UTF8Encoding]::new($false))
```
