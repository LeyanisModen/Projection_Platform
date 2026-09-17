# Auditoría técnica — septiembre 2026

Fecha de auditoría: **17 de septiembre de 2026**
Base auditada: `develop` @ `9952047` (`feat: sombrear vacaciones y ajustar titulos del calendario`)
Alcance: backend Django, frontend Angular, capture service, despliegue Railway, docs.

Este documento es la lista de trabajo derivada de la auditoría. Cada punto lleva
su estado; cuando se cierra uno se marca aquí y, si cambia el comportamiento del
sistema, se refleja también en `docs/07_traspaso_estado_actual.md`.

Regla de oro para todos los arreglos: **nada deja de funcionar como funciona
hoy**. Si una mejora rompe un flujo real (player, visor, dashboard, importación),
se busca otra variante o se descarta.

Leyenda de estado: `[ ]` pendiente · `[~]` en curso · `[x]` cerrado · `[-]` descartado (con motivo)

## Estado verificado al iniciar

| Comprobación | Resultado |
| --- | --- |
| Tests backend (`manage.py test`, SQLite) | 169 OK |
| Tests frontend (`ng test`) | 113 OK en 16 ficheros |
| Tests capture service (`unittest`) | 32 OK |
| Build Angular producción | OK, 2 warnings de presupuesto |
| Bundle inicial | 681,89 kB raw / 159 kB transferidos |
| `manage.py check --deploy` | 5 warnings (W004, W008, W009, W012, W016) |
| `develop` vs `origin/deploy` | Sin diferencias de contenido |

---

## 1. Seguridad

### 1.1 `/media/` se sirve sin autenticación — `[x]`

- **Dónde:** `api_proyeccion_moden/proyeccion_moden/urls.py` (`re_path` a `django.views.static.serve`), `app_proyeccion_moden/nginx.conf` (`location ^~ /media/`).
- **Problema:** las rutas son adivinables (`/media/imagenes/{proyecto}/{modulo}/…`, `/media/fotos/{proyecto}/{modulo}/…`) y cualquiera sin sesión las lee. El aislamiento por ferralla de la API no aplica aquí. `serve` además no está pensado para producción.
- **Restricción:** las imágenes se cargan con `<img src>` y `new Image()`, que no pueden enviar cabecera `Authorization`. La solución no puede cambiar las URLs almacenadas en BD (`Imagen.url`, `FotoFabricacion.url` guardan `/media/...` relativo).
- **Plan:** vista de media propia que acepte (a) token de usuario DRF, (b) token de dispositivo de mesa, ambos vía cookie same-origin que el frontend fija al hacer login / al emparejar, además de `Authorization`. Aplicar la misma regla de propietario que `ImagenViewSet`/`FotoFabricacionViewSet` para `imagenes/`, `fotos/`, `planos/`, `documentos/`, `datos_tecnicos/`. Los dispositivos (mesas) pueden leer cualquier media que el planner les asigne. Devolver los `FileField` como URL relativa para que todo pase por nginx y lleve la cookie.
- **Hecho en código (2026-09-17):** `api/media_access.py` sustituye a `django.views.static.serve` directo. Acepta `Authorization: Token …` (usuario), `Authorization: Bearer …` (mesa) y las cookies same-origin `moden_auth` / `moden_device` con `path=/media/`. Las cookies las escribe el backend: el login (`/api/token-auth/`) y `MediaCookieMiddleware` en cualquier respuesta autenticada (usuario o dispositivo), solo cuando falta o cambió. `logout()` del frontend borra `moden_auth`. Reglas: staff → todo; ferralla → `imagenes/<pid>`, `fotos/<pid>` y `planos/`, `documentos/`, `datos_tecnicos/` de sus proyectos; mesa emparejada → todo lo que le asigne el planner; `cortes/` (legado) solo staff. Los `FileField` de proyecto se devuelven como ruta relativa para que el PDF/ZIP pase por nginx y lleve la cookie. **Interruptor de emergencia:** `MEDIA_REQUIRE_AUTH=False` en Railway devuelve el comportamiento público anterior sin redeploy de código. 16 tests en `api/test_media_access.py`.
- **Verificado en staging (17/09/2026):** con sesión real de administración, el previsualizador de secuencia del detalle carga las 19 imágenes del módulo (0 fallidas, sin el mensaje "El archivo no se puede abrir"); `fetch` de una imagen del proyecto devuelve 200 `image/jpeg` con `Cache-Control: private`. Sin credencial, `/media/` responde 401.
- **Los 404 que se vieron al principio no venían de este cambio:** la BD de staging es copia de producción pero el volumen nunca tuvo las imágenes de los proyectos 66/67/69/70 (0 de 1548 en disco). Solo el proyecto 73 tenía sus ficheros. Se depuró staging (ver más abajo).
- **Pendiente de una pasada manual:** player proyectando tras reinicio del kiosk y modal de fotos (staging no tiene fotos de fabricación históricas).

