"""
Verification script for database integrity (Phase BD-6)
Tests the complete flow: Project -> Module -> Images -> Queues -> WorkItems
"""
import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'proyeccion_moden.settings')
django.setup()

from django.contrib.auth.models import User
from django.utils import timezone
from api.models import (
    Proyecto, Modulo, Imagen, Mesa,
    ModuloQueue, ModuloQueueItem, MesaQueueItem,
    Fase, MesaQueueStatus, ModuloEstado
)


def clean_test_data():
    """Remove any existing test data."""
    MesaQueueItem.objects.filter(modulo__nombre__startswith='TEST_').delete()
    ModuloQueueItem.objects.filter(modulo__nombre__startswith='TEST_').delete()
    ModuloQueue.objects.filter(proyecto__nombre__startswith='TEST_').delete()
    Mesa.objects.filter(nombre__startswith='TEST_').delete()
    Imagen.objects.filter(modulo__nombre__startswith='TEST_').delete()
    Modulo.objects.filter(nombre__startswith='TEST_').delete()
    Proyecto.objects.filter(nombre__startswith='TEST_').delete()


def run_verification():
    print("=" * 60)
    print("VERIFICACIÓN DE INTEGRIDAD DE BASE DE DATOS (BD-6)")
    print("=" * 60)
    
    # Get or create test user
    user, _ = User.objects.get_or_create(
        username='test_supervisor',
        defaults={'email': 'test@test.com'}
    )
    
    # Clean previous test data
    clean_test_data()
    
    # STEP 1: Create Project
    print("\n[1] Creando Proyecto...")
    proyecto = Proyecto.objects.create(
        nombre='TEST_Edificio Alpha',
        usuario=user
    )
    print(f"    ✓ Proyecto creado: {proyecto}")
    
    # STEP 2: Create Module
    print("\n[2] Creando Módulo...")
    modulo = Modulo.objects.create(
        nombre='TEST_Armadura 5',
        planta='Planta Baja',
        proyecto=proyecto
    )
    print(f"    ✓ Módulo creado: {modulo}")
    print(f"    Estado inicial: {modulo.estado}")
    assert modulo.estado == ModuloEstado.PENDIENTE, "Estado debería ser PENDIENTE"
    
    # STEP 3: Create Images (Inferior and Superior)
    print("\n[3] Creando Imágenes (Inferior/Superior)...")
    img_inferior = Imagen.objects.create(
        url='/media/planos/armadura5_inferior.png',
        modulo=modulo,
        fase=Fase.INFERIOR,
        orden=1,
        version=1
    )
    img_superior = Imagen.objects.create(
        url='/media/planos/armadura5_superior.png',
        modulo=modulo,
        fase=Fase.SUPERIOR,
        orden=1,
        version=1
    )
    print(f"    ✓ Imagen Inferior: {img_inferior}")
    print(f"    ✓ Imagen Superior: {img_superior}")
    
    # STEP 4: Create ModuloQueue for Project
    print("\n[4] Creando Cola de Módulos para el Proyecto...")
    modulo_queue = ModuloQueue.objects.create(
        proyecto=proyecto,
        created_by=user
    )
    print(f"    ✓ Cola creada: {modulo_queue}")
    
    # STEP 5: Add Module to Queue
    print("\n[5] Añadiendo Módulo a la Cola (posición 1)...")
    queue_item = ModuloQueueItem.objects.create(
        queue=modulo_queue,
        modulo=modulo,
        position=1,
        added_by=user
    )
    print(f"    ✓ Item en cola: {queue_item}")
    
    # STEP 6: Create Mesa
    print("\n[6] Creando Mesa de trabajo...")
    mesa = Mesa.objects.create(
        nombre='TEST_Mesa 1',
        usuario=user
    )
    print(f"    ✓ Mesa creada: {mesa}")
    
    # STEP 7: Assign WorkItem (Inferior phase) to Mesa
    print("\n[7] Asignando WorkItem (INFERIOR) a Mesa...")
    work_item_inf = MesaQueueItem.objects.create(
        mesa=mesa,
        modulo=modulo,
        fase=Fase.INFERIOR,
        imagen=img_inferior,
        position=1,
        status=MesaQueueStatus.EN_COLA,
        assigned_by=user
    )
    print(f"    ✓ WorkItem creado: {work_item_inf}")
    
    # STEP 8: Mark WorkItem as DONE and verify module status
    print("\n[8] Marcando WorkItem INFERIOR como HECHO...")
    work_item_inf.marcar_hecho(user=user)
    modulo.refresh_from_db()
    print(f"    ✓ WorkItem status: {work_item_inf.status}")
    print(f"    ✓ Módulo inferior_hecho: {modulo.inferior_hecho}")
    print(f"    ✓ Módulo estado: {modulo.estado}")
    assert modulo.inferior_hecho == True, "inferior_hecho debería ser True"
    assert modulo.estado == ModuloEstado.EN_PROGRESO, "Estado debería ser EN_PROGRESO"
    
    # STEP 9: Assign and complete Superior phase
    print("\n[9] Asignando y completando WorkItem (SUPERIOR)...")
    work_item_sup = MesaQueueItem.objects.create(
        mesa=mesa,
        modulo=modulo,
        fase=Fase.SUPERIOR,
        imagen=img_superior,
        position=2,
        status=MesaQueueStatus.EN_COLA,
        assigned_by=user
    )
    work_item_sup.marcar_hecho(user=user)
    modulo.refresh_from_db()
    print(f"    ✓ WorkItem SUPERIOR status: {work_item_sup.status}")
    print(f"    ✓ Módulo superior_hecho: {modulo.superior_hecho}")
    print(f"    ✓ Módulo estado: {modulo.estado}")
    assert modulo.superior_hecho == True, "superior_hecho debería ser True"
    assert modulo.estado == ModuloEstado.COMPLETADO, "Estado debería ser COMPLETADO"
    
    # STEP 10: Supervisor closes module
    print("\n[10] Supervisor cierra el módulo...")
    modulo.cerrado = True
    modulo.cerrado_at = timezone.now()
    modulo.cerrado_by = user
    modulo.actualizar_estado()
    modulo.refresh_from_db()
    print(f"    ✓ Módulo cerrado: {modulo.cerrado}")
    print(f"    ✓ Módulo estado: {modulo.estado}")
    assert modulo.estado == ModuloEstado.CERRADO, "Estado debería ser CERRADO"
    
    print("\n" + "=" * 60)
    print("✓ TODAS LAS VERIFICACIONES PASARON CORRECTAMENTE")
    print("=" * 60)
    
    # Clean up
    clean_test_data()
    print("\n[Cleanup] Datos de prueba eliminados.")


if __name__ == '__main__':
    run_verification()
