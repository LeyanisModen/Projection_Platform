# 04. Configuración Mini PC (Zero Touch Setup)

## Objetivo
Lograr un sistema "Zero Touch" (Cero Interacción) para los nodos de visualización.
**Comportamiento deseado**:
1. Se da la corriente general de la fábrica.
2. El ordenador se enciende automáticamente.
3. Inicia sesión en Windows automáticamente.
4. Abre la aplicación web a pantalla completa (Kiosko) automáticamente.

---

## Requisitos
- **Sistema Operativo**: Windows 11 Pro (Recomendado para gestión avanzada de políticas y modo kiosco nativo si fuera necesario, aunque este método "casero" funciona en Home, Pro permite mejor control de actualizaciones y GPO).
- **Hardware**: Mini PC con soporte para "AC Power Loss" en BIOS.

## Guía Paso a Paso
windows11 pro


### Paso 1: Arranque Automático al recibir corriente (BIOS)
Recuperación automática tras corte de luz o apagado general.

1. Encender el PC y entrar en la **BIOS** (pulsando `Supr`, `Del` o `F2` durante el arranque).
2. Buscar la opción: **"Restore on AC Power Loss"**, **"State After Power Failure"** o similar (suele estar en *Chipset* o *Power Management*).
3. Cambiar el valor a: **"Power On"** (Encender).
4. Guardar cambios y salir (`F10`).

### Paso 2: Auto-Login (Entrar sin contraseña)
Evitar la pantalla de bloqueo de Windows.

1. Crear un usuario local (ej: "Operario") o usar el existente.
2. Pulsar `Tecla Windows + R`.
3. Escribir `netplwiz` y pulsar `Enter`.
4. **Desmarcar** la casilla: *"Los usuarios deben escribir su nombre y contraseña para usar el equipo"*.
5. Clic en "Aplicar".
6. Introducir la contraseña del usuario actual para confirmar.

### Paso 3: Modo Kiosco "Casero" (Startup Script)
Usaremos un acceso directo modificado de Chrome/Edge en la carpeta de inicio para mayor flexibilidad y facilidad de mantenimiento.

1. Instalar Google Chrome (o Edge).
2. Crear un **Acceso Directo** de Chrome en el escritorio.
3. Clic derecho en el acceso directo -> **Propiedades**.
4. En el campo **"Destino"**, añadir al final de la ruta (fuera de las comillas):
   ```text
   --kiosk --incognito "https://tu-aplicacion-web.com/visor?mesa=X"
   ```
   *(Sustituir `mesa=X` por el ID de la mesa correspondiente: 1, 2, 3...)*

   **Explicación de flags**:
   - `--kiosk`: Pantalla completa real (sin bordes, sin cierre).
   - `--incognito`: Evita cacheo agresivo y mensajes de "Restaurar sesión" tras cortes de luz.

### Paso 4: Ejecución al Inicio
1. Pulsar `Tecla Windows + R`.
2. Escribir `shell:startup` y pulsar `Enter`.
3. Se abrirá la carpeta de Inicio del usuario.
4. **Arrastrar el acceso directo** modificado (del Paso 3) dentro de esta carpeta.

### Paso 5: Evitar Suspensión (Energía)
Evitar que la pantalla se apague por inactividad.

1. Ir a **Configuración de Windows** -> **Sistema** -> **Inicio/Apagado y suspensión**.
2. Configurar todas las opciones (Pantalla y Suspender) en: **"Nunca"**.

---

## Mantenimiento Remoto (Regla de Oro)
Para evitar subir al poste con escalera para cambios de configuración.

**Herramienta recomendada**: RustDesk, AnyDesk o Chrome Remote Desktop.
1. Instalar en cada Mini PC **antes** de colocarlo en el poste.
2. Configurar **"Acceso Desatendido"** (Unattended Access) con una contraseña fija y segura.
3. Verificar acceso desde el Laptop del Supervisor.
