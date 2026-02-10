
import os
import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "proyeccion_moden.settings")
django.setup()

from api.models import Planta

print("--- INSPECTING PLANOS ---")
for planta in Planta.objects.all():
    print(f"ID: {planta.id} | Nombre: {planta.nombre}")
    if planta.plano_imagen:
        print(f"  -> Image Field: {planta.plano_imagen}")
        print(f"  -> URL Property: {planta.plano_imagen.url}")
        # Check if file exists
        try:
            path = planta.plano_imagen.path
            exists = os.path.exists(path)
            print(f"  -> File Path: {path}")
            print(f"  -> Exists on Disk: {exists}")
        except Exception as e:
            print(f"  -> Error getting path: {e}")
    else:
        print("  -> No Image")
    print("-" * 20)
