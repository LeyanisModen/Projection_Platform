# Task List - Proyección Moden Dashboard

## Setup & Environment
- [x] **Initialize Project** <!-- id: 0 -->
    - [x] Verify existing repo structure (`app_proyeccion_moden`, `api_proyeccion_moden`) <!-- id: 1 -->
    - [x] Configure Docker environment (`docker-compose.yml`) <!-- id: 2 -->
    - [x] Setup Git (branch `V1`) <!-- id: 3 -->

## Project Documentation
- [x] **Establish Engineering Manifesto** <!-- id: 22 -->
    - [x] Create `rules.md` from `Rules.txt` <!-- id: 23 -->
    - [x] Commit rules to repo <!-- id: 24 -->
- [x] **Establish Tech Stack Rules** <!-- id: 25 -->
    - [x] Create `language_rules.md` from `# Reglas específicas...` <!-- id: 26 -->
    - [x] Commit language rules to repo <!-- id: 27 -->

## Dashboard Refactor (Drag-Drop & Style)
- [x] **Refactor Drag-Drop Images** <!-- id: 4 -->
    - [x] Update Dashboard HTML (expandable modules, image items) <!-- id: 5 -->
    - [x] Update Dashboard TS (drag start/end, single drop zone logic) <!-- id: 6 -->
    - [x] Verify drag-and-drop functionality <!-- id: 7 -->
- [x] **UI/UX Improvements** <!-- id: 8 -->
    - [x] Add image names (INF-001...) <!-- id: 9 -->
    - [x] Apply Light Theme (Login Style) <!-- id: 10 -->
    - [x] Fix API 404/403 errors (register endpoints, verify permissions) <!-- id: 11 -->

## Backend
- [x] **Database Models** <!-- id: 12 -->
    - [x] Add `nombre` field logic to `Imagen` via serializer <!-- id: 13 -->
    - [x] Ensure `MesaQueueItem` model supports new drag-drop flow <!-- id: 14 -->
- [x] **API Endpoints** <!-- id: 15 -->
    - [x] Register `mesa-queue-items` in main `urls.py` <!-- id: 16 -->
    - [x] Set permissions to `AllowAny` for internal demo use <!-- id: 17 -->

## Verification
- [x] **Visual Check** <!-- id: 18 -->
    - [x] Verify Light Theme colors <!-- id: 19 -->
    - [x] Verify Image Names display <!-- id: 20 -->
    - [x] Verify Drop Zone appearance <!-- id: 21 -->

---
# PLAN UNIFICADO (para Antigravity) — MOD:EN Industrial + SaaS Multi-tenant
(Combinación de los pasos propuestos + Gemini, sin duplicidades y con orden claro)

CONTEXTO / OBJETIVO
Ya tenemos gran parte del flujo (proyectos/módulos/mesas/colas) implementado. 
Ahora toca “industrializar” y “productizar” como SaaS multi-cliente:

- SaaS multi-tenant: múltiples ferrallas aisladas (Organización).
- INAK (super-admin) puede crear organizaciones, subir proyectos y asignarlos.
- Supervisor (cliente) solo ve su organización y sus proyectos asignados.
- Cada mesa (device) es un mini-PC Windows en modo kiosko conectado por HDMI al proyector.
- El mini-PC no lleva URLs secretas fijas: se empareja con “pairing code” y recibe un device_token revocable.
- El operario controla la cola con botonera industrial (3 botones) vía USB HID (teclado).
- Heartbeat (player → servidor) para online/offline + estado + errores.
- Panel INAK (NOC) para supervisar todas las organizaciones/mesas; snapshots opcionales.
- Mapper/calibración por mesa persistente y protegido por rol.
- Seguridad: RBAC, token revocable, imágenes privadas, headers/OWASP.

REGLAS PARA TI (ANTIGRAVITY)
- Implementa por fases incrementales: cada fase debe dejar algo real funcionando.
- Evita sobreingeniería: primero polling + heartbeat; websockets solo si duele.
- No casting/mirroring: el proyector muestra HDMI; el cliente real es el Player.
- Seguridad realista: device token revocable, RBAC, imágenes privadas (no públicas).

────────────────────────────────────────────────────────────
FASE 0 — BASE SaaS / MULTI-TENANCY (Organización)  ✅ (PRIMERA PRIORIDAD)
Objetivo: aislar ferrallas y permitir que INAK administre todas.

