# MOD:EN — MANIFIESTO / VISIÓN FUNCIONAL

> **Nota para Antigravity:** Este documento define la visión funcional y las reglas del juego. Son pautas para orientar el desarrollo, no tareas cerradas. Priorizar siempre: **estabilidad en taller + simplicidad operativa + escalabilidad**.

---

## 1. VISIÓN GENERAL
Queremos una aplicación web para ferrallas donde se gestionen y proyecten planos (en formato imagen) sobre mesas de trabajo mediante proyectores. La prioridad es que sea **FUNCIONAL y USABLE en taller**: que un supervisor pueda asignar rápidamente trabajos a mesas y que los operarios puedan avanzar entre imágenes con una botonera industrial, sin tocar ordenador.

Cada ferralla tiene varias mesas de producción. Cada mesa tendrá su propio proyector y un mini-PC fanless dedicado (o dispositivo equivalente) conectado al proyector. Ese mini-PC ejecutará un “Player” (web en modo kiosko) que mostrará la imagen asignada a esa mesa.

## 2. ARQUITECTURA DE TRABAJO (DASHBOARD vs PLAYER)
Hay dos experiencias distintas:

### A) Dashboard (Supervisor/gestión)
- Acceso normal (login) a la web.
- Ve proyectos y sus módulos pendientes/en proceso/finalizados.
- Selecciona un proyecto y un módulo, y ve los trabajos asociados.
- Asigna trabajos a mesas mediante **drag & drop**.
- Puede reordenar la cola de una mesa, vaciarla, pausar/bloquear mesa, y confirmar finalizaciones.

### B) Player (Mesa/proyección)
- Cada mesa tiene una URL fija (por ejemplo: `/player/mesa/07`) que se abre en pantalla completa (kiosko) en el mini-PC de esa mesa.
- El Player muestra el trabajo actual (imagen) y permite navegar por la cola (siguiente/anterior).
- El Player también ofrece modo calibración (mapper) y modo ocultar/imagen negra.
- El operario no necesita ratón/teclado: usa **botonera industrial**.

## 3. CONCEPTO CLAVE: NO ES UN KANBAN (TO DO / DONE)
El tablero visual tipo “To Do / Done” es solo una metáfora inicial de UI. En realidad esto es un **TABLERO DE ASIGNACIÓN**:
- **Biblioteca (origen):** trabajos disponibles (módulos/fases/planos).
- **Destinos:** mesas (cada mesa con su cola).
- **Drag & Drop:** arrastrar un trabajo a una mesa = encolar ese trabajo en esa mesa.

Si existe “Done”, debe entenderse como “Histórico/recientes/completados”, no como estado único del sistema.

## 4. MODELO DE PRODUCCIÓN: MÓDULO CON DOS FASES
Cada módulo del proyecto se fabrica en dos fases (por ejemplo: **parte inferior** y **parte superior**). La aplicación debe permitir que el supervisor decida el orden de fabricación (ej. fabricar hoy todas las inferiores, mañana las superiores) sin marcar los módulos como finalizados prematuramente.

**Modelo mental recomendado:**
- **IMAGEN (asset):** archivo imagen del plano.
- **WORK ITEM (trabajo):** “Módulo X — Fase inferior” y “Módulo X — Fase superior”. Cada work item referencia su imagen correspondiente y tiene su propio estado.
- **COLA POR MESA:** una lista ordenada de work items asignados a esa mesa.

## 5. REGLAS DE FINALIZACIÓN Y CIERRE
- Un módulo **NO** se considera finalizado por haber fabricado solo una fase.
- Un módulo queda “COMPLETADO” cuando:
  - Fase inferior = hecha
  - Fase superior = hecha
- Debe existir una acción del supervisor para **“VALIDAR/CERRAR”** el módulo.
- **Retención:** No se borran imágenes inmediatamente. Se aplicará política de retención (30/60/90 días).

## 6. HARDWARE Y MONTAJE EN CADA MESA
![Esquema Práctico de Montaje](C:/Users/Jon/.gemini/antigravity/brain/b0879cd9-7d8c-46d2-9b90-9c5014e19554/uploaded_image_1768553042796.png)

