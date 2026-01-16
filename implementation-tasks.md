IMPLEMENTATION STEPS — SECCIONES (PROYECTOS → MODULOS → MESAS) + BD (RELACIONES BIEN HECHAS)

OBJETIVO
Aplicar el flujo 3 secciones (Proyectos → Cola de Módulos → Mesas) asegurando que la BD soporte:
- Cola de planificación de módulos (ordenable)
- Cola por mesa (ordenable e iterable)
- Imágenes por módulo con fase (inferior/superior) + orden/versión
- Estados por fase en módulo (para “no finalizado hasta ambas hechas”)
- Relaciones consistentes + constraints + índices (sin hacks)

ASUNCIÓN DE UX (para simplificar modelo y evitar ambigüedad)
- A MESAS se asignan WorkItems por fase (inferior/superior), no “módulo entero ambiguo”.
- Un WorkItem apunta a una imagen concreta (imagen_id).

────────────────────────────────────────────────────────────
FASE BD-0 — VERIFICAR ESQUEMA ACTUAL (no bloquear, pero imprescindible)
1) Confirmar modelos y campos existentes:
   - api_proyecto(id, nombre, usuario_id?)
   - api_modulo(id, nombre, planta, proyecto_id)
   - api_imagen(id, url, tipo, modulo_id)   ← “tipo” hoy
   - api_mesa(id, nombre, usuario_id, imagen_actual_id?, ultima_actualizacion)
2) Confirmar si hay datos en producción o es desarrollo.
   - Si hay datos: migraciones con campos nullable al inicio y backfill.

────────────────────────────────────────────────────────────
FASE BD-1 — DECISIONES DE RELACIÓN (la BD debe representar esto)
Relaciones base (se mantienen):
- Proyecto 1—N Modulo
- Modulo 1—N Imagen

Relaciones nuevas (se añaden):
- Proyecto 1—N ModuloQueue (o 1—1 si queréis una única cola por proyecto)
- ModuloQueue 1—N ModuloQueueItem (ordenable)
- Mesa 1—N MesaQueueItem (ordenable)

Estados:
- Modulo: debe reflejar “fase inferior hecha” y “fase superior hecha” + “cerrado”
- MesaQueueItem: estado EN_COLA / MOSTRANDO / HECHO

────────────────────────────────────────────────────────────
FASE BD-2 — CAMBIOS EN TABLAS EXISTENTES (Imagen y Modulo)
A) api_imagen (enriquecer para secuencias)
- Renombrar/usar campo:
  - tipo -> fase (INFERIOR/SUPERIOR)  (si renombrar complica, mantener tipo)
- Añadir campos:
  - orden (int, default 1)
  - version (int o varchar, default 1)
  - checksum (varchar, opcional)
  - activo (bool, default true)

Constraints recomendadas:
- UNIQUE(modulo_id, fase, orden, version)   (o al menos modulo_id+fase+orden si no versionáis aún)
- CHECK(fase in {INFERIOR, SUPERIOR})

Indices recomendados:
- INDEX(modulo_id)
- INDEX(modulo_id, fase)
- INDEX(modulo_id, fase, orden)

B) api_modulo (estado por fase + cierre)
- Añadir:
  - inferior_hecho (bool, default false)
  - superior_hecho (bool, default false)
  - estado (enum o varchar: PENDIENTE/EN_PROGRESO/COMPLETADO/CERRADO)  (opcional pero útil)
  - cerrado (bool, default false)
  - cerrado_at (datetime, null)
  - cerrado_by (FK user, null)

Regla:
- COMPLETADO = inferior_hecho AND superior_hecho
- CERRADO = supervisor valida (cierra)

────────────────────────────────────────────────────────────
FASE BD-3 — TABLAS NUEVAS (colas y ejecución)
1) api_modulo_queue (cabecera de cola de planificación)
Campos:
- id
- proyecto (FK api_proyecto, on_delete=CASCADE)
- created_by (FK auth_user, on_delete=SET_NULL, null)
- created_at (datetime)
- nombre/opcional (si queréis varias colas por proyecto)
- activa (bool) (opcional)

Constraint recomendada:
- Si queréis 1 cola por proyecto:
  - UNIQUE(proyecto_id)

Index:
- INDEX(proyecto_id)

2) api_modulo_queue_item (items ordenados)
Campos:
- id
- queue (FK api_modulo_queue, CASCADE)
- modulo (FK api_modulo, CASCADE)
- position (int)
- added_by (FK user, null)
- created_at

Constraints recomendadas:
- UNIQUE(queue_id, modulo_id)  (evitar duplicados del mismo módulo en la misma cola)
- UNIQUE(queue_id, position)   (si queréis posiciones estrictas; si no, solo index)