Backend (Django/DRF):
- [ ] 1) Nuevo modelo `Organizacion`
   - nombre, slug, logo (opcional), config_json (opcional), is_active
- [ ] 2) Asociaciones:
   - `UserProfile` (o extensión de User) -> FK a `Organizacion`
   - `Proyecto` -> FK a `Organizacion`
   - `Mesa` -> FK a `Organizacion`
   - (Opcional) `Modulo` -> FK indirecta via Proyecto (no duplicar si no hace falta)
- [ ] 3) RBAC (roles):
   - SUPERADMIN (INAK): ve todo, crea organizaciones, reasigna proyectos, revoca devices.
   - SUPERVISOR (cliente): solo ve proyectos/módulos/mesas de su organización.
   - DEVICE (mesa): solo su mesa (autenticado por token).
- [ ] 4) Enforcements:
   - Filtrado por organizacion en querysets (todas las vistas/serializers).
   - Validación server-side de pertenencia (no confiar en front).

Frontend (Dashboard):
- [ ] - Al loguear, cargar `organizacion_actual` y filtrar datos.
- [ ] - INAK: selector/listado de organizaciones + vista global.

Criterio de éxito:
- Un supervisor solo puede ver su organización.
- INAK puede ver todas y crear una nueva.

────────────────────────────────────────────────────────────
FASE 1 — DEVICE BINDING / PAIRING (sin URL secreta fija)
Objetivo: emparejar mini-PC con mesa de forma segura y revocable.

Modelo Mesa (extensión):
- device_id (uuid/unique)
- device_token_hash (guardar hash, NO token en claro)
- last_seen_at (datetime)
- player_version (string opcional)
- mode (NORMAL/BLACKOUT/CALIBRATING/ERROR) opcional
- last_error (text opcional)
- status (ONLINE/OFFLINE/ERROR) derivado o campo + derivación
- organizacion_id FK (de fase 0)

Backend endpoints (Django/DRF):
- [ ] A) POST /api/device/pair/request
   - Crea pairing_code (alfanumérico tipo X78-99 o 6-8 chars) + expires_at
   - Asociado a organizacion (importante)
   - Devuelve pairing_code + expires_at
- [ ] B) GET /api/device/pair/status?code=XXXX
   - Para que el device haga polling (unpaired flow)
   - Devuelve: pending/confirmed
- [ ] C) POST /api/device/pair/confirm
   - Input: pairing_code + mesa_id
   - Auth: Supervisor o INAK (y debe pertenecer a esa organizacion)
   - Output: device_token (una sola vez)
   - Asocia mesa <-> device_id y guarda device_token_hash
- [ ] D) POST /api/device/auth/heartbeat
   - Header: Authorization: Bearer <device_token>
   - Body: current_item, queue_len, mode, player_version, last_error
   - Actualiza last_seen_at/status
- [ ] E) POST /api/mesas/:id/device/revoke
   - Admin/INAK: invalida token (revocación inmediata)

Frontend (Player):
- [ ] 1) Si NO hay token local:
   - Pantalla negra con pairing_code grande (ej: “X78-99”)
   - Polling a /api/device/pair/status
- [ ] 2) Cuando está confirmado:
   - Recibe token, lo guarda, entra en modo proyección.

Frontend (Dashboard Supervisor):
- [ ] - Sección Mesas:
  - “Añadir Mesa” → introducir código X78-99 → seleccionar mesa → confirmar.

Criterio de éxito:
- Emparejo device con mesa desde el dashboard de su organización.
- Puedo revocar token y el player deja de funcionar hasta re-pair.

────────────────────────────────────────────────────────────
FASE 2 — WINDOWS KIOSK (operativo real)
Objetivo: que el mini-PC arranque solo y abra siempre el Player.

Entregables:
- [ ] 1) Documento “Windows 11 Pro Kiosk Setup”
   - BIOS: Restore on AC Power Loss
   - Windows: usuario kiosko + auto-login
   - Assigned Access: Edge kiosk -> https://app/player
   - Bloqueos recomendados (teclas, acceso a escritorio)
   - Watchdog (si Edge se cierra, relanzar)
