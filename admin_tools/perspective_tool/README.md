# Perspective Tool

Herramienta de escritorio para corregir la perspectiva (trapecio → rectángulo) de las capturas de las mesas, aplicar la corrección en lote a una carpeta y generar timelapses mp4.

Es **independiente** del backend Django y del mapper Angular. Trabaja sobre archivos locales (Google Drive sincronizado o cualquier carpeta).

## Instalación (Windows)

```cmd
cd admin_tools\perspective_tool
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

`pip install` ya descarga el binario de **FFmpeg** dentro del venv (vía `imageio-ffmpeg`), así que no hay que instalar nada más. Si por alguna razón el binario empaquetado no está disponible, la herramienta cae a un fallback con OpenCV (calidad menor).

## Ejecución

Doble clic en `run.bat`, o desde una shell:

```cmd
.venv\Scripts\activate
python main.py
```

## Flujo típico

1. **Calibración**
   - *Cargar imagen…* → abre un JPG cualquiera de la carpeta de la mesa.
   - Arrastra los 4 puntos hasta las esquinas reales de la mesa (TL, TR, BL, BR).
   - Ajusta finamente con las flechas del teclado (1 px por pulsación sobre el último punto seleccionado).
   - Mira el preview de la derecha. Cuando esté bien, *Guardar como…* → un JSON, p. ej. `fer_g1_inf1.json`.

2. **Procesar lote**
   - Selecciona la carpeta del día (`G:\Mi unidad\capturas_moden\<mesa>\YYYY-MM-DD\`).
   - La herramienta usa la calibración activa (la última que cargaste/guardaste) o puedes cargar otra distinta.
   - *Procesar* → escribe a la carpeta hermana `<carpeta>_rect/`. Idempotente: si vuelves a ejecutarlo, salta los archivos que ya existen.

3. **Timelapse**
   - Selecciona una carpeta (idealmente `_rect/` o una carpeta padre con subcarpetas `YYYY-MM-DD`).
   - Filtra por rango de fechas y/o de hora si quieres.
   - Define FPS y ancho de salida.
   - *Generar…* → MP4.

## Formato del JSON de calibración

```json
{
  "version": 1,
  "name": "Mesa fer_g1_inf1 - cámara izquierda",
  "corners": [TLx, TLy, TRx, TRy, BLx, BLy, BRx, BRy],
  "source_size": [1920, 1080],
  "output_size": [1600, 900]
}
```

Si en el futuro se quiere copiar/pegar manualmente desde/hacia `Mesa.calibration_json` del mapper Angular, el orden de `corners` (TL, TR, BL, BR) es el mismo.

## Empaquetar para distribución (modo "doble clic")

Para mandárselo a alguien que no tiene Python instalado:

```cmd
.venv\Scripts\activate
pip install -r requirements-dev.txt
python build_dist.py
```

Eso genera `dist/PerspectiveTool/` con un `PerspectiveTool.exe` autocontenido (incluye Python, PySide6, OpenCV y ffmpeg). Comprime esa carpeta entera en un `.zip` y mándalo. El destinatario solo tiene que **descomprimir y doble clic** en `PerspectiveTool.exe` — no hay que instalar nada.

La carpeta pesa ~150–200 MB. Si en el futuro cambias el código, vuelves a ejecutar `python build_dist.py` y rehaces el zip.