### 1.2 Token de dispositivo en crudo dentro de `mesa.last_error` — `[x]`

- **Dónde:** `views.py` `DeviceViewSet.pair` (`PENDING_TOKEN:<raw>`), `status`, `_authenticate_device`.
- **Problema:** un secreto en un campo de errores. Hoy no se filtra (el serializer no expone `last_error`), pero cualquier log/admin futuro lo sacaría.
- **Hecho (2026-09-17):** campo `Mesa.pending_device_token` (migración `0056`, que además traslada cualquier `PENDING_TOKEN:` en vuelo). `last_error` vuelve a ser solo un campo de errores. Mismo comportamiento para el mini-PC: `/device/status` sigue devolviendo el token hasta la primera petición autenticada.

### 1.3 `CSRF_TRUSTED_ORIGINS` con wildcard `https://*.railway.app` — `[x]`

- **Dónde:** `settings.py`.
- **Problema:** confía en cualquier app de Railway. La API con `TokenAuthentication` está exenta de CSRF; el riesgo real es `/admin/` (sesión).
- **Hecho (2026-09-17):** solo dominios concretos (producción + staging), sobreescribibles con la variable `CSRF_TRUSTED_ORIGINS` (lista separada por comas).

### 1.4 `scripts/django/ensure_admin.py` resetea el superusuario a `admin` — `[x]`

- **Hecho (2026-09-17):** aborta con `exit 1` si `DJANGO_SUPERUSER_PASSWORD` no está definida.

### 1.5 Cabeceras/cookies seguras (`check --deploy`) — `[x]`

- **Hecho (2026-09-17):** `HTTPS_ONLY` se activa solo cuando Railway inyecta `RAILWAY_ENVIRONMENT_NAME` (o con la variable `HTTPS_ONLY=True`); con él van `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE` y `SECURE_HSTS_SECONDS=3600`. `SECURE_CONTENT_TYPE_NOSNIFF` siempre. `SECURE_SSL_REDIRECT` queda **deliberadamente apagado**: nginx reenvía `X-Forwarded-Proto=http` por la red privada y provocaría bucle; Railway ya fuerza HTTPS en el borde. W009 solo aplica al fallback local.

### 1.6 Capture service: control asimétrico — `[x]`

- **Dónde:** `capture_service.py` `_is_control_request_allowed`, `do_GET /device_token`, `_cors`.
- **Problema:** `/close_browser` y `/shutdown_pc` pasan si **no** hay cabecera `Origin`; `GET /device_token` responde con `Access-Control-Allow-Origin: *` sin ninguna validación.
- **Hecho (2026-09-17, capture service `2026-09-17.1`):** `/close_browser` y `/shutdown_pc` exigen `Origin` en la allowlist **y** `X-Moden-Action`. `GET/POST /device_token` responde 403 a orígenes desconocidos y refleja el `Origin` permitido en CORS (sin `*`); sin cabecera `Origin` (curl local) sigue funcionando. `/capture`, `/stats` y `/health` mantienen `*`. Allowlist ampliable con `[service] allowed_origins` en `config.ini`. Tests en `test_control_actions.py`.

---

## 2. Bugs concretos

### 2.1 `PairingSession` nunca se purga — `[x]`

- **Dónde:** `DeviceViewSet.init` crea una fila por código; el visor pide código nuevo cada vez que caduca (2 min).
- **Efecto:** ~720 filas/día por mini-PC sin emparejar, para siempre.
- **Hecho (2026-09-17):** `init` borra sesiones sin emparejar caducadas hace más de 1 h y sesiones emparejadas caducadas hace más de 1 día, antes de crear la nueva. Sin cron. Test `test_init_purges_stale_pairing_sessions`.

### 2.2 Estado muerto tras `unbind` (`PAIRED` sin token) — `[x]`

