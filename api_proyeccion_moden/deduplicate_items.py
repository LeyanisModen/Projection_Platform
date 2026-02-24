
import os
import django
from django.db.models import Count

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "proyeccion_moden.settings")
django.setup()

from api.models import MesaQueueItem

print("--- REMOVING DUPLICATE MESA QUEUE ITEMS ---")

# Find duplicates
duplicates = MesaQueueItem.objects.values('modulo', 'fase').annotate(count=Count('id')).filter(count__gt=1)

count_deleted = 0

for dup in duplicates:
    modulo_id = dup['modulo']
    fase = dup['fase']
    
    items = MesaQueueItem.objects.filter(modulo_id=modulo_id, fase=fase).order_by('-id')
    
    print(f"Checking duplicates for Modulo {modulo_id} ({fase}). Found {items.count()} items.")
    
    # Logic: Keep the one that is MOSTRANDO, or if none, the latest one.
    mostrando_items = items.filter(status='MOSTRANDO')
    
    if mostrando_items.exists():
        keeper = mostrando_items.first()
    else:
        keeper = items.first() # The latest one because of -id ordering
        
    print(f"  -> Keeping Item ID {keeper.id} (Status: {keeper.status}, Mesa: {keeper.mesa.id})")
    
    for item in items:
        if item.id != keeper.id:
            print(f"  -> DELETING Item ID {item.id} (Status: {item.status}, Mesa: {item.mesa.id})")
            item.delete()
            count_deleted += 1

print(f"--- DATA CLEANUP COMPLETE. Deleted {count_deleted} items. ---")
