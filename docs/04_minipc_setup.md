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
│   ├── config.ini.example
│   ├── install-minipc.ps1
│   ├── requirements.txt
│   ├── start-player.bat
│   ├── README.md
│   └── SETUP_MINIPC.md
└── obsbot-webcam-setup.exe         ← descárgalo aparte, no está en winget
```

La carpeta `capture_service/` se obtiene del repositorio:
https://github.com/LeyanisModen/Projection_Platform/tree/main/capture_service

**OBSBOT WebCam** se descarga desde:
https://www.obsbot.com/download/tiny-2-lite

Llévate también un **teclado USB** (harás falta al menos una vez para salir
del Chrome kiosk con `Alt + F4`) y anota las credenciales corporativas de la
cuenta Google Drive de Moden.

Tabla de valores por mini-PC:

| Mesa física | `mesa_id`   | Nombre del equipo   |
|-------------|-------------|---------------------|
| Inferior 1  | `mesa_inf1` | `MODEN-MESA-INF1`   |
| Inferior 2  | `mesa_inf2` | `MODEN-MESA-INF2`   |
| Superiores  | `mesa_sup`  | `MODEN-MESA-SUP`    |

---

## 1. Primer arranque de Windows 11

1. En el OOBE, cuando Windows te fuerce a cuenta Microsoft, pulsa
   `Shift + F10` → teclea `OOBE\BYPASSNRO` → Enter. Te deja crear **cuenta
   local**.
2. Usuario local: `moden` (mismo nombre en los tres mini-PCs para que el
   soporte remoto sea sencillo). Contraseña simple de producción — anótala.
3. Nombre del equipo: Ajustes → Sistema → Acerca de → **Cambiar nombre**:
   `MODEN-MESA-INF1` (o el que toque según tabla arriba).
4. Conecta a la wifi de la oficina y deja que termine la primera ronda de
   Windows Update.

---

## 2. BIOS: arranque automático al volver la luz

1. Reinicia y entra al BIOS (normalmente `Supr`, `F2` o `Del` al arrancar).
2. Busca `Restore on AC Power Loss`, `State After Power Failure` o similar
   (suele estar en *Chipset* o *Power Management*).
3. Cambia a **Power On**.
4. Guarda cambios (`F10`) y sal.

De aquí en adelante, cuando vuelva la luz en la fábrica, el mini-PC se
enciende solo.

---

## 3. Ejecutar el instalador automatizado

En el mini-PC, con el pendrive conectado:

1. Abre **Terminal (Administrador)** → verifica que estás en PowerShell
   (si abre CMD, teclea `powershell` y Enter).
2. Navega a la carpeta del pendrive:
   ```powershell
   cd E:\capture_service    # cambia E: por la letra del pendrive
   ```
3. Permite ejecutar scripts solo en esta sesión:
   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   ```
4. Lanza el instalador (reemplaza `mesa_inf1` por la mesa que toque):
   ```powershell
   .\install-minipc.ps1 -MesaId mesa_inf1
   ```
   > Si la cuenta `moden` tiene contraseña y quieres auto-login al estilo
   > Windows clásico, añade `-ModenPassword "laclave"`. Si la cuenta no
   > tiene contraseña, omite el flag — Windows entra directo igual.

Esto hace:
- **Hardening**: apaga widgets, Copilot, news, Windows Update sin reinicio
  automático, energía sin suspender, limpia barra de tareas. Si alguna
  entrada del registro está protegida por Windows 11 el script avisa
  (`WARNING`) y sigue.