- **Dónde:** `DeviceViewSet.unbind` no borra las `PairingSession` que apuntan a la mesa; `status` devuelve `{'status': 'PAIRED'}` sin `device_token`; `visor.component.ts` solo actúa ante `PAIRED` con token o `EXPIRED` → sondeo infinito cada 3 s.
- **Hecho (2026-09-17):** (a) `unbind` y `revoke` borran las `PairingSession` de la mesa; (b) `status` responde `EXPIRED` cuando el token ya se consumió o la mesa se desvinculó; (c) el visor trata `PAIRED` sin token como `EXPIRED` y pide código nuevo. Tests `test_status_expires_when_paired_session_token_was_already_consumed` y `test_unbind_removes_pairing_sessions_of_the_mesa`.

### 2.3 Capture service monohilo — `[x]`

- **Dónde:** `capture_service.py` `HTTPServer` en `main()`.
- **Efecto:** un `/capture` (1,5–3 s de estabilización) bloquea `/health` y `/stats`; el watchdog usa timeout de 3 s.
- **Hecho (2026-09-17):** `ThreadingHTTPServer` con `daemon_threads`. `_camera_lock` (RLock) sigue serializando la cámara; `_stats_lock` protege las estadísticas.

### 2.4 Default de captura en código es 4K (cuelga el driver) — `[x]`

- **Dónde:** `Config.__init__` (`3840×2160`) vs `config.ini.example` (`1920×1080` con la explicación del cuelgue).
- **Hecho (2026-09-17):** default en código `1920×1080` con el motivo comentado. Los `config.ini` existentes no cambian. Test `test_default_capture_resolution_is_fullhd`.

### 2.5 `mark_done` del dispositivo sin transacción — `[x]`

- **Dónde:** `DeviceViewSet.mark_done`, también `set_index`.
- **Hecho (2026-09-17):** `mark_done` y `set_index` bloquean la mesa (y los items en `mark_done`) dentro de `transaction.atomic`. En SQLite `select_for_update` es no-op; el efecto real es en PostgreSQL.

---

## 3. Configuración y despliegue

### 3.1 Tres comandos de arranque divergentes — `[x]`

- `Dockerfile` `CMD`, `Procfile`, `railway.json` `startCommand`. Railway usa `railway.json`.
- **Hecho (2026-09-17):** `Procfile` eliminado; `CMD` del Dockerfile = `startCommand` de `railway.json` (collectstatic + gunicorn, sin `migrate`); `docker-compose.yml` lanza `migrate` en el `command` del backend.

### 3.2 Frontend construye con `npm install` — `[x]`

- **Hecho (2026-09-17):** `npm ci` en `app_proyeccion_moden/Dockerfile`; imagen construida en local para comprobarlo.

### 3.3 Producción como fallback por defecto — `[x]`

- `app_proyeccion_moden/Dockerfile` (`BACKEND_ORIGIN`/`BACKEND_HOST` de producción) y `capture_service.py` (`remote_config_url` de producción).
- **Decisión (2026-09-17):** se mantienen los defaults. Verificado con `railway variables` que **staging y producción tienen `BACKEND_ORIGIN`/`BACKEND_HOST` explícitos** apuntando cada uno a su backend por red privada (`http://projectionplatform.railway.internal:8000`), así que el default del Dockerfile no se usa en ningún entorno desplegado. Comprobación rápida cuando haya dudas: `railway variables -e staging -s calm-curiosity --kv | grep BACKEND`.
- Capture service: se mantiene el default de producción (los mini-PC son de producción por definición).

### 3.4 `.gitattributes` con `merge=ours` en Dockerfiles/nginx/compose — `[x]`

- **Efecto:** un cambio en `develop` en esos ficheros no llega a `deploy` al mergear.
- **Hecho (2026-09-17):** `.gitattributes` vacío. Los ficheros coincidían entre `develop` y `deploy` al retirarlas.

### 3.5 Sin `healthcheckPath` en Railway — `[x]`

