import os
import django
import sys
import time

# Setup Django environment
sys.path.append(os.getcwd())
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')
django.setup()

from django.contrib.auth.models import User

username_to_delete = 'usuario_fake_para_borrar'

# Create a fake user with some data to simulate load if needed, 
# but first let's just try to delete a simple user to see if the DB is locked.
try:
    if not User.objects.filter(username=username_to_delete).exists():
        user = User.objects.create_user(username=username_to_delete, password='pw')
        print(f"Created temp user {username_to_delete}")
    else:
        user = User.objects.get(username=username_to_delete)

    print(f"Attempting to delete user {username_to_delete}...")
    start_time = time.time()
    user.delete()
    end_time = time.time()
    print(f"Deletion successful in {end_time - start_time:.4f} seconds.")

except Exception as e:
    print(f"Error during deletion: {e}")