- [ ] 2) Player:
   - /player como entrypoint (kiosk)
   - Si unpaired -> pantalla pairing
   - Si token -> /player/mesa (vista normal)

Criterio de éxito:
- Corto luz, vuelve luz, arranca y proyecta sin intervención.

────────────────────────────────────────────────────────────
FASE 3 — BOTONERA INDUSTRIAL (USB HID) + CONFIRMACIONES + FEEDBACK
Objetivo: operario controla sin ratón/teclado. Robusto a rebotes.

Suposición:
- Botonera industrial 3 botones conectada a encoder USB HID (teclado)
- Mapeo:
  - ArrowRight = Siguiente
  - ArrowLeft = Anterior
  - B o Space = Blackout / Confirmar

Player (Angular):
- [ ] 1) Captura centralizada de teclado (servicio):
   - Debounce 200–300ms obligatorio
   - Right -> next()
   - Left -> prev()
   - B/Space -> toggleBlackout() o confirm()
- [ ] 2) Finalización segura (anti-misclick):
   - Opción A (Long Press):
     - Mantener pulsado Right 2–3s -> inicia confirmación con barra de progreso
     - Al completar, muestra overlay: “PULSA B PARA CONFIRMAR (3s)”
   - Opción B (Double press):
     - Primer intento -> overlay “¿TERMINADO? PULSA OTRA VEZ”
     - Segundo en 3s -> marca HECHO
- [ ] 3) Feedback visible SIEMPRE:
   - Al pulsar botón: icono/flash “RECIBIDO”
   - Al blackout: “BLACKOUT ON”
   - Al finalizar: “HECHO ✅” pantalla grande

Backend:
- [ ] - Endpoint para marcar HECHO:
  - PATCH /api/mesas/:id/queue/items/:item_id/status { status: HECHO }

Criterio de éxito:
- Botonera navega, blackout y finaliza con confirmación visible sin falsos positivos.

────────────────────────────────────────────────────────────
FASE 4 — HEARTBEAT + PANEL INAK (NOC) + “ESPEJO DE DATOS”
Objetivo: supervisión global, sin vídeo, con diagnóstico.

Backend:
- [ ] 1) Heartbeat (ya en fase 1):
   - online si last_seen_at < now - 20s (ajustable)
- [ ] 2) GET /api/admin/monitoring/mesas
   - Para INAK: devuelve por organizacion:
     - mesa_id, nombre, organizacion, is_online, last_seen_at
     - current_item (modulo/fase/imagen), queue_len
     - mode (normal/blackout/calibrating/error)
     - last_error, player_version
- [ ] 3) “Espejo de datos”:
   - Mostrar miniatura/ID de la imagen que el device dice estar proyectando (no streaming)

Frontend (INAK Admin):
- [ ] - Vista Monitoring:
  - Filtros por organización
  - Indicadores online/offline
  - Qué se proyecta y cola
  - Errores
  - Acciones rápidas: revoke token, (opcional) “reload player”

Criterio de éxito:
- INAK sabe qué mesa está caída y qué estaba mostrando.

────────────────────────────────────────────────────────────
FASE 5 — SNAPSHOT BAJO DEMANDA (opcional, recomendado)
Objetivo: ver lo renderizado sin streaming pesado.

Recomendación técnica:
- Render del plano en CANVAS (por homografía/mapper).
- Snapshot: canvas.toBlob() (ej 640x360) + upload.

Implementación:
- [ ] 1) POST /api/admin/mesas/:id/snapshot/request
   - crea request pendiente (DB o Redis)
- [ ] 2) Player detecta request (polling o WS futuro):
   - genera snapshot y sube:
   - POST /api/mesas/:id/snapshot/upload (auth device_token)
- [ ] 3) INAK UI:
   - muestra última captura con timestamp.

Criterio:
- INAK pide captura y la ve en segundos.

────────────────────────────────────────────────────────────
FASE 6 — MAPPER / CALIBRACIÓN (4 puntos) PERSISTENTE POR MESA
Objetivo: calibración robusta, protegida por rol y operable en taller (uso periódico 1–2 veces/mes).

Contexto operativo:
- La calibración se realizará típicamente 1–2 veces al mes (o cuando se mueva el proyector/mesa).
- El supervisor debe poder ACTIVAR/DESACTIVAR la “malla calibradora” (mapper grid) que se proyecta, para calibrar y luego volver a producción normal.

