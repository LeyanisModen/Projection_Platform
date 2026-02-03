import os
import django
import sys

# Setup Django environment
sys.path.append(os.getcwd())
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')
django.setup()

from django.contrib.auth.models import User
from api.models import Proyecto

username = 'test_ferralla'

try:
    user = User.objects.get(username=username)
    print(f"User: {user.username}")
    print(f"Is Staff: {user.is_staff}")
    print(f"Is Superuser: {user.is_superuser}")
    
    # Check what projects are assigned
    assigned_projects = Proyecto.objects.filter(usuario=user)
    print(f"Assigned Projects: {[p.nombre for p in assigned_projects]}")
    
    # Check all projects
    all_projects = Proyecto.objects.all()
    print(f"All Projects: {[p.nombre for p in all_projects]}")

except User.DoesNotExist:
    print(f"User '{username}' does not exist.")
