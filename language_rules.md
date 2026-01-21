# Reglas específicas por lenguaje (Python + TypeScript) — MOD:EN

> Objetivo: consistencia, mantenibilidad y fiabilidad en producción.
> Regla general: el código debe ser legible, tipado y fácil de testear.

---

## 1) Python (Backend — Django 5 / DRF)

### 1.1 Tipado (práctico, no dogmático)
- **Type hints** obligatorios en:
  - `services.py` / lógica de dominio
  - serializers complejos
  - funciones de seguridad (tokens, permisos)
- En views simples se permite tipado parcial si no aporta valor.
- Evitar `dict` sueltos para datos complejos:
  - preferir `dataclasses` o `TypedDict` (y `pydantic` si ya lo usáis).

### 1.2 Arquitectura: Thin Views + Services
- **Prohibido** meter lógica de negocio en Views:
  - las Views hacen: auth + parseo input + llamada a servicio + respuesta.
- Lógica de negocio vive en:
  - `services.py` o `domain/` (recomendado)
- Model methods solo para cosas pequeñas, no “modelos monstruosos”.

Ejemplos de “lógica de negocio” que debe ir en servicios:
- crear `mesa_queue_item` resolviendo y validando `imagen_id`
- marcar item HECHO y actualizar flags de módulo
- reordenar colas (y normalizar positions)
- pairing device tokens y revocación

### 1.3 Performance: anti N+1 (regla estricta)
- **Prohibido** acceder a FKs en bucles/serializers sin:
  - `select_related()` / `prefetch_related()`
- En endpoints de dashboard:
  - usar querysets optimizados y limitar campos.
- Índices obligatorios en colas y estado:
  - `(mesa_id, status)`, `(mesa_id, position)`, `(queue_id, position)`, `(modulo_id, fase)`.

### 1.4 Seguridad y validación (DRF)
- Nunca confiar en el frontend:
  - permisos y validaciones se hacen server-side.
- Device token:
  - guardar **hash** del token en DB (no en claro)
  - tokens revocables y rotables
- Validación de integridad (obligatoria):
  - al crear item de mesa:
    - `imagen.modulo_id == modulo_id`
    - `imagen.fase == fase`
- Subidas de imágenes:
  - validar MIME real, tamaño, nombre aleatorio, fuera de webroot.

### 1.5 Estilo y tooling
- Elegid un estándar y aplicadlo en CI:
  - Lint: `ruff` (recomendado) o equivalente
  - Formato: `black` (si ya lo usáis) o mantenerlo en ruff-format si preferís
- Errores consistentes:
  - mensajes claros (para operativa) y códigos HTTP correctos.

### 1.6 Tests (mínimos de alto impacto)
- Tests obligatorios para:
  - RBAC (operario/supervisor/admin) y device token
  - reglas inferior/superior + cierre supervisor
  - integridad de colas (reorder, avanzar, done)
  - endpoints críticos del Player (no romper taller)

---

## 2) TypeScript (Frontend — Angular 18)

### 2.1 Tipado estricto (sin “any”)
- `any` **prohibido**.
- Si no se conoce el tipo: `unknown` + narrowing.
- DTOs tipados para toda interacción con API:
  - `ProjectDto`, `ModuleDto`, `MesaDto`, `QueueItemDto`, etc.
- Habilitar `strict` en `tsconfig` (o plan para acercarse).

### 2.2 Angular moderno: Standalone + performance
- Standalone components como estándar.
- `ChangeDetectionStrategy.OnPush` por defecto (especialmente en Player).
- `trackBy` obligatorio en listas (colas, mesas, módulos).
- Prohibido llamar funciones en templates (causan renders/recalculos).
- Suscripciones:
  - preferir `async` pipe, signals o patrones que eviten fugas.
  - si hay subscribe manual, debe haber teardown claro.

### 2.3 Player como “máquina de estados” (regla clave)
- Nada de múltiples booleanos (`isLoading`, `isError`, etc.) sin control.
- Definir un estado explícito:
  - `type PlayerState = 'idle' | 'loading' | 'active' | 'offline' | 'error' | 'calibrating' | 'blackout';`
- Las transiciones deben ser claras y testables.

### 2.4 Input de botonera / teclado
- Captura centralizada (servicio o componente raíz):
  - mapear teclas → acciones (next/prev/blackout/confirm)
- Aplicar **debounce** (200–300ms) para evitar rebotes físicos.
- Confirmaciones:
  - finalizar requiere doble acción (doble pulsación / pulsación larga + confirmación) con overlay visible.

### 2.5 Offline y resiliencia (Player)
- Player como PWA (service worker):
  - cache estáticos y el plano actual (y opcional siguiente)
- Si cae la red:
  - mantener último plano visible
  - indicador offline claro
  - reintentos con backoff y sin “spam” al servidor

### 2.6 Tooling
- ESLint + Prettier (o estándar actual del repo).
- “No warnings” en build del Player (idealmente).

---

## 3) Definition of Done (solo por lenguaje/calidad)
Una tarea de backend/frontend está “done” si:
1) está tipada de forma razonable (sin `any`, sin dicts caóticos en lógica),
2) no introduce N+1 ni renders innecesarios,
3) tiene validaciones server-side y errores claros,
4) sobrevive a refresh (F5) y a 10s sin red en Player sin romperse.
