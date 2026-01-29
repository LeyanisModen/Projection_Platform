import os
import django
import sys
from django.db import connections
from django.db.utils import OperationalError

# Setup Django environment
sys.path.append(os.getcwd())
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')
django.setup()

def check_db():
    db_conn = connections['default']
    print(f"DB Settings: Host={db_conn.settings_dict['HOST']}, Port={db_conn.settings_dict['PORT']}, Name={db_conn.settings_dict['NAME']}")
    try:
        c = db_conn.cursor()
        c.execute("SELECT 1")
        print("Database connection check successful!")
    except OperationalError as e:
        print(f"Database connection failed: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == '__main__':
    check_db()
