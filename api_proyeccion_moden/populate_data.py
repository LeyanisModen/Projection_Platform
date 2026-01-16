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
from api.models import Proyecto, Modulo, Imagen, Mesa, ModuloQueue, Fase

# Obtener usuario admin
admin = User.objects.get(username='admin')

print("=" * 60)
print("POBLANDO BASE DE DATOS CON DATOS DE EJEMPLO")
print("=" * 60)

# =============================================================================
# LIMPIAR DATOS ANTERIORES (opcional)
# =============================================================================
print("\n[1] Limpiando datos de prueba anteriores...")
Imagen.objects.filter(modulo__nombre__startswith='MOD-').delete()
Modulo.objects.filter(nombre__startswith='MOD-').delete()
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
# MÓDULOS POR PROYECTO
# =============================================================================
print("\n[3] Creando Módulos con Imágenes...")

modulos_por_proyecto = {
    "OBRA-Edificio Nervión": [
        ("MOD-A1 Armadura Cimentación", "Sótano -2"),
        ("MOD-A2 Armadura Forjado P0", "Planta 0"),
        ("MOD-A3 Armadura Forjado P1", "Planta 1"),
        ("MOD-A4 Armadura Forjado P2", "Planta 2"),
        ("MOD-A5 Pilares P0-P2", "Plantas 0-2"),
        ("MOD-A6 Muros Sótano", "Sótano -1"),
    ],
    "OBRA-Centro Comercial Sur": [
        ("MOD-B1 Losa Sótano", "Sótano"),
        ("MOD-B2 Forjado Comercial", "Planta Comercial"),
        ("MOD-B3 Forjado Ocio", "Planta Ocio"),
        ("MOD-B4 Cubierta", "Cubierta"),
    ],
    "OBRA-Hospital Regional": [
        ("MOD-C1 Cimentación Urgencias", "Planta -1"),
        ("MOD-C2 Forjado Consultas", "Planta 0"),
        ("MOD-C3 Forjado Quirófanos", "Planta 1"),
        ("MOD-C4 Forjado UCI", "Planta 2"),
        ("MOD-C5 Helipuerto", "Cubierta"),
    ],
    "OBRA-Estación Metro L4": [
        ("MOD-D1 Pantallas Acceso", "Nivel -3"),
        ("MOD-D2 Losa Vestíbulo", "Nivel -2"),
        ("MOD-D3 Losa Andenes", "Nivel -1"),
    ],
    "OBRA-Parking Aeropuerto": [
        ("MOD-E1 Cimentación General", "Nivel 0"),
        ("MOD-E2 Forjado Nivel 1", "Nivel 1"),
        ("MOD-E3 Forjado Nivel 2", "Nivel 2"),
        ("MOD-E4 Forjado Nivel 3", "Nivel 3"),
        ("MOD-E5 Cubierta", "Nivel 4"),
    ],
}

for proyecto in proyectos:
    modulos_data = modulos_por_proyecto.get(proyecto.nombre, [])
    for mod_nombre, mod_planta in modulos_data:
        modulo = Modulo.objects.create(
            nombre=mod_nombre,
            planta=mod_planta,
            proyecto=proyecto
        )
        
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
        
        print(f"    ✓ {mod_nombre} (2 imágenes: INF + SUP)")

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
print(f"  Módulos totales:    {Modulo.objects.filter(nombre__startswith='MOD-').count()}")
print(f"  Imágenes totales:   {Imagen.objects.filter(modulo__nombre__startswith='MOD-').count()}")
print(f"  Mesas creadas:      {Mesa.objects.filter(nombre__startswith='Mesa-').count()}")
print("=" * 60)
print("✓ BASE DE DATOS POBLADA CORRECTAMENTE")
print("=" * 60)