- **Hecho en código (2026-09-17):** `GET /api/health/` (`api/health.py`, AllowAny, `SELECT 1`; 503 si la BD no responde) y `location = /health` en nginx (no depende del backend). `healthcheckPath` en `api_proyeccion_moden/railway.json` (`/api/health/`) y en el nuevo `app_proyeccion_moden/railway.json` (`/health`), timeout 300 s.
- Producción tiene `ALLOWED_HOSTS=projectionplatform-production.up.railway.app,moden.up.railway.app`; `settings.py` añade `healthcheck.railway.app` automáticamente cuando corre en Railway, así que no hay que tocar variables.
- **Verificado en staging (17/09/2026):** el primer deploy con `healthcheckPath` **falló** (Railway no obtuvo 200 en 300 s y, al tener volumen, paró el contenedor anterior: staging estuvo caído unos minutos). Causa: Railway comprueba contra el puerto de la variable `PORT`, que el backend no tenía definida (gunicorn escucha fijo en 8000). Arreglo: `PORT=8000` en el servicio backend (puesta en **staging y producción**, esta última con `--skip-deploys`) y `/api/health/` forzado a JSON (`6e17bf6`). Segundo deploy en `SUCCESS`; `/api/health/` responde `{"status":"ok","database":"ok"}` por el dominio público y por el proxy del frontend.
- **Regla:** cualquier servicio nuevo con healthcheck necesita `PORT` definida en Railway.

### 3.6 Menores — `[x]`

- `api_proyeccion_moden/requirements.txt` en UTF-16 → UTF-8. **Hecho.**
- `.pg_pass` y `.pg_service.conf` versionados → fuera de git (siguen en disco, ignorados). **Hecho.**
- `.gitignore` listaba `docker-compose.yml` aunque está trackeado → regla retirada. **Hecho.**

---

## 4. Arquitectura y rendimiento

### 4.1 Dashboard: una petición por mesa cada 5 s — `[x]`

- **Dónde:** `dashboard.ts` `pollMesasQueue`.
- **Hecho (2026-09-17):** `GET /api/mesas/colas/[?ids=1,2]` devuelve `{mesa_id: [items]}` para las mesas visibles del usuario, con el mismo serializer/contexto que `mesas/{id}/queue_items/`. `pollMesasQueue()` del dashboard hace una única petición y aplica la misma lógica por mesa (`applyPolledQueue`). Tests en `api/test_mesa_queues_bulk.py`.

### 4.2 Auto-avance de cola en el navegador — `[x]`

- **Dónde:** `dashboard.ts` `pollMesasQueue` → `mostrarItem()` si el primer item está `EN_COLA`.
- **Problema:** compite con `device/mark_done`, que ya promueve en servidor. Depende de que haya una pestaña abierta.
- **Hecho (2026-09-17):** `_promote_next_if_idle(mesa)` en backend, bajo `select_for_update` de la mesa: si no hay `MOSTRANDO` y hay `EN_COLA`, promueve el primero (misma transición que `mostrar`/`mark_done`). Se ejecuta en `GET /api/mesas/colas/` (sustituye al auto-avance del navegador) y en `GET /api/device/current_item/`, de modo que **el player se recupera solo** aunque nadie tenga el dashboard abierto. El auto-avance del dashboard queda como red de seguridad (normalmente nunca se dispara); retirarlo tras un ciclo en producción.

### 4.3 SSR configurado pero no usado — `[x]`

- **Hecho (2026-09-17):** eliminados los cuatro ficheros SSR y las dependencias `@angular/ssr`, `@angular/platform-server`, `express`, `@types/express`; `http-server` pasa a `devDependencies`; script `serve:ssr:*` retirado. `package-lock.json` regenerado.

### 4.4 Bundle inicial 682 kB — `[x]`

- **Hecho (2026-09-17):** `loadComponent` para `dashboard`, `visor` (ambas rutas) y `mapper`. Bundle inicial **681,89 kB → 354,66 kB** (93 kB transferidos); desaparece el warning de presupuesto inicial. Queda solo el de `dashboard.css` (53,42 kB frente a 50 kB).

### 4.5 SSE muerto — `[x]`

- `enableDeviceSSE: false` en ambos entornos; `DeviceViewSet.stream` sin uso.
- **Hecho (2026-09-17):** retirados `DeviceViewSet.stream`, `ServerSentEventRenderer`, `connectToSSE()` del visor y el flag `enableDeviceSSE`. El polling (estado cada 2 s en player / 1 s en supervisor, item cada 5 s / 2 s) es el único mecanismo.

### 4.6 Tests en SQLite, producción en PostgreSQL — `[ ]`

- **Plan:** documentar cómo ejecutar la suite contra Postgres local (`docker compose up db` + `DATABASE_URL`) y hacerlo al menos antes de cada merge a `deploy`.

