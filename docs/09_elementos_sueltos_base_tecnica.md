# Propuesta — Elementos sueltos en la base técnica

Fecha: 2026-10-26
Estado: **propuesta**, pendiente de que el compañero de BD la revise. La
plataforma ya la lee: en cuanto un `.db` técnico traiga la tabla, el peso
aparece en la página de Planificación de la ferralla.

## 1. Para qué

La ferralla quiere ver los kilos de cada proyecto que van a obra. Hoy la
plataforma conoce los de los módulos (las tablas `resumen` y de piezas del
`.db` técnico). Falta el peso de los **elementos sueltos**: las barras, vigas,
zunchos y armaduras que van a obra fuera de los módulos, antes o después de
ellos.

Hoy esos elementos llegan en un Excel aparte (`ESN27_P1_elementos_sueltos.xlsx`)
con cantidad, diámetro y longitud, sin peso. La propuesta es que vengan en el
propio `.db` técnico, con su peso calculado.

## 2. Tabla propuesta

Una tabla más en el `.db` técnico de cada proyecto, junto a `resumen`:

```
elementos_sueltos
  id            INTEGER PRIMARY KEY
  peso_kg       REAL NOT NULL   ← peso total de la línea (cantidad incluida)
  titulo        TEXT            ← el bloque del Excel: "ARMADURA SUPLEMENTARIA PILARES INFERIOR"
  momento       TEXT            ← 'PRE' o 'POST' (antes o después de los módulos)
  descripcion   TEXT
  cantidad      INTEGER
  diametro_mm   REAL
  longitud_m    REAL
```

Una fila por línea del Excel actual (o por pieza, si le resulta más cómodo: la
plataforma suma).

**Lo único imprescindible es `peso_kg`**, y es el peso total de la fila, no el
unitario: la plataforma hace `SUM(peso_kg)` y no multiplica por `cantidad`. El
resto de columnas son opcionales; si están, más adelante se podrán enseñar como
el Excel (por bloque y por momento) sin pedir nada nuevo.

## 3. Qué hace la plataforma con ella

- Al importar el `.db` técnico de un proyecto (desde el admin), suma
  `peso_kg` y lo guarda en `Proyecto.peso_elementos_sueltos_kg`.
- Si el `.db` no trae la tabla (o no trae la columna `peso_kg`), el dato queda
  vacío y la tarjeta del proyecto dice «pendiente». Si la trae vacía, son 0 kg.
- Cada importación reemplaza el dato: un `.db` nuevo sin la tabla lo vuelve a
  dejar pendiente.
- La tarjeta de Planificación suma: módulos + elementos sueltos + los «otros»
  que la ferralla añade a mano = **total a obra**. El desperdicio se enseña
  aparte y no suma.

## 4. Preguntas para el compañero

1. ¿El peso de cada línea lo calcula ya su proceso (cantidad × longitud ×
   0,00617 × diámetro², en kg con el diámetro en mm) o hay que añadirlo?
2. ¿Hay elementos sueltos que no estén en el Excel actual (p. ej. esperas o
   mallas de reparto) y que deban entrar?
3. ¿`momento` puede faltar en algún bloque? Si siempre lo dice el título
   (PRE-/POST-MODULOS), basta con copiarlo.
