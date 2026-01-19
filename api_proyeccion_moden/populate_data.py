"""
Seed script para poblar la base de datos con datos de ejemplo.
Ejecutar con: python manage.py shell < populate_data.py
O: docker exec -i proyeccion_backend python manage.py shell < populate_data.py
"""
import os
import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')
django.setup()

from django.contrib.auth.models import User
from api.models import Proyecto, Planta, Modulo, Imagen, Mesa, ModuloQueue, Fase

# Obtener usuario admin
admin = User.objects.get(username='admin')

print("=" * 60)
print("POBLANDO BASE DE DATOS CON DATOS DE EJEMPLO")
print("=" * 60)

# =============================================================================
# LIMPIAR DATOS ANTERIORES (opcional)
# =============================================================================
print("\n[1] Limpiando datos de prueba anteriores...")
# Primero eliminar items de cola (tienen FK protegida a Imagen)
from api.models import MesaQueueItem
MesaQueueItem.objects.all().delete()
Imagen.objects.filter(modulo__nombre__startswith='MOD-').delete()
Modulo.objects.filter(nombre__startswith='MOD-').delete()
Planta.objects.all().delete()
Proyecto.objects.filter(nombre__startswith='OBRA-').delete()
Mesa.objects.filter(nombre__startswith='Mesa-').delete()
print("    ✓ Datos anteriores eliminados")

# =============================================================================
# PROYECTOS
# =============================================================================
print("\n[2] Creando Proyectos...")

proyectos_data = [
    {"nombre": "OBRA-Edificio Nervión", "descripcion": "Edificio residencial 12 plantas"},
    {"nombre": "OBRA-Centro Comercial Sur", "descripcion": "Centro comercial con 3 niveles"},
    {"nombre": "OBRA-Hospital Regional", "descripcion": "Hospital con área de urgencias"},
    {"nombre": "OBRA-Estación Metro L4", "descripcion": "Estación subterránea línea 4"},
    {"nombre": "OBRA-Parking Aeropuerto", "descripcion": "Parking multinivel 2000 plazas"},
]

proyectos = []
for p_data in proyectos_data:
    proyecto = Proyecto.objects.create(
        nombre=p_data["nombre"],
        usuario=admin
    )
    proyectos.append(proyecto)
    # Crear cola de módulos para el proyecto
    ModuloQueue.objects.create(proyecto=proyecto, created_by=admin)
    print(f"    ✓ {proyecto.nombre}")

# =============================================================================
# PLANTAS Y MÓDULOS POR PROYECTO
# =============================================================================
print("\n[3] Creando Plantas y Módulos con Imágenes...")

# Estructura: proyecto -> plantas -> modulos (3-4 módulos por planta)
proyecto_plantas_modulos = {
    "OBRA-Edificio Nervión": {
        "Sótano -2": [
            "MOD-A1 Armadura Cimentación",
            "MOD-A1b Zapatas Pilares",
            "MOD-A1c Vigas Riostras",
        ],
        "Sótano -1": [
            "MOD-A6 Muros Sótano",
            "MOD-A6b Rampa Acceso",
            "MOD-A6c Foso Ascensor",
        ],
        "Planta 0": [
            "MOD-A2 Armadura Forjado P0",
            "MOD-A2b Pilares P0",
            "MOD-A2c Vigas P0",
        ],
        "Planta 1": [
            "MOD-A3 Armadura Forjado P1",
            "MOD-A3b Pilares P1",
            "MOD-A3c Balcones P1",
        ],
        "Planta 2": [
            "MOD-A4 Armadura Forjado P2",
            "MOD-A4b Pilares P2",
            "MOD-A4c Terraza P2",
        ],
        "Plantas 0-2": [
            "MOD-A5 Pilares P0-P2",
            "MOD-A5b Núcleo Escaleras",
            "MOD-A5c Hueco Ascensor",
        ],
    },
    "OBRA-Centro Comercial Sur": {
        "Sótano": [
            "MOD-B1 Losa Sótano",
            "MOD-B1b Muros Contención",
            "MOD-B1c Rampas Parking",
            "MOD-B1d Pilares Sótano",
        ],
        "Planta Comercial": [
            "MOD-B2 Forjado Comercial",
            "MOD-B2b Pilares Comercial",
            "MOD-B2c Escaleras Mecánicas",
        ],
        "Planta Ocio": [
            "MOD-B3 Forjado Ocio",
            "MOD-B3b Zona Cines",
            "MOD-B3c Food Court",
        ],
        "Cubierta": [
            "MOD-B4 Cubierta",
            "MOD-B4b Lucernarios",
            "MOD-B4c Instalaciones",
        ],
    },
    "OBRA-Hospital Regional": {
        "Planta -1": [
            "MOD-C1 Cimentación Urgencias",
            "MOD-C1b Parking Ambulancias",
            "MOD-C1c Almacén",
        ],
        "Planta 0": [
            "MOD-C2 Forjado Consultas",
            "MOD-C2b Recepción",
            "MOD-C2c Zona Espera",
            "MOD-C2d Farmacia",
        ],
        "Planta 1": [
            "MOD-C3 Forjado Quirófanos",
            "MOD-C3b Área Estéril",
            "MOD-C3c Recuperación",
        ],
        "Planta 2": [
            "MOD-C4 Forjado UCI",
            "MOD-C4b Boxes UCI",
            "MOD-C4c Control Enfermería",
        ],
        "Cubierta": [
            "MOD-C5 Helipuerto",
            "MOD-C5b Instalaciones HVAC",
            "MOD-C5c Depósitos Agua",
        ],
    },
    "OBRA-Estación Metro L4": {
        "Nivel -3": [
            "MOD-D1 Pantallas Acceso",
            "MOD-D1b Túnel Principal",
            "MOD-D1c Galería Servicios",
        ],
        "Nivel -2": [
            "MOD-D2 Losa Vestíbulo",
            "MOD-D2b Torniquetes",
            "MOD-D2c Escaleras Mecánicas",
        ],
        "Nivel -1": [
            "MOD-D3 Losa Andenes",
            "MOD-D3b Andén Norte",
            "MOD-D3c Andén Sur",
        ],
    },
    "OBRA-Parking Aeropuerto": {
        "Nivel 0": [
            "MOD-E1 Cimentación General",
            "MOD-E1b Acceso Principal",
            "MOD-E1c Control Vehículos",
        ],
        "Nivel 1": [
            "MOD-E2 Forjado Nivel 1",
            "MOD-E2b Rampas N1",
            "MOD-E2c Núcleos Escaleras N1",
        ],
        "Nivel 2": [
            "MOD-E3 Forjado Nivel 2",
            "MOD-E3b Rampas N2",
            "MOD-E3c Núcleos Escaleras N2",
        ],
        "Nivel 3": [
            "MOD-E4 Forjado Nivel 3",
            "MOD-E4b Rampas N3",
            "MOD-E4c Núcleos Escaleras N3",
        ],
        "Nivel 4": [
            "MOD-E5 Cubierta",
            "MOD-E5b Placas Solares",
            "MOD-E5c Pasarela Terminal",
        ],
    },
}

