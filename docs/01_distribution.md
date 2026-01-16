# 01. Distribución y Estructura del Sistema (Distribution)

## 1. Visión General
Este documento define la estructura física y lógica de la plataforma **mod:en** para la gestión de ferrallas y proyección en construcción.

## 2. Distribución Física (Hardware & Red)
El sistema opera en un entorno industrial ("Zero Cables") dividido en dos nodos principales:

### Nodo de Gestión (Supervisor - Jefe de Producción)
- **Dispositivo**: Laptop Central.
- **Ubicación**: Oficina técnica o punto de control en planta.
- **Función**: Acceso al Dashboard para asignar "módulos pendientes" a las mesas.

### Nodos de Visualización (Mesas de Trabajo)
Configuración por mesa:
- **Montaje**: Poste de altura 3 metros con llegada de electricidad. Brazo articulado para movimiento vertical.
- **Proyector**: Epson EB-L210SF.
- **Mini PC**: MeLE Quieter 4C Fanless (N100, 8GB/128GB, USB-C PD 3.0, 2xHDMI).
- **Conexión**: Cable HDMI corto entre Mini PC y Proyector (ambos en la cima del poste).
- **Periférico de Control**: Botonera Wireless Programable de 3 botones (conectada al Mini PC).
    - **Botón 1**: Siguiente (Navegar entre planos/imágenes).
    - **Botón 2**: On/Off (Toggle de "Pantalla Negra" virtual, no apaga el proyector).
    - **Botón 3**: Anterior(Navegar entre planos/imágenes).
- **Conectividad**: Wi-Fi.

![Boceto del Setup](set-up.png)


## 3. Distribución Lógica (Arquitectura)
El sistema sigue un modelo de microservicios:

### A. Frontend (Angular 18+)
Dos aplicaciones lógicas en una SPA:
1.  **Dashboard (Dispatcher)**: Interfaz rica para gestionar proyectos y asignar recursos.
2.  **Visor (Player)**: Interfaz ligera optimizada para proyección, con capacidades Offline-First y Mapper (calibración).

### B. Backend (Django 5 DRF)
- API REST que gestiona la persistencia y la lógica de negocio.
- Endpoints principales para `Proyectos`, `Módulos`, `Imágenes` y `Mesas`.

### C. Base de Datos (PostgreSQL 15)
- Almacenamiento relacional de metadatos y asignaciones.

## 4. Diagrama de Conexión (Conceptual)

graph TD
    subgraph "Oficina / Control"
        Supervisor[PC Supervisor] -->|HTTPS| LoadBalancer[Nginx]
    end

    subgraph "Servidor Central (Docker)"
        LoadBalancer -->|/api| API[Django Backend]
        LoadBalancer -->|/| App[Angular App]
        API --> DB[(PostgreSQL)]
    end

    subgraph "Planta / Taller"
        Mesa1[Mesa 1: Mini PC + Proyector] -->|HTTPS / Visor| LoadBalancer
        Mesa2[Mesa 2: Mini PC + Proyector] -->|HTTPS / Visor| LoadBalancer
        MesaN[Mesa N: Mini PC + Proyector] -->|HTTPS / Visor| LoadBalancer
    end
