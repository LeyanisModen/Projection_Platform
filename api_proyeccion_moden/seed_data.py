"""
Script de poblado de datos de ejemplo para MOD:EN.
Ejecutar con: docker-compose exec backend python manage.py shell < seed_data.py
O importando y llamando a seed() desde el shell.
"""
from django.contrib.auth.models import User
from api.models import Proyecto, Modulo, Imagen, Mesa

def seed():
    # Crear usuario admin si no existe
    admin, created = User.objects.get_or_create(username='admin')
    if created:
        admin.set_password('admin')
        admin.is_superuser = True
        admin.is_staff = True
        admin.save()
        print("Usuario admin creado.")

    # Proyecto 1: Nave Industrial Ficticia
    p1, _ = Proyecto.objects.get_or_create(nombre="Nave Industrial Norte", usuario_id=admin.id)
    
    # Módulos del Proyecto 1 (con fases Inferior/Superior)
    m1_inf, _ = Modulo.objects.get_or_create(nombre="Módulo 1 - Inferior", planta="Inferior", proyecto_id=p1.id)
    m1_sup, _ = Modulo.objects.get_or_create(nombre="Módulo 1 - Superior", planta="Superior", proyecto_id=p1.id)
    m2_inf, _ = Modulo.objects.get_or_create(nombre="Módulo 2 - Inferior", planta="Inferior", proyecto_id=p1.id)
    m2_sup, _ = Modulo.objects.get_or_create(nombre="Módulo 2 - Superior", planta="Superior", proyecto_id=p1.id)
    m3_inf, _ = Modulo.objects.get_or_create(nombre="Módulo 3 - Inferior", planta="Inferior", proyecto_id=p1.id)
    m3_sup, _ = Modulo.objects.get_or_create(nombre="Módulo 3 - Superior", planta="Superior", proyecto_id=p1.id)

    # Imágenes de ejemplo (URLs placeholder)
    for mod in [m1_inf, m1_sup, m2_inf, m2_sup, m3_inf, m3_sup]:
        for i in range(1, 4):  # 3 imágenes por módulo
            Imagen.objects.get_or_create(
                url=f"https://via.placeholder.com/1920x1080.png?text={mod.nombre.replace(' ', '+')}+Plano+{i}",
                tipo=f"Plano {i}",
                modulo_id=mod.id
            )

    # Proyecto 2: Edificio Residencial
    p2, _ = Proyecto.objects.get_or_create(nombre="Edificio Residencial Sur", usuario_id=admin.id)
    m4_inf, _ = Modulo.objects.get_or_create(nombre="Bloque A - Inferior", planta="Inferior", proyecto_id=p2.id)
    m4_sup, _ = Modulo.objects.get_or_create(nombre="Bloque A - Superior", planta="Superior", proyecto_id=p2.id)
    for mod in [m4_inf, m4_sup]:
        for i in range(1, 3):
            Imagen.objects.get_or_create(
                url=f"https://via.placeholder.com/1920x1080.png?text={mod.nombre.replace(' ', '+')}+Plano+{i}",
                tipo=f"Plano {i}",
                modulo_id=mod.id
            )

    # Mesas de trabajo
    Mesa.objects.get_or_create(nombre="Mesa 1", usuario_id=admin.id)
    Mesa.objects.get_or_create(nombre="Mesa 2", usuario_id=admin.id)
    Mesa.objects.get_or_create(nombre="Mesa 3", usuario_id=admin.id)

    print("Datos de ejemplo creados correctamente.")
    print(f"Proyectos: {Proyecto.objects.count()}")
    print(f"Módulos: {Modulo.objects.count()}")
    print(f"Imágenes: {Imagen.objects.count()}")
    print(f"Mesas: {Mesa.objects.count()}")

if __name__ == "__main__":
    seed()