Para evitar cables largos y mantener estabilidad:
- Proyector Epson en la estructura de la mesa (Actúa como pantalla HDMI tonta).
- Mini PC fanless conectado por HDMI corto al proyector.
- Mini PC conectado por Wi-Fi/Ethernet a la red y a la web.
- Botonera industrial conectada al mini PC.

## 7. BOTONERA INDUSTRIAL
Permite operar el Player sin ratón. Se comporta como teclado USB HID:
- **Siguiente** (ArrowRight/Enter)
- **Anterior** (ArrowLeft)
- **Detener / Imagen negra** (B)
- **(Opcional)** Marcar “Trabajo finalizado”

## 8. MAPPER / CALIBRACIÓN POR MESA
Pieza clave para que la imagen encaje con la malla real (ajuste por 4 puntos / homografía).
- El Player tendrá un “modo calibración” (protegido por rol).
- Guarda la calibración asociada a esa mesa específica.

## 9. ESTABILIDAD EN TALLER (OFFLINE-FIRST)
El Player debe ser resiliente (PWA / Service Workers):
- Si cae la conexión, **mantiene el último plano visible**.
- Cachea el plano actual (y opcionalmente el siguiente).
- Indicador claro si está offline.

## 10. ESTADO DE MESAS (OPERACIÓN)
El Dashboard debe mostrar:
- Mesas online/offline (heartbeat).
- Última comunicación y qué trabajo muestra.
- Estado (blackout, calibración, etc.).

## 11. SEGURIDAD REALISTA
- **Roles:** Operario / Supervisor / Admin.
- **Device Binding:** Token único por mini-PC/mesa.
- **IP Protection:** No servir imágenes públicas. Usar Signed URLs o proxy.
- **Watermark dinámico:** Obra + Mesa + Fecha.
- **Auditoría:** Registro de asignaciones y acciones.

## 12. IDEAS EXTRA IMPORTANTES
- **Bloquear mesa:** Para evitar cambios accidentales.
- **Reordenar cola:** Drag & drop en la lista de la mesa.
- **Modo “lote”:** Filtros para asignar masivamente (ej. solo inferiores).

## 13. CRITERIOS DE ÉXITO
- Asignación rápida por supervisor.
- Operación sin PC por operario.
- Estabilidad ante microcortes.
- Calibración fácil y segura.

## 14. NOTAS DE MODELO
- Mesas pertenecen a Ferralla (físico). Trabajos pertenecen a Proyectos (lógico).
- Estados Work Item: EN_COLA → MOSTRANDO → HECHO → VALIDADO.
- Control de versiones en planos.

---

# ADDENDUM — IDEAS ADICIONALES
- **Augmented Reality simple:** Proyección 1:1 eliminando papel.
- **Diseño Visor:** Fondo negro absoluto, alto contraste, UI mínima.
- **PWA:** Service Workers para modo offline.

---

# ADDENDUM — CIBERSEGURIDAD
*(Guía de seguridad práctica: Secure by Default)*

1.  **SECURE BY DEFAULT:** Denegar por defecto. Minimizar superficie.
2.  **IDENTIDAD:** Autenticación robusta. Sesiones seguras (HttpOnly, Secure).
3.  **AUTORIZACIÓN (RBAC):** Validación de permisos siempre en backend.
4.  **DEVICE BINDING:** Token de dispositivo para Players. Revocable.
5.  **PROTECCIÓN DE IMÁGENES:** Sin descarga directa. URLs firmadas. Cifrado en tránsito y reposo.
6.  **VALIDACIÓN:** Sanear entradas, subida de archivos segura (validar MIME).
7.  **CABECERAS:** HTTPS obligatorio, CSP, HSTS.
8.  **LOGGING:** Auditoría funcional y técnica.
9.  **SECRETOS:** Variables de entorno, no hardcoded.
10. **DEPENDENCIAS:** Escaneo de vulnerabilidades.
11. **DISPONIBILIDAD:** Rate limiting, timeouts.
12. **PRUEBAS:** Checklist OWASP básico.
13. **MENOR PRIVILEGIO:** MiniPC en modo kiosko, usuario limitado.
