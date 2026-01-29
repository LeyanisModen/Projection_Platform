import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')
django.setup()

from django.contrib.auth.models import User
from django.contrib.auth import authenticate

username = 'test_ferralla'
password = 'test'

try:
    user = User.objects.get(username=username)
    print(f"User found: {user.username}")
    print(f"Active: {user.is_active}")
    
    auth_user = authenticate(username=username, password=password)
    if auth_user:
        print("Authentication Successful!")
    else:
        print("Authentication Failed: Invalid password.")
        
except User.DoesNotExist:
    print(f"User '{username}' does not exist.")