Backend:
- [ ] 1) Persistencia de calibración
- mesa.calibration_json (homografía / 4 puntos)
- mesa.calibration_updated_at (datetime)
- mesa.calibration_updated_by (user_id opcional)

- [ ] 2) Control de estado del mapper (grid)
- mesa.mapper_enabled (bool)  // indica si la malla está visible en proyección
- (opcional) mesa.mode = NORMAL | CALIBRATING | BLACKOUT

- [ ] 3) Endpoints
- GET/PUT /api/mesas/:id/calibration           (solo supervisor/técnico)
- POST /api/mesas/:id/mapper/enable            (solo supervisor/técnico)
- POST /api/mesas/:id/mapper/disable           (solo supervisor/técnico)
  (alternativa: PATCH /api/mesas/:id { mapper_enabled: true/false })

- [ ] 4) Auditoría mínima (recomendado)
- Log de cambios de calibración y toggles mapper (quién, cuándo, mesa).

Player:
- [ ] 1) Modo calibración
- Overlay rejilla (malla calibradora) + handles 4 puntos
- Ajuste de esquinas y guardado en backend

- [ ] 2) Activar/Desactivar malla (control supervisor)
- Si mesa.mapper_enabled = true → mostrar la malla por encima del plano (o plano + grid)
- Si mesa.mapper_enabled = false → ocultar malla y volver a vista normal

- [ ] 3) Protección por rol/permiso
- El operario NO puede activar calibración ni cambiar puntos.
- Solo supervisor/técnico pueden:
  - activar/desactivar malla
  - guardar nueva calibración

- [ ] 4) UX recomendada
- Indicador grande visible cuando mapper está activo: “MODO CALIBRACIÓN”
- Botón claro en dashboard supervisor: “Mostrar malla / Ocultar malla”
- Al guardar calibración: feedback gigante “CALIBRACIÓN GUARDADA ✅”

Criterio de éxito:
- Cada mesa mantiene su calibración tras reinicios.
- El supervisor puede mostrar/ocultar la malla calibradora en el proyector cuando toque recalibrar (1–2 veces/mes) sin afectar al resto del sistema.


────────────────────────────────────────────────────────────
FASE 7 — HARDENING / SEGURIDAD EXTRA (sin romper MVP)
- [ ] - HTTPS + HSTS + headers + CSP
- [ ] - CORS estricto
- [ ] - Imágenes privadas: signed URLs / proxy backend
- [ ] - Rate limiting (login, pairing, endpoints críticos)
- [ ] - Auditoría: asignaciones, finalizaciones, calibración, blackout, revocaciones
- [ ] - Gestión de secretos (env/secrets), separación dev/staging/prod

────────────────────────────────────────────────────────────
ORDEN RECOMENDADO (para no atascarse)
0) Multi-tenant / Organización + RBAC
1) Pairing device token revocable
2) Windows Kiosk operativo
3) Botonera + confirmaciones + feedback
4) Heartbeat + Panel INAK
5) Snapshot bajo demanda (si queréis diagnóstico real)
6) Mapper persistente
7) Hardening extra

NOTAS IMPORTANTES
- Mantener polling al inicio (3–5s en player). WebSockets después.
- La “verdad” de lo proyectado debe estar en DB: cola por mesa + current item.
- Evitar URLs secretas permanentes; usar device tokens revocables.
- Debounce en input físico siempre (ferralla).

---
# DETAILED IMPLEMENTATION SPECS (Models, Permissions, Endpoints)
(Added 2026-01-20)

## CONTEXTO
Ya tenemos gran parte del flujo (proyectos/módulos/mesas/colas) implementado.
Ahora necesitamos capa “SaaS multi-ferralla” + gestión de contenido (INAK) + UX clave para operativa real.

## OBJETIVO
Implementar:
1) Multi-tenancy por Organización (Ferrallas)
2) Roles y permisos (INAK vs Supervisor; DEVICE token separado)
3) Asignación de proyectos a organización
4) Gestión de plantas/módulos/imágenes con subida de ficheros (privados)
5) Estado de publicación de planos (DRAFT/PUBLISHED/ARCHIVED)
6) Usabilidad: preview de imágenes, filtros/búsqueda, reordenar colas, deshacer asignación
7) Auditoría/log de actividad (quién asignó/completó y cuándo)
8) Notificaciones/alertas de estado (toasts y mesa inactiva)
9) (Opcional) WebSockets para “tiempo real” cuando el MVP sea estable

