# Propuesta — Lista de compra por proyecto y general

Fecha: 2026-04-27
Estado: borrador para revisión interna antes de pasar al compañero de BD.

## 1. Objetivo

Permitir al jefe de planta de la ferralla revisar una **checklist de materiales necesarios** para fabricar los proyectos activos. El cliente ya tiene su almacén — esta lista sólo le **informa** del agregado de lo que necesita, y él marca un checkbox para darse por enterado de cada renglón. No es una gestión de stock.

Dos vistas:
- **Por proyecto:** desglose del proyecto X.
- **General:** suma de todos los proyectos activos, agrupada por tipo+variante de material. Bidireccional con la vista por proyecto (ver §4).

## 2. Datos de origen

### 2.1 Lo que ya tenemos en la BD actual

- `Modulo.codigos_color` (hasta 8 chars, cada char un color) — para calcular cintas de colores.
- `Modulo.inferior_hecho`, `Modulo.superior_hecho` — para descontar lo ya consumido.
- `DetalleModuloFase.metros_refuerzos / metros_zunchos / metros_separadores / metros_punzos` y sus `cantidad_*` por (módulo, fase) — pero **sin desglose por diámetro o tipo**, que es justo lo que la nueva tabla aportará.

### 2.2 Lo que aporta la nueva tabla (a preparar por el compañero)

Una tabla nueva en la BD original (la que él mantiene), no en la nuestra de Django, que detalle **por módulo y fase** los materiales desagregados por tipo/diámetro. Propuesta de esquema:

```
MaterialModulo
  modulo_id        FK / código (string)
  fase             ENUM('INF', 'SUP')
  clave_material   VARCHAR (ver §3 — clave normalizada)
  cantidad         DECIMAL
  unidad           VARCHAR ('m', 'ud')   ← opcional, si la clave ya implica unidad puede omitirse
```

Una fila por cada combinación (módulo, fase, clave_material). Si un módulo lleva refuerzos Ø8 e Ý10 en su fase inferior, son dos filas.

**Granularidad por fase** (`INF` / `SUP`) es importante: nos permite descontar de la lista de pendientes lo que ya se ha fabricado a nivel de panel, no sólo de módulo completo.

## 3. Clave de material (`clave_material`)

Identificador normalizado y estable que permite agrupar el mismo material entre proyectos en la vista general. Propuesta de convención:

| Tipo | Patrón | Ejemplos | Agrupable entre proyectos |
| --- | --- | --- | --- |
| Refuerzo por diámetro | `refuerzo_d{N}` | `refuerzo_d8`, `refuerzo_d10`, `refuerzo_d12` | **Sí** (Ø10 = Ø10 en todo proyecto) |
| Separador por ancho | `separador_a{ancho}` | `separador_a15`, `separador_a20`, `separador_a25` | **Sí** — son genéricos, mismo ancho = mismo separador entre proyectos. |
| Zuncho por tipo | `zuncho_{tipo}` | `zuncho_z1`, `zuncho_z25` | **No** — el mismo "Z1" puede definirse de forma distinta entre proyectos. Se muestran como subsección por proyecto en la vista general (no propagan check). |
| Punzo por tipo | `punzo_{tipo}` | `punzo_p1` | **No** — mismo caso que los zunchos: dependientes de proyecto. |

Y en el front añadiríamos los que **no** vienen de la tabla nueva:

| Mallazo (constante) | `mallazo_inf`, `mallazo_sup` | 1 ud por módulo y fase |
| Pieza bastidor (constante) | `pieza_bastidor_inf`, `pieza_bastidor_sup` | 4 ud por módulo y fase |
| Cinta de color | `cinta_{color}` | `cinta_yellow`, `cinta_green`, … (sólo SUP, 0.25 m por marca) |

Códigos de color que ya usa la BD: `y=yellow, g=green, c=cyan, v=violet, m=magenta, o=orange, x=skip`.

> **Petición al compañero:** que la `clave_material` venga ya normalizada en minúsculas, sin espacios ni acentos, idealmente en el formato `tipo_subtipo`. Si la BD original maneja códigos distintos, basta con que sea **estable** (siempre el mismo string para el mismo material) y nosotros mapeamos a etiquetas legibles en el front.

## 4. Estado del check (lo guardamos nosotros, en Django)

Tabla nueva en nuestra app:

```
MaterialInformado
  proyecto         FK Proyecto
  clave_material   VARCHAR
  informado        BOOL                    default=False
  origen           ENUM('PROYECTO','GENERAL') NULL
  fecha_marcado    DATETIME                NULL
  unique(proyecto, clave_material)
```

