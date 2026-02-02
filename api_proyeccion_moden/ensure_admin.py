import os
import django
import sys

# Setup Django environment
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "proyeccion_moden.settings")
django.setup()

from django.contrib.auth.models import User

def ensure_admin():
    username = os.environ.get('DJANGO_SUPERUSER_USERNAME', 'Moden')
    password = os.environ.get('DJANGO_SUPERUSER_PASSWORD', 'admin')
    email = os.environ.get('DJANGO_SUPERUSER_EMAIL', 'admin@example.com')

    print(f"--- Checking Admin User: {username} ---")

    try:
        if not User.objects.filter(username=username).exists():
            print(f"User {username} not found. Creating...")
            User.objects.create_superuser(username, email, password)
            print("SUCCESS: Superuser created.")
        else:
            print(f"User {username} exists. Resetting password...")
            u = User.objects.get(username=username)
            u.set_password(password)
            u.save()
            print("SUCCESS: Password updated.")
    except Exception as e:
        print(f"ERROR: Could not create/update user: {e}")

if __name__ == "__main__":
    ensure_admin()