Indices:
- INDEX(queue_id, position)
- INDEX(modulo_id)

3) api_mesa_queue_item (cola ejecutable por mesa: “WorkItem”)
Campos:
- id
- mesa (FK api_mesa, CASCADE)
- modulo (FK api_modulo, CASCADE)      ← para poder marcar fase hecha en ese módulo
- fase (INFERIOR/SUPERIOR)             ← duplicar aquí evita ambigüedad
- imagen (FK api_imagen, PROTECT)      ← imagen concreta que se proyecta
- position (int)
- status (EN_COLA/MOSTRANDO/HECHO)
- assigned_by (FK user, null)
- assigned_at (datetime)
- done_by (FK user, null)
- done_at (datetime, null)

Constraints recomendadas:
- CHECK(fase in {INFERIOR, SUPERIOR})
- CHECK(status in {EN_COLA, MOSTRANDO, HECHO})
- INDEX(mesa_id, position)
- INDEX(mesa_id, status)
- INDEX(modulo_id, fase)

Regla de integridad importante:
- La imagen asignada debe pertenecer al mismo modulo y fase:
  - imagen.modulo_id == modulo_id
  - imagen.fase == fase
Esto se valida en backend (serializer/service) y opcionalmente con constraint avanzada (difícil en SQL puro).

4) (Opcional) api_mesa_current_item (o campo)
Para evitar cálculos constantes:
- En api_mesa añadir:
  - current_queue_item (FK api_mesa_queue_item, null, SET_NULL)
  - locked (bool) / blackout (bool) / last_seen (datetime)
Esto se puede dejar para después del MVP.

────────────────────────────────────────────────────────────
FASE BD-4 — MIGRACIONES DJANGO (cómo hacerlo sin romper)
1) Crear migración con campos nuevos “nullable” si hay datos:
- imagen.orden nullable con default
- modulo.inferior_hecho false
- etc.
2) Migración de datos (backfill):
- Para imágenes existentes:
  - fase = tipo (si ya lo tenéis así)
  - orden = 1
  - version = 1
3) Si se decide renombrar tipo→fase:
- Hacer migración de rename_field
- Mantener compatibilidad en serializers temporalmente si hace falta.

────────────────────────────────────────────────────────────
FASE BD-5 — VALIDACIONES DE RELACIÓN (OBLIGATORIAS EN BACKEND)
Al crear un mesa_queue_item:
- Resolver imagen_id según:
  - modulo_id + fase (+ orden si es secuencia)
- Validar:
  - imagen.modulo_id == modulo_id
  - imagen.fase == fase
- Si el modulo no tiene imagen de esa fase:
  - devolver error claro “Módulo X no tiene imagen INFERIOR” (no crear item inválido)

Al marcar HECHO un mesa_queue_item:
- Si fase == INFERIOR: modulo.inferior_hecho = true
- Si fase == SUPERIOR: modulo.superior_hecho = true
- Si ambas true: modulo.estado = COMPLETADO
- Cierre final (CERRADO) solo por supervisor con acción explícita.

────────────────────────────────────────────────────────────
FASE BD-6 — PRUEBAS RÁPIDAS DE INTEGRIDAD (mínimas)
- Crear proyecto → módulo → 2 imágenes (inferior/superior)
- Añadir módulo a modulo_queue (posición 1)
- Encolar workitem inferior a mesa 1
- El item debe guardar imagen correcta
- Marcar HECHO y verificar:
  - modulo.inferior_hecho = true
  - modulo NO cerrado
- Encolar superior y marcar HECHO:
  - modulo.superior_hecho = true
  - modulo.estado COMPLETADO
- Supervisor cierra:
  - modulo.cerrado = true

────────────────────────────────────────────────────────────
FASE BD-7 — ÍNDICES/RENDIMIENTO (para “muchas mesas”)
- mesa_queue_item: index(mesa_id, status), index(mesa_id, position)
- imagen: index(modulo_id, fase, orden)
- modulo_queue_item: index(queue_id, position)

────────────────────────────────────────────────────────────
NOTA IMPORTANTE (para mantener el MVP simple)
- Mantener mesa.imagen_actual solo como “cache visual” si ya existe,
  pero la fuente de verdad debe ser mesa_queue_item (status MOSTRANDO o current_item).
- No meter WebSockets ni cifrado avanzado de imágenes en esta fase de BD.
  Primero: relaciones correctas + colas + estados.

ENTREGA ESPERADA DE ESTA PARTE (BD OK)
- BD soporta: (1) biblioteca proyecto->módulo->imágenes por fase, (2) cola de módulos por proyecto, (3) cola por mesa con workitems por fase, (4) estados por fase en módulo, (5) constraints/índices razonables.