"""
WSGI config for proyeccion_moden project.

It exposes the WSGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/wsgi/
"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')

application = get_wsgi_application()

try:
    from django.contrib.auth import get_user_model
    User = get_user_model()
    username = os.environ.get('DJANGO_SUPERUSER_USERNAME')
    password = os.environ.get('DJANGO_SUPERUSER_PASSWORD')
    email = os.environ.get('DJANGO_SUPERUSER_EMAIL', 'admin@example.com')
    
    if username and password:
        print(f"WSGI Hook: Checking Admin User {username}...")
        if not User.objects.filter(username=username).exists():
            print(f"WSGI Hook: Creating user {username}...")
            User.objects.create_superuser(username, email, password)
            print("WSGI Hook: User CREATED.")
        else:
            print(f"WSGI Hook: Updating password for {username}...")
            u = User.objects.get(username=username)
            u.set_password(password)
            u.save()
            print("WSGI Hook: Password UPDATED.")
except Exception as e:
    print(f"WSGI Hook Error: {e}")