## REGLAS
- Permisos SIEMPRE server-side (backend).
- Todo filtrado por organización para supervisor.
- Imágenes NO públicas.
- Implementación incremental: al final de cada fase algo usable.
- Evitar sobreingeniería: polling primero, WebSockets después si hace falta.

────────────────────────────────────────────────────────────
## FASE A — MODELOS (DB) Y RELACIONES (Django)

1) Modelo `Organizacion`
- id, nombre, slug único, logo_url opcional, is_active, created_at

2) Asociar usuarios a organización
- `UserProfile` (OneToOne auth_user):
  - organizacion (FK, nullable para INAK global)
  - role: INAK_ADMIN | SUPERVISOR
  - is_active

3) Proyectos asignados a organización (simple, 1 proyecto = 1 ferralla)
- `Proyecto.organizacion_id` (FK obligatoria cuando asignado)
- INAK crea proyecto y asigna poniendo organizacion_id

4) Jerarquía:
- Proyecto -> Planta -> Modulo -> ModuloImagen
- Planta.proyecto_id
- Modulo.planta_id
- ModuloImagen.modulo_id

5) Imágenes/Planos por módulo: `ModuloImagen`
- fase: INFERIOR | SUPERIOR
- archivo (storage privado) o url privada
- status: DRAFT | PUBLISHED | ARCHIVED
- version (int)
- created_at, uploaded_by

6) Auditoría / Log (NUEVO)
Crear tabla `ActivityLog` (o similar):
- organizacion_id
- actor_user_id (nullable para device)
- actor_type: USER | DEVICE
- action_type: ASSIGN_TO_MESA | UNASSIGN | REORDER_QUEUE | MARK_DONE | PUBLISH_IMAGE | UPDATE_CALIBRATION | BLACKOUT_TOGGLE
- target_type/target_id (proyecto/modulo/mesa/queue_item/imagen)
- metadata JSON (detalles: mesa_id, modulo_id, fase, etc.)
- created_at

7) (Opcional) Mesa “inactividad”
- mesa.last_activity_at (se actualiza al avanzar/mark_done)
- sirve para alertar “mesa sin actividad X minutos”

────────────────────────────────────────────────────────────
## FASE B — PERMISOS Y FILTRADO MULTI-TENANT (Backend DRF)

- INAK_ADMIN: acceso global (organizaciones, usuarios, proyectos, imágenes, asignaciones).
- SUPERVISOR: solo su organización:
  - ve proyectos/plantas/modulos
  - ve SOLO imágenes PUBLISHED
  - gestiona colas/mesas de su organización
- DEVICE (player): autenticado por device_token, solo puede actuar sobre su mesa.

Reglas:
- Todos los endpoints de contenido filtran por organización en queryset.
- Nunca confiar en frontend para permisos.
- Guardar logs en ActivityLog para acciones importantes.

────────────────────────────────────────────────────────────
## FASE C — ENDPOINTS (DRF) A IMPLEMENTAR

Organizaciones (solo INAK):
- GET/POST /api/admin/organizaciones
- PATCH/DELETE /api/admin/organizaciones/:id

Usuarios (solo INAK):
- POST /api/admin/usuarios (crear supervisor + asignar organizacion + role)
- GET /api/admin/usuarios?organizacion_id=...
- PATCH /api/admin/usuarios/:id (activar/desactivar, cambiar rol/organizacion)

Proyectos/Plantas/Modulos (INAK CRUD; supervisor lectura filtrada):
- GET /api/proyectos (supervisor solo su org)
- POST/PATCH /api/admin/proyectos
- PATCH /api/admin/proyectos/:id { organizacion_id: X }  (asignación)
- GET/POST /api/admin/proyectos/:id/plantas
- GET/POST /api/admin/plantas/:id/modulos
- GET /api/plantas/:id/modulos  (supervisor)

Imágenes/Planos:
- POST /api/admin/modulos/:id/imagenes (subida -> DRAFT por defecto)
- PATCH /api/admin/imagenes/:id (publicar/archivar)