### 4.7 Sin tareas programadas — `[ ]`

- Purga de `PairingSession` (se resuelve en 2.1 sin cron), auditoría de media huérfana, aviso de capacidad de volumen, backup. Pendiente de decidir mecanismo (Railway cron service o comando manual documentado).

---

## 5. Documentación

### 5.1 `docs/07_traspaso_estado_actual.md` desfasado — `[x]`

- **Hecho (2026-09-17):** cifras actualizadas (196/113/42 tests, bundle 355 kB, capture service `2026-09-17.1`, migraciones hasta `0056`), nuevas secciones 6.14 (media autenticada) y 6.15 (auto-avance en servidor), variables de entorno nuevas, riesgos 8.1/9.2 marcados como resueltos y resumen de cambios de septiembre en la sección 10.

### 5.2 `docs/06_lista_compra_propuesta.md` describe un diseño que no es el implementado — `[x]`

- La lista de materiales se resolvió leyendo las tablas de piezas del `.db` técnico del proyecto (`_read_materiales_tables`), no con la tabla externa `MaterialModulo`.
- **Hecho (2026-09-17):** cabecera de "histórico / superado" con la implementación real y los endpoints.

---

## Estado al cierre de la sesión (17/09/2026)

| Comprobación | Resultado |
| --- | --- |
| Tests backend | 196 OK |
| Tests frontend | 113 OK |
| Tests capture service | 42 OK |
| Build Angular producción | OK, bundle inicial 354,95 kB, solo warning de `dashboard.css` |
| Comprobación en navegador (local) | login → imagen propia 200 y `<img>` cargada; carpeta ajena 403; tras logout 401 |
| Commits en `develop` | 8 commits, uno por bloque, sin push |

**Queda abierto:**

- **1.1 — verificar en staging con sesión real** (3.5 ya verificado: healthcheck en verde en backend y frontend; sin credencial `/media/` y `/api/` devuelven 401): (b) player proyectando tras reiniciar el kiosk; (c) visor supervisor; (d) previsualizador del detalle; (e) modal de fotos; (f) plano PDF y ZIP desde el dashboard. Si algo de `/media/` falla y no se localiza rápido: `MEDIA_REQUIRE_AUTH=False` en el backend de Railway.
- **4.6** — ejecutar la suite contra PostgreSQL antes de fusionar a `deploy` (`docker compose up db` + `DATABASE_URL`).
- **4.7** — decidir mecanismo de tareas programadas (auditoría de media huérfana, capacidad del volumen, backup).
- La imagen Docker del frontend no se construyó en local (Docker Desktop apagado); `npm ci` se validó contra el lockfile. El deploy de staging es la prueba real.
- Los mini-PC recibirán `2026-09-17.1` por el actualizador automático (04:15) cuando el cambio llegue a `deploy`.

## Depuración de staging (17/09/2026)

La BD de staging era copia de producción, con cinco proyectos, pero el volumen
solo tenía los ficheros de uno. Eso producía 404 en todos los visores de los
otros cuatro y hacía inútil la mayor parte de los datos.

Se dejó **un único proyecto de prueba**, `VALDEBEBAS946_B5_P10` (id 73, 43
módulos, 1678 imágenes, todas en disco, con su grupo de 3 mesas y 86 items de
cola). Se borraron `Esnabide_test`, `Valdebebas_B5_P7_MODEN`,
`Valdebebas_B5_P7` y `prueba_warning` (5112 filas en cascada), previo simulacro
en transacción revertida. No quedaron módulos, imágenes ni fotos huérfanas; el
volumen queda en 229 MB con un solo directorio `imagenes/73`. Los grupos de
mesas de las otras dos ferrallas se conservan con `proyecto_actual` a null, por
si se quieren para pruebas de emparejamiento.

Producción no se tocó.

## Orden de ejecución

1. Bloque config/seguridad de bajo riesgo: 1.3, 1.4, 1.5, 3.1, 3.4, 3.6.
2. Emparejamiento y concurrencia: 2.1, 2.2, 2.5, 1.2.
3. Capture service: 2.3, 2.4, 1.6 (+ bump de `VERSION`).
4. Salud de despliegue: 3.5, 3.2, 3.3.
5. Frontend: 4.3, 4.4, 4.5.
6. Media autenticada: 1.1.
7. Dashboard: 4.1, 4.2.
8. Docs: 5.1, 5.2, y cierre de este documento.