- **Apps vía winget**: Python 3.12, Chrome, Google Drive Desktop, AnyDesk.
- **Capture service**: `robocopy` a `C:\moden\capture_service\`, crea la
  venv, `pip install -r requirements.txt`, genera `config.ini` con el
  `mesa_id` correcto (sin BOM — importante, el BOM rompía configparser).
- **Acceso directo** en `shell:startup` apuntando a `start-player.bat`.

Al terminar imprime `Listo.` en verde y guarda un log en
`%TEMP%\moden-minipc-setup-*.log`.

---

## 4. Auto-login (si pusiste contraseña)

Si omitiste `-ModenPassword` y sí quieres auto-login:

1. `Win + R` → `netplwiz` → Enter.
2. Selecciona el usuario `moden`.
3. **Desmarca** *"Los usuarios deben escribir su nombre y contraseña"*.
4. Aplicar. Introduce la contraseña dos veces para confirmar.

Con la cuenta sin contraseña, Windows 11 entra directo; no hace falta nada.

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

## 6. AnyDesk — acceso desatendido

winget ya instaló AnyDesk en el paso 3. Ahora hay que configurarlo para que
puedas entrar en remoto sin que nadie en el mini-PC tenga que aceptar la
conexión.

1. Abre **AnyDesk** en el mini-PC. Verás el **ID de AnyDesk** (9 dígitos)
   en la parte superior — **anótalo**, es el que usarás desde tu portátil.
2. Arriba a la derecha, click en el ☰ menú → **Configuración** /
   *Preferences*.
3. Pestaña **Seguridad** / *Security* → click en **"Desbloquear
   configuración de seguridad"** (requiere UAC).
4. Marca **"Permitir el acceso desatendido"** / *Enable unattended access*.
5. Click en **"Establecer contraseña para acceso desatendido"** →
   introduce una contraseña fuerte dos veces → **Aplicar**.
   > Recomendación: misma contraseña en los tres mini-PCs para simplificar
   > el soporte, distinta de la contraseña de la cuenta Windows.
6. (Opcional, recomendado) En la misma pestaña, marca también:
   - **"Inicio automático con Windows"** — para que esté disponible incluso
     antes de que el kiosko arranque.
   - **Bloquear la lista de IDs permitidos** si quieres limitar el acceso
     solo a tu portátil (apartado *"Control de acceso"*).

Anota en la hoja de entrega de cada mini-PC:
- ID AnyDesk (9 dígitos)
- Contraseña desatendida
- Mesa asignada

Verifica desde tu portátil: abre AnyDesk en el portátil → introduce el ID
→ debería pedir contraseña (no "accept/deny" en el otro lado) → conecta
directamente.

---

## 7. OBSBOT Tiny 2

### Instalación

Instala **OBSBOT WebCam** desde el `.exe` que trajiste en el pendrive
(no está en winget).

### Desactivar auto-sleep (¡importante!)

La Tiny 2 apaga el sensor y parca el cabezal tras unos minutos sin uso.
OpenCV luego no puede abrirla aunque el USB esté conectado:

1. Abre **OBSBOT Center** / **WebCam**.
2. Settings → busca **Sleep Mode** / **Auto Sleep** / *"Modo de
   suspensión"*.
3. Pon **OFF** o **Nunca**.

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
- ✅ **Moden Player** (`start-player.bat`) — la aplicación principal.
- ✅ **AnyDesk** — para poder entrar en remoto.

Apaga sin problema: OneDrive, Teams personal, Edge, Cortana, Widgets,
Centro de Opiniones, etc.

### Deshabilitar tareas programadas basura

`Win + R` → `taskschd.msc`. Click derecho → **Deshabilitar** (no borres):

- `MicrosoftEdgeUpdateTaskMachineCore`
- `MicrosoftEdgeUpdateTaskMachineUA`
- `OneDrive Reporting Task`
- `OneDrive Standalone Update Task`
- `OneDrive Startup Task`

---

## 9. Programador de Tareas (reemplaza shell:startup)

La carpeta `shell:startup` sufre el delay mencionado arriba. Para un kiosko
profesional la tarea programada "at logon, no delay" es más fiable:

```powershell
# PowerShell admin. Si tu cuenta se llama distinto, cambia -User 'moden'.
$bat = 'C:\moden\capture_service\start-player.bat'
$action   = New-ScheduledTaskAction  -Execute $bat
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User 'moden'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'MODEN Player' `
    -Action $action -Trigger $trigger -Settings $settings `
    -RunLevel Limited -User 'moden' -Force
```

Una vez creada, **elimina** el acceso directo viejo para que no se lance
dos veces:

```
Win + R → shell:startup → eliminar "Moden Player.lnk"
```

Verifica en Programador de tareas que sale **MODEN Player** con
desencadenador *"Cuando el usuario inicie sesión"*.

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

# Drive montado y escribiendo
Test-Path 'G:\Mi unidad\capturas_moden\mesa_inf1'
```

Y en el dashboard (desde tu laptop):
- El icono de monitor de la mesa es verde (vinculada).
- No aparece el chip rojo ni ámbar de "cámara" en la cabecera.

---

## 12. Checklist de entrega al cliente

Antes de empacar cada mini-PC:

- [ ] Nombre del equipo = `MODEN-MESA-<ID>` (según tabla).
- [ ] Cuenta `moden` (con o sin contraseña documentada).
- [ ] AnyDesk: **ID anotado** + contraseña desatendida puesta + probada
      desde el portátil (conecta sin preguntar al mini-PC).
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
- [ ] Confirmar desde el dashboard (vía AnyDesk si no tienes VPN) que la
      mesa sigue vinculada y las fotos suben a Drive.

---

## Mantenimiento remoto

Todo el mantenimiento posterior se hace con **AnyDesk** (acceso desatendido
ya configurado). Casos habituales:

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
