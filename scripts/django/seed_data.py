"""Create a small set of development data for MOD:EN.

Run from api_proyeccion_moden with:
    python manage.py shell < ../scripts/django/seed_data.py
"""

from django.contrib.auth.models import User

from api.models import Fase, Imagen, ImagenStatus, Mesa, Modulo, Proyecto


def _create_demo_images(module, image_count):
    for phase in (Fase.INFERIOR, Fase.SUPERIOR):
        for order in range(1, image_count + 1):
            Imagen.objects.get_or_create(
                modulo=module,
                fase=phase,
                orden=order,
                version=1,
                defaults={
                    "url": (
                        "https://via.placeholder.com/1920x1080.png"
                        f"?text={module.nombre.replace(' ', '+')}+{phase}+Plano+{order}"
                    ),
                    "tipo": f"Plano {order}",
                    "status": ImagenStatus.PUBLISHED,
                    "activo": True,
                },
            )


def seed():
    admin, created = User.objects.get_or_create(username="Moden")
    if created:
        admin.set_password("admin")
        admin.is_superuser = True
        admin.is_staff = True
        admin.save()
        print("Usuario admin creado.")

    project_one, _ = Proyecto.objects.get_or_create(
        nombre="Nave Industrial Norte",
        usuario=admin,
    )
    for module_name in ("Modulo 1", "Modulo 2", "Modulo 3"):
        module, _ = Modulo.objects.get_or_create(
            nombre=module_name,
            proyecto=project_one,
        )
        _create_demo_images(module, 3)

    project_two, _ = Proyecto.objects.get_or_create(
        nombre="Edificio Residencial Sur",
        usuario=admin,
    )
    module, _ = Modulo.objects.get_or_create(
        nombre="Bloque A",
        proyecto=project_two,
    )
    _create_demo_images(module, 2)

    for table_name in ("Mesa 1", "Mesa 2", "Mesa 3"):
        Mesa.objects.get_or_create(nombre=table_name, usuario=admin)

    print("Datos de ejemplo creados correctamente.")
    print(f"Proyectos: {Proyecto.objects.count()}")
    print(f"Modulos: {Modulo.objects.count()}")
    print(f"Imagenes: {Imagen.objects.count()}")
    print(f"Mesas: {Mesa.objects.count()}")


if __name__ == "__main__":
    seed()
