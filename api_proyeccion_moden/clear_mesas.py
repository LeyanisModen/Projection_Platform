import os
import django
import sys

# Setup Django environment
sys.path.append(os.getcwd())
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')
django.setup()

from api.models import Mesa

try:
    count = Mesa.objects.count()
    Mesa.objects.all().delete()
    print(f"Successfully deleted {count} mesas.")
except Exception as e:
    print(f"Error deleting mesas: {e}")
