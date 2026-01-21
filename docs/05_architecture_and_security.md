# 05. Arquitectura del Sistema y Seguridad

Este documento define la estrategia técnica para la gestión de imágenes, la seguridad de las conexiones y el almacenamiento de datos.

## 1. Arquitectura Física

- **Servidor Local**: 
  - Aloja la Base de Datos (PostgreSQL/SQLite) y el Backend (Django).
  - Almacena físicamente los archivos de imagen en una estructura de carpetas organizada.
  - Expone una API REST para los clientes.
- **Clientes (Mini PCs / Mesas)**:
  - Funcionan en modo **Quiosco Web** (Navegador a pantalla completa).
  - Acceden a una URL local (ej. `http://192.168.1.100:8000/visor`).
  - Mantiene una sesión persistente mediante un **Token** almacenado en el navegador (LocalStorage) o en la URL.

## 2. Estrategia de Seguridad y Autenticación

Para asegurar que solo las mesas autorizadas accedan al sistema y poder trazar qué mesa está conectada:

### A. Token de Mesa (Machine Token)
- Cada Mini PC (navegador) guardará este token (ej. en `LocalStorage`) la primera vez que se configure.
- En las siguientes conexiones, el navegador enviará este token automáticamente en cada petición para decir "Soy la Mesa 1".
- **En el Backend**: Existirá una tabla `Mesa` que vincula este token con un nombre físico (ej. "Mesa de Corte 1").

### B. Flujo de Conexión
1. La Mini PC inicia la app Angular.
2. Angular lee el token almacenado.
3. Angular envía el token en el Header de cada petición HTTP: `Authorization: Bearer <TOKEN>`.
4. El Backend valida el token:
   - **Token Válido**: Permite el acceso y registra "Mesa 1 conectada".
   - **Token Inválido/No enviado**: Rechaza la conexión (401 Unauthorized).

## 3. Gestión de Imágenes y Sistema de Ficheros

### A. Almacenamiento "Físico"
Para facilitar la gestión manual o mediante scripts, replicaremos la estructura lógica en el sistema de archivos del servidor.

**Estructura de Directorios Propuesta:**
```text
/media/
  └── ferralla/
      └── <nombre_proyecto>/        # Ej: Hospital_Central
          └── <nombre_planta>/      # Ej: Planta_Baja
              └── <nombre_modulo>/  # Ej:            Muro_Contencion_Norte
                  ├── 01_INF_plano.jpg
                  ├── 02_SUP_detalles.jpg
                  └── ...
```

### B. Sincronización Base de Datos
La Base de Datos no almacenará los binarios de las imágenes (BLOBs), sino las **referencias (rutas)** y metadatos.

**Estructura de Datos (Modelos Django):**

1.  **Proyecto**: `nombre`, `codigo`
2.  **Planta**: `nombre`, `proyecto (FK)` (Nivel intermedio para agrupar módulos)
3.  **Modulo**: `nombre`, `planta (FK)`, `tipo (INF/SUP)`
4.  **Imagen**: 
    - `archivo`: Ruta al archivo (FileField/CharField)
    - `modulo (FK)`: Relación con el módulo
    - `orden`: Entero (1, 2, 3...) para secuencia de proyección
5.  **Mesa**:
    - `nombre`: "Mesa de Corte 1"
    - `token`: UUID único para autenticación (ej. `550e8400-e29b...`)
    - `imagen_actual`: Estado actual

### C. Carga y Ordenamiento
- **Carga Automática**: Implementaremos un comando de administración (script) que "escanee" la carpeta `/media/ferralla` y actualice la base de datos automáticamente.
  - Si encuentra `01_MOD_INF_A01.jpg`, crea registro de imagen orden `1` en el módulo correspondiente.
- **Ordenamiento**: El Frontend solicitará las imágenes de un módulo y el Backend las devolverá ya ordenadas por la columna `orden` o alfabéticamente por nombre.

## 4. Dashboard de Administración
Utilizaremos el **Django Admin** (ya incluido) inicialmente para:
- Dar de alta Mesas y generar sus Tokens.
- Ver registros de conexión.
- Gestionar manualmente Proyectos/Módulos si falla la carga automática.

A futuro, se construirá un panel personalizado en Angular para operaciones de "Drag & Drop" y asignación visual.