### Reglas del `origen`

- Marcar desde la vista de proyecto → `informado=true, origen='PROYECTO'`.
- Marcar desde la vista general → para cada proyecto del agregado:
  - si ya estaba `informado=true`, **no se toca** (preserva el `origen` previo);
  - si estaba `false`, pasa a `informado=true, origen='GENERAL'`.
- Desmarcar desde la vista general → solo afecta a las filas con `origen='GENERAL'`. Las marcadas explícitamente desde un proyecto se mantienen.
- Desmarcar desde la vista de proyecto → `informado=false, origen=null`.

Esto evita confirms destructivos y permite al jefe "marcar todo lo de Ø10 con un click" en general sin pisar lo que ya gestionó proyecto a proyecto.

## 5. Cómo se calcula la cantidad de cada renglón

Para un renglón (proyecto, clave_material), la **cantidad pendiente** y el **total** se calculan así:

- Total = Σ aporte de cada (módulo del proyecto, fase) según el origen del material:
  - **Materiales de la tabla nueva:** se lee directo de `MaterialModulo`.
  - **Mallazo:** 1 por (módulo, fase). Total = nº módulos × 2 (1 INF + 1 SUP).
  - **Pieza bastidor:** 4 por (módulo, fase). Total = nº módulos × 8.
  - **Cinta de color X:** 0.25 m × (número de marcas de color X en `Modulo.codigos_color`), **sólo en SUP**.
- Pendiente = ídem pero filtrando las (módulo, fase) cuyo `inferior_hecho` o `superior_hecho` correspondiente sea `false`.

La vista mostrará `pendiente / total` (ej. `200 / 356 m`). Si `pendiente == 0` el renglón se atenúa (auto-marcado, no clicable).

## 6. Endpoints (esbozo)

Backend Django, autenticación con la sesión existente.

| Verbo | Ruta | Devuelve / hace |
|---|---|---|
| GET | `/api/proyectos/<id>/lista-compra/` | Lista de renglones del proyecto: `{ clave, etiqueta, unidad, total, pendiente, informado, origen }` |
| PATCH | `/api/proyectos/<id>/lista-compra/<clave>/` | Body `{ informado: bool }`. Si pasa a true → origen='PROYECTO'. Si pasa a false → origen=null. |
| GET | `/api/lista-compra/general/` | Renglones agregados: `{ clave, etiqueta, unidad, total, pendiente, informado_total, informado_count, proyectos_count, todos_marcados }` |
| PATCH | `/api/lista-compra/general/<clave>/` | Body `{ informado: bool }`. true → marca con origen='GENERAL' los que estén en false; false → desmarca sólo los que tengan origen='GENERAL'. |

Filtro de "proyectos activos" para la general: por definir (¿todo lo que no esté completado al 100%? ¿lo que está en alguna cola de mesa?). Decidir antes de cerrar el endpoint.

## 7. Front

- Botón nuevo (icono lista de compra) en cada `project-inline-card` del dashboard, al lado del botón de plan/módulos actual.
- Botón global "Lista de compra general" en la cabecera de la sección Proyectos.
- Dos modales nuevos siguiendo el patrón visual del `showPlanModal` actual.
- Mientras la tabla nueva no exista: servicio mock con datos de ejemplo. Al llegar el endpoint real, sólo se cambia la URL.

## 8. Definición de "proyecto activo"

Para la vista general agregamos todos los proyectos que **existan y no estén completamente terminados** (al menos un módulo no `COMPLETADO`/`CERRADO`).

## 9. Comportamiento de la vista general por tipo de material

- **Bloque agrupable** (arriba en el modal general): refuerzos por diámetro, separadores por ancho, mallazos, piezas bastidor, cintas por color. Cantidades sumadas entre proyectos. Check único que propaga a los N proyectos del agregado (con la regla de `origen` de §4).
- **Bloque específico por proyecto** (abajo en el modal general): zunchos y punzos. Se muestran como subsecciones por proyecto, cada renglón con su check independiente. No hay propagación porque no hay material equivalente entre proyectos.

## 10. Pendientes / decisiones abiertas

- **¿La `clave_material` la entrega normalizada el compañero, o la normalizamos nosotros al servir el endpoint?** Preferencia: que venga normalizada (menos código de mantenimiento). Aceptable: que venga "como la BD original la tenga" y mapeamos en Django.
- **Cintas de color:** confirmar que 0.25 m por marca sigue siendo la cifra correcta (ya está en uso en la heurística de dificultad).