plantas_count = 0
modulos_count = 0

for proyecto in proyectos:
    plantas_data = proyecto_plantas_modulos.get(proyecto.nombre, {})
    orden_planta = 0
    
    for planta_nombre, modulos_nombres in plantas_data.items():
        # Crear la Planta
        planta = Planta.objects.create(
            nombre=planta_nombre,
            proyecto=proyecto,
            orden=orden_planta
        )
        plantas_count += 1
        orden_planta += 1
        print(f"    ✓ Planta: {proyecto.nombre} / {planta_nombre}")
        
        for mod_nombre in modulos_nombres:
            modulo = Modulo.objects.create(
                nombre=mod_nombre,
                planta=planta,
                proyecto=proyecto
            )
            modulos_count += 1
            
            # Crear imagen INFERIOR
            Imagen.objects.create(
                modulo=modulo,
                url=f"/media/planos/{mod_nombre.lower().replace(' ', '_')}_inferior.png",
                fase=Fase.INFERIOR,
                orden=1,
                version=1,
                activo=True
            )
            
            # Crear imagen SUPERIOR
            Imagen.objects.create(
                modulo=modulo,
                url=f"/media/planos/{mod_nombre.lower().replace(' ', '_')}_superior.png",
                fase=Fase.SUPERIOR,
                orden=1,
                version=1,
                activo=True
            )
            
            print(f"        ✓ {mod_nombre} (2 imágenes)")

# =============================================================================
# MESAS DE TRABAJO
# =============================================================================
print("\n[4] Creando Mesas de Trabajo...")

mesas_data = [
    "Mesa-01 Zona A",
    "Mesa-02 Zona A", 
    "Mesa-03 Zona B",
    "Mesa-04 Zona B",
    "Mesa-05 Zona C",
    "Mesa-06 Zona C",
    "Mesa-07 Exterior",
    "Mesa-08 Exterior",
    "Mesa Test",
]

for mesa_nombre in mesas_data:
    Mesa.objects.create(
        nombre=mesa_nombre,
        usuario=admin
    )
    print(f"    ✓ {mesa_nombre}")

# =============================================================================
# RESUMEN
# =============================================================================
print("\n" + "=" * 60)
print("RESUMEN")
print("=" * 60)
print(f"  Proyectos creados:  {len(proyectos)}")
print(f"  Plantas creadas:    {plantas_count}")
print(f"  Módulos totales:    {modulos_count}")
print(f"  Imágenes totales:   {Imagen.objects.filter(modulo__nombre__startswith='MOD-').count()}")
print(f"  Mesas creadas:      {len(mesas_data)}")
print("=" * 60)
print("✓ BASE DE DATOS POBLADA CORRECTAMENTE")
print("=" * 60)
