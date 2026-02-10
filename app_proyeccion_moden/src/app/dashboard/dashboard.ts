import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';

import {
  ApiService,
  Proyecto, Planta, Modulo, Mesa, ModuloQueueItem, MesaQueueItem, Imagen
} from '../services/api.service';
import { Subject, takeUntil, forkJoin, interval } from 'rxjs';

// Logical entity for display and drag-drop
interface Subfase {
  id: string; // "moduloId-FASE" (e.g. "101-INFERIOR")
  modulo: Modulo;
  fase: 'INFERIOR' | 'SUPERIOR';
  imagenes: Imagen[];
  hecho: boolean;
  assigned: boolean;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  imports: [CommonModule, DragDropModule, FormsModule]
})
export class Dashboard implements OnInit, OnDestroy {
  // Sidebar State
  panelState: 'collapsed' | 'expanded' = 'expanded';
  navLevel: 'projects' | 'plants' | 'modules' = 'projects';

  // Data
  proyectos: Proyecto[] = [];
  plantas: Planta[] = [];
  modulos: Modulo[] = [];
  mesaQueueItems = new Map<number, MesaQueueItem[]>(); // mesaId -> items
  imagenes: Imagen[] = []; // Images for expanded module
  mesas: Mesa[] = [];

  // Subfases for the selected module
  activeSubfases: Subfase[] = [];

  // Data Loading States
  loadingProyectos = false;
  loadingPlantas = false;
  loadingModulos = false;
  loadingImagenes = false; // Loading images for expanded module
  loadingMesas = false;

  // Selection State
  selectedProyecto: Proyecto | null = null;
  selectedPlanta: Planta | null = null;
  selectedModulo: Modulo | null = null;

  // UI State
  expandedModulo: number | null = null; // ID of expanded module
  dragOverMesa: number | null = null; // ID of mesa being dragged over

  // Drag State
  draggedSubfase: Subfase | null = null;

  // Confirm Modal State
  showConfirmModal = false;
  confirmModalMessage = '';
  pendingActionItem: MesaQueueItem | null = null;
  pendingActionType: 'DELETE' | 'FINISH' | null = null;

  // Maps for tracking
  moduloImagenes = new Map<number, Imagen[]>(); // moduloId -> images

  // Track assignments by subfase ID ("moduloId-FASE")
  // value: { mesaName, status: 'EN_COLA' | 'MOSTRANDO' | 'HECHO' }
  subfaseAssignedToMesa = new Map<string, { mesaName: string, status: string }>();

  activePhases = new Set<string>(); // "moduloId-FASE" (e.g. "101-INFERIOR")

  // Pairing Modal State

  // Blueprint Modal State
  showBlueprintModal = false;
  blueprintUrl: string | null = null;

  verPlano(planta: Planta): void {
    if (planta.plano_imagen) {
      this.blueprintUrl = planta.plano_imagen;
      this.showBlueprintModal = true;
      this.cdr.detectChanges();
    }
  }

  cerrarBlueprintModal(): void {
    this.showBlueprintModal = false;
    this.blueprintUrl = null;
    this.cdr.detectChanges();
  }


  // Breadcrumb Navigation
  navigateTo(level: 'projects' | 'plants'): void {
    if (level === 'projects') {
      this.selectedProyecto = null;
      this.selectedPlanta = null;
      this.selectedModulo = null;
      this.navLevel = 'projects';
      this.loadProyectos();
    } else if (level === 'plants' && this.selectedProyecto) {
      this.selectedPlanta = null;
      this.selectedModulo = null;
      this.navLevel = 'plants';
      this.loadPlantasForProyecto(this.selectedProyecto.id);
    }
  }

  private destroy$ = new Subject<void>();

  constructor(private api: ApiService, private cdr: ChangeDetectorRef, private router: Router) { }

  username: string = '';

  ngOnInit(): void {
    // Check auth
    if (!this.api.isLoggedIn()) {
      this.router.navigate(['/']);
      return;
    }

    this.username = this.api.getUsername() || 'Usuario';

    this.username = this.api.getUsername() || 'Usuario';

    // Prevent back navigation
    history.pushState(null, '', location.href);
    window.onpopstate = function () {
      history.go(1);
    };

    this.loadProyectos();
    this.loadMesas();

    // Start Polling for Queue Updates (Every 5 seconds)
    // This handles the "Auto-DJ" logic: if an item finishes, the next one is picked up
    interval(5000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.pollMesasQueue();
        this.refreshActivePlantaModules();
      });
  }

  logout(): void {
    this.api.logout();
    this.router.navigate(['/']);
  }

  // Polling function to refresh queues and check for auto-advance
  pollMesasQueue(): void {
    // Only poll if we have mesas loaded
    if (this.mesas.length === 0) return;

    this.mesas.forEach(mesa => {
      this.api.getMesaQueueItems(mesa.id)
        .pipe(takeUntil(this.destroy$))
        .subscribe({
          next: (items) => {
            // Logic for Auto-Advance
            // If the queue has items, and the FIRST item is 'EN_COLA' (Pending),
            // it means the previous 'MOSTRANDO' item has finished (it's gone from the list).
            // We should automatically promote this new first item to 'MOSTRANDO'.

            // 1. Filter active items (API might return HECHO depending on implementation, but typically filtered)
            // FORCE SORT: MOSTRANDO always first
            const activeItems = items
              .filter(i => i.status !== 'HECHO')
              .sort((a, b) => {
                if (a.status === 'MOSTRANDO') return -1;
                if (b.status === 'MOSTRANDO') return 1;
                return a.position - b.position;
              });

            // 2. Check overlap with local state to avoid UI jitter, but crucial for logic
            // Update the map
            this.mesaQueueItems.set(mesa.id, activeItems);

            // 3. Clear STALE assignments for this mesa
            // We need to remove any assignment in `subfaseAssignedToMesa` that points to this mesa
            // BUT is not in the new `items` list (meaning it finished or was deleted).
            // This fixes the "Proyectando..." stuck status.
            for (let [key, val] of this.subfaseAssignedToMesa) {
              if (val.mesaName === mesa.nombre) {
                // Check if this subfase (key) is still in the current items list
                // Key format: "moduloId-FASE"
                const stillExists = items.some(i => `${i.modulo}-${i.fase}` === key && i.status !== 'HECHO');
                if (!stillExists) {
                  this.subfaseAssignedToMesa.delete(key);
                }
              }
            }

            // 4. Check for AUTO-ADVANCE condition
            if (activeItems.length > 0) {
              const firstItem = activeItems[0];
              if (firstItem.status === 'EN_COLA') {
                console.log(`[Dashboard] Auto-Advancing Mesa ${mesa.nombre} -> Showing ${firstItem.modulo_nombre}`);
                this.mostrarItem(firstItem);
              }
            }

            // 5. Update assignment tracking (for dots) with NEW items
            this.updateAssignmentTracking(mesa, items);

            this.cdr.detectChanges();
          },
          error: (err) => console.error(`Error polling queue for mesa ${mesa.id}`, err)
        });
    });
  }

  // Refactored helper to avoid code duplication in loadMesaQueueItems
  updateAssignmentTracking(mesa: Mesa, items: MesaQueueItem[]): void {
    // First, remove old assignments for this mesa from the tracking map? 
    // It's tricky because we iterate all items. 
    // Easier to just unset everything for this mesa first? 
    // Let's do a safe partial update: 
    // We can't easily "remove missing" without tracking what was there.
    // For now, let's just Upsert. Puts (dots) might be stale if item deleted remotely.
    // To fix stale dots, we might need a more robust sync, but for Auto-Advance this is fine.

    // Cleanest way: We can't clear ALL because other mesas exist.
    // We could iterate `subfaseAssignedToMesa` and remove entry if value.mesaName == mesa.nombre AND not in new list.
    // Implementing simplified update for now:

    items.forEach(item => {
      if (item.status !== 'HECHO') {
        const subfaseId = `${item.modulo}-${item.fase}`;
        this.subfaseAssignedToMesa.set(subfaseId, {
          mesaName: mesa.nombre,
          status: item.status
        });
      }
    });
  }

  // =========================================================================
  // SIDEBAR ACTIONS
  // =========================================================================
  togglePanel(): void {
    this.panelState = this.panelState === 'expanded' ? 'collapsed' : 'expanded';
    this.cdr.detectChanges();
  }

  navigateBack(): void {
    if (this.navLevel === 'modules') {
      this.navLevel = 'plants';
      this.selectedModulo = null;
      this.expandedModulo = null;
    } else if (this.navLevel === 'plants') {
      this.navLevel = 'projects';
      this.selectedPlanta = null;
      this.selectedModulo = null;
      this.expandedModulo = null;
    }
  }

  getHeaderTitle(): string {
    if (this.navLevel === 'projects') return 'Proyectos';
    if (this.navLevel === 'plants') return this.selectedProyecto?.nombre || 'Plantas';
    if (this.navLevel === 'modules') return this.selectedPlanta?.nombre || 'Módulos';
    return '';
  }



  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // =========================================================================
  // LOAD DATA
  // =========================================================================
  loadProyectos(): void {
    this.loadingProyectos = true;
    this.api.getProyectos()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.proyectos = data;
          this.loadingProyectos = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading proyectos', err);
          this.loadingProyectos = false;
        }
      });
  }

  loadMesas(): void {
    this.loadingMesas = true;
    // Clear assignment tracking before reloading
    this.subfaseAssignedToMesa.clear();
    this.api.getMesas()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.mesas = data;
          this.loadingMesas = false;
          this.cdr.detectChanges();
          this.mesas.forEach(mesa => this.loadMesaQueueItems(mesa.id));
        },
        error: (err) => {
          console.error('Error loading mesas', err);
          this.loadingMesas = false;
        }
      });
  }

  loadMesaQueueItems(mesaId: number): void {
    this.api.getMesaQueueItems(mesaId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (items) => {
          // First, remove old assignments for this mesa
          const oldItems = this.mesaQueueItems.get(mesaId) || [];
          oldItems.forEach(oldItem => {
            if (oldItem.status !== 'HECHO') {
              const subfaseId = `${oldItem.modulo}-${oldItem.fase}`;
              this.subfaseAssignedToMesa.delete(subfaseId);
            }
          });

          // Update the map with new items (Filter out HECHO for display)
          // FORCE SORT: MOSTRANDO always first, then by position/id
          const activeItems = items
            .filter(i => i.status !== 'HECHO')
            .sort((a, b) => {
              if (a.status === 'MOSTRANDO') return -1;
              if (b.status === 'MOSTRANDO') return 1;
              return a.position - b.position;
            });

          this.mesaQueueItems.set(mesaId, activeItems);

          // Track active subfases
          const mesa = this.mesas.find(m => m.id === mesaId);
          items.forEach(item => {
            if (item.status !== 'HECHO') {
              // We track assignment by subfase key
              const subfaseId = `${item.modulo}-${item.fase}`;
              this.subfaseAssignedToMesa.set(subfaseId, {
                mesaName: mesa?.nombre || `Mesa ${mesaId}`,
                status: item.status
              });
            }
          });

          // Refresh active subfases view if needed
          if (this.selectedModulo && this.expandedModulo === this.selectedModulo.id) {
            this.buildActiveSubfases(this.selectedModulo);
          }

          this.cdr.detectChanges();
        },
        error: (err) => console.error(`Error loading queue for mesa ${mesaId}`, err)
      });
  }

  // =========================================================================
  // PROJECT SELECTION
  // =========================================================================
  selectProyecto(proyecto: Proyecto): void {
    this.selectedProyecto = proyecto;
    this.selectedPlanta = null;
    this.selectedModulo = null;
    this.navLevel = 'plants'; // Drill down
    this.loadPlantasForProyecto(proyecto.id);
  }

  loadPlantasForProyecto(proyectoId: number): void {
    this.loadingPlantas = true;
    this.api.getPlantas(proyectoId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.plantas = data;
          this.loadingPlantas = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading plantas', err);
          this.loadingPlantas = false;
        }
      });
  }

  // =========================================================================
  // PLANTA SELECTION
  // =========================================================================
  selectPlanta(planta: Planta): void {
    this.selectedPlanta = planta;
    this.selectedModulo = null;
    this.navLevel = 'modules'; // Drill down
    this.loadModulosForPlanta(planta.id);
  }

  loadModulosForPlanta(plantaId: number): void {
    this.loadingModulos = true;
    this.api.getModulos(plantaId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          // Sort: Incomplete first, Complete last
          // Sort: Incomplete first, Complete last
          // Sort: Incomplete first, Complete last
          // Force new array reference
          this.modulos = [...this.sortModulos(data)];
          console.log('[Dashboard] Loaded modules:', this.modulos.map(m => `${m.nombre}:${this.isModuloComplete(m)}`));
          this.loadingModulos = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading modulos', err);
          this.loadingModulos = false;
        }
      });
  }

  // Silent refresh for module status updates (polled)
  refreshActivePlantaModules(): void {
    if (!this.selectedPlanta || this.loadingModulos) return;

    this.api.getModulos(this.selectedPlanta.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          // Update list with standard sort
          this.modulos = [...this.sortModulos(data)];

          // Update selectedModulo reference if it matches
          if (this.selectedModulo) {
            const updated = this.modulos.find(m => m.id === this.selectedModulo!.id);
            if (updated) {
              this.selectedModulo = updated;
              // CRITICAL: Rebuild active subfases so the sidebar reflects the new state (e.g. checkmark) immediately
              if (this.expandedModulo === updated.id) {
                this.buildActiveSubfases(updated);
              }
            }
          }
          this.cdr.detectChanges();
        },
        error: (err) => console.error('[Dashboard] Error refreshing modules', err)
      });
  }

  // =========================================================================
  // MODULE EXPANSION (to show images)
  // =========================================================================
  toggleModulo(modulo: Modulo): void {
    if (this.selectedModulo?.id === modulo.id) {
      this.selectedModulo = null;
      this.expandedModulo = null;
      this.activeSubfases = [];
    } else {
      this.selectedModulo = modulo;
      this.expandedModulo = modulo.id;
      this.loadImagenesForModulo(modulo);
    }
    this.cdr.detectChanges();
  }

  loadImagenesForModulo(modulo: Modulo): void {
    // If we already have images, just build subfases
    if (this.moduloImagenes.has(modulo.id)) {
      this.buildActiveSubfases(modulo);
      return;
    }

    this.loadingImagenes = true;
    this.api.getModuloImagenes(modulo.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (imagenes) => {
          this.moduloImagenes.set(modulo.id, imagenes);
          this.buildActiveSubfases(modulo);
          this.loadingImagenes = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading imagenes', err);
          this.loadingImagenes = false;
        }
      });
  }

  buildActiveSubfases(modulo: Modulo): void {
    const imagenes = this.moduloImagenes.get(modulo.id) || [];

    // Create the two standard subfases
    const subfaseInf: Subfase = {
      id: `${modulo.id}-INFERIOR`,
      modulo: modulo,
      fase: 'INFERIOR',
      imagenes: imagenes.filter(img => img.fase === 'INFERIOR'),
      hecho: modulo.inferior_hecho,
      assigned: this.subfaseAssignedToMesa.has(`${modulo.id}-INFERIOR`)
    };

    const subfaseSup: Subfase = {
      id: `${modulo.id}-SUPERIOR`,
      modulo: modulo,
      fase: 'SUPERIOR',
      imagenes: imagenes.filter(img => img.fase === 'SUPERIOR'),
      hecho: modulo.superior_hecho,
      assigned: this.subfaseAssignedToMesa.has(`${modulo.id}-SUPERIOR`)
    };

    this.activeSubfases = [subfaseInf, subfaseSup];
  }

  // =========================================================================
  // SUBFASE DRAG AND DROP
  // =========================================================================
  onSubfaseDragStart(event: DragEvent, subfase: Subfase): void {
    if (subfase.assigned || subfase.hecho) {
      event.preventDefault();
      return;
    }

    console.log('[Dashboard] Drag Start Subfase:', subfase.id);
    this.draggedSubfase = subfase;

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', JSON.stringify({
        subfaseId: subfase.id,
        moduloId: subfase.modulo.id,
        fase: subfase.fase,
        imageCount: subfase.imagenes.length
      }));
    }
  }

  onDragEnd(event: DragEvent): void {
    this.draggedSubfase = null;
    this.dragOverMesa = null;
    this.cdr.detectChanges();
  }

  onDragOver(event: DragEvent, mesa: Mesa): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverMesa = mesa.id;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onDragLeave(event: DragEvent): void {
    this.dragOverMesa = null;
    this.cdr.detectChanges();
  }

  async onSubfaseDrop(event: DragEvent, mesa: Mesa) {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverMesa = null;

    if (!this.draggedSubfase) {
      console.warn('[Dashboard] Drop failed: No dragged subfase');
      return;
    }

    const subfase = this.draggedSubfase;
    this.draggedSubfase = null;

    // Check if subfase is already assigned
    const assignment = this.subfaseAssignedToMesa.get(subfase.id);
    if (assignment) {
      alert(`⚠️ Esta fase (${subfase.fase}) ya está asignada a ${assignment.mesaName}`);
      this.cdr.detectChanges();
      return;
    }

    // Get current queue length for position
    const currentItems = this.mesaQueueItems.get(mesa.id) || [];
    let nextPosition = currentItems.length + 1;

    try {
      // Show optimistic update
      this.subfaseAssignedToMesa.set(subfase.id, { mesaName: mesa.nombre, status: 'EN_COLA' });
      if (this.selectedModulo && this.expandedModulo === subfase.modulo.id) {
        subfase.assigned = true;
      }
      this.cdr.detectChanges();

      // Create SINGLE item for the subfase (no image linked)
      await this.api.createMesaQueueItem(
        mesa.id,
        subfase.modulo.id,
        subfase.fase,
        null, // No specific image
        nextPosition
      ).toPromise();

      // Reload queue to confirm
      this.loadMesaQueueItems(mesa.id);

    } catch (err) {
      console.error('Error processing drop:', err);
      alert('Error al asignar subfase a la mesa');
      this.subfaseAssignedToMesa.delete(subfase.id);
      subfase.assigned = false;
    }
  }

  mostrarItem(item: MesaQueueItem): void {
    const mesaId = this.extractIdFromUrl(item.mesa);

    // Optimistic update
    item.status = 'MOSTRANDO';
    const subfaseId = `${item.modulo}-${item.fase}`;
    const mesa = this.mesas.find(m => m.id === mesaId);
    this.subfaseAssignedToMesa.set(subfaseId, {
      mesaName: mesa?.nombre || `Mesa ${mesaId}`,
      status: 'MOSTRANDO'
    });
    this.cdr.detectChanges();

    this.api.mostrarMesaQueueItem(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          // Reload queue to ensure consistency
          if (mesaId) this.loadMesaQueueItems(mesaId);
        },
        error: (err) => {
          console.error('Error mostrando item', err);
          // Revert optimistically if needed, but for now just log
        }
      });
  }

  marcarHecho(item: MesaQueueItem): void {
    this.pendingActionItem = item;
    this.pendingActionType = 'FINISH';
    this.confirmModalMessage = `¿Finalizar ${item.modulo_nombre} (${item.fase})?`;
    this.showConfirmModal = true;
    this.cdr.detectChanges();
  }

  // Ejecutar acción de marcar hecho (llamado desde confirmarAccion)
  private ejecutarMarcarHecho(item: MesaQueueItem): void {
    const mesaId = this.extractIdFromUrl(item.mesa);
    this.api.marcarMesaQueueItemHecho(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          // Update local tracking - mark as HECHO
          // Track by subfase key
          const subfaseId = `${item.modulo}-${item.fase}`;
          const mesa = this.mesas.find(m => m.id === mesaId);
          this.subfaseAssignedToMesa.set(subfaseId, { mesaName: mesa?.nombre || `Mesa ${mesaId}`, status: 'HECHO' });

          if (mesaId) this.loadMesaQueueItems(mesaId);

          // Reload modules to get updated inferior_hecho/superior_hecho
          if (this.selectedPlanta) {
            this.api.getModulos(this.selectedPlanta.id)
              .pipe(takeUntil(this.destroy$))
              .subscribe({
                next: (modulos) => {
                  console.log('[Dashboard] API returned modules after update');
                  // Force new array reference
                  this.modulos = [...this.sortModulos(modulos)];

                  // Update selectedModulo with fresh data
                  // Update selectedModulo with fresh data
                  if (this.selectedModulo) {
                    const updated = modulos.find(m => m.id === this.selectedModulo!.id);
                    if (updated) {
                      // Check if it just became complete -> Deselect/Collapse
                      if (this.isModuloComplete(updated)) {
                        console.log('[Dashboard] Module completed -> Auto-collapsing:', updated.nombre);
                        this.selectedModulo = null;
                        this.expandedModulo = null;
                      } else {
                        this.selectedModulo = updated;
                      }
                    }
                  }
                  this.cdr.detectChanges();
                }
              });
          }
          this.cdr.detectChanges();
          this.cerrarConfirmModal();
        },
        error: (err) => console.error('Error marcando hecho', err)
      });
  }

  // Show custom confirm modal for delete
  eliminarItem(item: MesaQueueItem): void {
    this.pendingActionItem = item;
    this.pendingActionType = 'DELETE';
    this.confirmModalMessage = `¿Eliminar ${item.modulo_nombre} (${item.fase}) de la cola?`;
    this.showConfirmModal = true;
    this.cdr.detectChanges();
  }

  // Generic Confirm Action
  confirmarAccion(): void {
    if (!this.pendingActionItem || !this.pendingActionType) return;

    if (this.pendingActionType === 'DELETE') {
      this.ejecutarEliminar(this.pendingActionItem);
    } else if (this.pendingActionType === 'FINISH') {
      this.ejecutarMarcarHecho(this.pendingActionItem);
    }
  }

  confirmarEliminar(): void {
    // Deprecated, redirected to generic
    this.confirmarAccion();
  }

  // =========================================================================
  // MESA RENAMING
  // =========================================================================
  editingMesaId: number | null = null;
  // Temporary storage for the name being edited to avoid mutating model before save
  editingMesaName: string = '';

  startEditingMesa(mesa: Mesa): void {
    this.editingMesaId = mesa.id;
    this.editingMesaName = mesa.nombre;
    // Auto-focus logic will be handled in template with autofocus attribute or directive if needed,
    // but standard input usually works fine.
  }

  stopEditingMesa(): void {
    this.editingMesaId = null;
    this.editingMesaName = '';
  }

  updateMesaName(mesa: Mesa): void {
    if (!this.editingMesaId || !this.editingMesaName.trim()) {
      this.stopEditingMesa();
      return;
    }

    const newName = this.editingMesaName.trim();
    if (newName === mesa.nombre) {
      this.stopEditingMesa();
      return;
    }

    // Call API
    this.api.updateMesa(mesa.id, { nombre: newName }).subscribe({
      next: (updatedMesa) => {
        // Update local model
        mesa.nombre = updatedMesa.nombre;
        // Update assignment tracking if any
        // We'd need to update all values in subfaseAssignedToMesa where mesaName matches old name
        // Use a brute-force update for simplicity since maps are small
        for (let [key, val] of this.subfaseAssignedToMesa) {
          if (val.mesaName === mesa.nombre) { // This check might fail if we haven't updated local yet? No, we just updated it above.
            // Wait, we updated mesa.nombre locally just now.
            val.mesaName = updatedMesa.nombre;
          }
        }
        this.stopEditingMesa();
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error updating mesa name', err);
        alert('Error al renombrar la mesa');
        this.stopEditingMesa();
      }
    });
  }

  private ejecutarEliminar(item: MesaQueueItem): void {
    const mesaId = this.extractIdFromUrl(item.mesa);

    this.api.deleteMesaQueueItem(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          // Remove from assignment tracking
          const subfaseId = `${item.modulo}-${item.fase}`;
          this.subfaseAssignedToMesa.delete(subfaseId);

          // Reload only the affected mesa's queue
          if (mesaId) this.loadMesaQueueItems(mesaId);
          this.cerrarConfirmModal();
        },
        error: (err) => {
          console.error('Error eliminando item', err);
          this.cerrarConfirmModal();
        }
      });
  }

  // =========================================================================
  // QUEUE REORDERING
  // =========================================================================
  onMesaQueueDrop(event: CdkDragDrop<MesaQueueItem[]>, mesaId: number): void {
    if (event.previousContainer === event.container) {
      // 1. Check if first item is locked (MOSTRANDO)
      // Since we force sort MOSTRANDO to top, we just check if index 0 is MOSTRANDO
      const currentItems = event.container.data;
      const hasMostrando = currentItems.some(i => i.status === 'MOSTRANDO');

      if (hasMostrando) {
        // If there is ANY 'MOSTRANDO' item, it is guaranteed to be at index 0 due to our sort logic.
        // Effectively, index 0 is immutable for Drag-Drop of OTHER items.
        // If user tries to drop ANY item at index 0, reject it (push to 1).
        if (event.currentIndex === 0) {
          event.currentIndex = 1;
        }
      }

      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
      // Update the Map locally so UI reflects change immediately
      this.mesaQueueItems.set(mesaId, event.container.data);

      // Prepare payload for backend
      const payload = event.container.data.map((item, index) => ({
        id: item.id,
        position: index
      }));

      // Call API (silent update)
      this.api.reorderMesaQueue(payload).subscribe({
        next: () => console.log('Reorder saved'),
        error: (err) => console.error('Reorder failed', err)
      });
    } else {
      // Cross-mesa transfer
      const item = event.previousContainer.data[event.previousIndex];
      const sourceMesaId = this.extractIdFromUrl(item.mesa);

      // Don't transfer MOSTRANDO items
      if (item.status === 'MOSTRANDO') return;

      // Prevent dropping at index 0 if target has a MOSTRANDO item
      const targetItems = event.container.data;
      const targetHasMostrando = targetItems.some((i: MesaQueueItem) => i.status === 'MOSTRANDO');
      if (targetHasMostrando && event.currentIndex === 0) {
        event.currentIndex = 1;
      }

      // Move locally for instant UI feedback
      transferArrayItem(
        event.previousContainer.data,
        event.container.data,
        event.previousIndex,
        event.currentIndex
      );

      // Update local maps
      if (sourceMesaId) this.mesaQueueItems.set(sourceMesaId, event.previousContainer.data);
      this.mesaQueueItems.set(mesaId, event.container.data);
      this.cdr.detectChanges();

      // Backend: delete from old mesa, create in new mesa
      this.api.deleteMesaQueueItem(item.id).subscribe({
        next: () => {
          this.api.createMesaQueueItem(mesaId, item.modulo, item.fase, null, event.currentIndex).subscribe({
            next: () => {
              if (sourceMesaId) this.loadMesaQueueItems(sourceMesaId);
              this.loadMesaQueueItems(mesaId);
            },
            error: (err: any) => {
              console.error('Transfer create failed', err);
              this.mesas.forEach(m => this.loadMesaQueueItems(m.id));
            }
          });
        },
        error: (err: any) => {
          console.error('Transfer delete failed', err);
          this.mesas.forEach(m => this.loadMesaQueueItems(m.id));
        }
      });
    }
  }

  // =========================================================================
  // NAVIGATION (Context Switch)
  // =========================================================================
  navigateToModule(item: MesaQueueItem): void {
    if (!item.modulo_proyecto_id || !item.modulo_planta_id) {
      console.warn('Navigation IDs missing', item);
      return;
    }

    // Helper to finish selection once Modulos are loaded
    const finishSelection = () => {
      const targetModuloId = item.modulo; // Now typed as number
      const mod = this.modulos.find(m => m.id === targetModuloId);
      if (mod) {
        if (this.selectedModulo?.id !== mod.id) {
          this.toggleModulo(mod);
        } else if (!this.expandedModulo) {
          this.toggleModulo(mod);
        }
      } else {
        console.warn('Module not found in list', targetModuloId);
      }
    };

    // Helper to chain Planta selection
    const selectPlantaStep = () => {
      if (this.selectedPlanta?.id !== item.modulo_planta_id) {
        const planta = this.plantas.find(p => p.id === item.modulo_planta_id);
        if (planta) {
          this.selectedPlanta = planta;
          this.selectedModulo = null;
          this.navLevel = 'modules';

          this.loadingModulos = true;
          this.api.getModulos(planta.id).subscribe({
            next: (modulos) => {
              this.modulos = this.sortModulos(modulos);
              this.loadingModulos = false;
              this.cdr.detectChanges();
              finishSelection();
            },
            error: (err) => {
              this.loadingModulos = false;
              console.error(err);
            }
          });
        }
      } else {
        if (this.modulos.length === 0) {
          this.api.getModulos(item.modulo_planta_id!).subscribe(modulos => {
            this.modulos = this.sortModulos(modulos);
            finishSelection();
          });
        } else {
          finishSelection();
        }
      }
    };

    // 1. Check Project
    if (this.selectedProyecto?.id !== item.modulo_proyecto_id) {
      const proj = this.proyectos.find(p => p.id === item.modulo_proyecto_id);
      if (proj) {
        this.selectedProyecto = proj;
        this.selectedPlanta = null;
        this.selectedModulo = null;
        this.navLevel = 'plants';

        this.loadingPlantas = true;
        this.api.getPlantas(proj.id).subscribe({
          next: (plantas) => {
            this.plantas = plantas;
            this.loadingPlantas = false;
            this.cdr.detectChanges();
            selectPlantaStep();
          },
          error: (err) => {
            this.loadingPlantas = false;
            console.error(err);
          }
        });
      }
    } else {
      selectPlantaStep();
    }
  }

  // Cancel and close modal
  cerrarConfirmModal(): void {
    this.showConfirmModal = false;
    this.pendingActionItem = null;
    this.pendingActionType = null;
    this.confirmModalMessage = '';
    this.cdr.detectChanges();
  }

  // Helper to extract ID from DRF URL or handle numeric ID
  extractIdFromUrl(val: string | number): number | null {
    if (typeof val === 'number') return val;
    if (!val) return null;
    const parts = val.toString().split('/').filter(p => p);
    const idStr = parts.pop();
    const id = parseInt(idStr || '0');
    return isNaN(id) ? null : id;
  }

  // =========================================================================
  // HELPERS
  // =========================================================================
  getModuloEstadoClass(modulo: Modulo): string {
    return `estado-${modulo.estado.toLowerCase()}`;
  }

  getMesaQueueItems(mesaId: number): MesaQueueItem[] {
    return this.mesaQueueItems.get(mesaId) || [];
  }

  // Returns formatted status label for a subfase
  getSubfaseAssignmentLabel(subfase: Subfase): string {
    const assignment = this.subfaseAssignedToMesa.get(subfase.id);
    if (!assignment) return '';

    switch (assignment.status) {
      case 'EN_COLA':
        return `En cola: ${assignment.mesaName}`;
      case 'MOSTRANDO':
        return `Mostrando: ${assignment.mesaName}`;
      case 'HECHO':
        return `Realizado: ${assignment.mesaName}`;
      default:
        return assignment.mesaName;
    }
  }

  // Check if both phases of a module are complete
  isModuloComplete(modulo: Modulo): boolean {
    return modulo.inferior_hecho && modulo.superior_hecho;
  }

  isPhaseAssigned(modulo: Modulo, fase: string): boolean {
    const key = `${modulo.id}-${fase}`;
    return this.subfaseAssignedToMesa.has(key);
  }

  getSubfaseStatusText(subfase: Subfase): string {
    const assignment = this.subfaseAssignedToMesa.get(subfase.id);
    if (assignment) {
      if (assignment.status === 'HECHO') return `Realizado en ${assignment.mesaName}`;
      if (assignment.status === 'MOSTRANDO') return `Proyectando en ${assignment.mesaName}`;
      return `Asignada en ${assignment.mesaName}`;
    }
    return '';
  }

  updateActivePhases(): void {
    this.activePhases.clear();
    this.mesaQueueItems.forEach((items) => {
      items.forEach(item => {
        if (item.status !== 'HECHO') {
          this.activePhases.add(`${item.modulo}-${item.fase}`);
        }
      });
    });
  }

  getItemStatusClass(status: string): string {
    return `status-${status.toLowerCase().replace('_', '-')}`;
  }

  trackByProyecto(index: number, proyecto: Proyecto): number {
    return proyecto.id;
  }

  trackByModulo(index: number, modulo: Modulo): number {
    return modulo.id;
  }

  trackByMesa(index: number, mesa: Mesa): number {
    return mesa.id;
  }

  trackByItem(index: number, item: MesaQueueItem): number {
    return item.id;
  }

  // Sort helper: Incomplete first, Complete last, then by Name
  sortModulos(data: Modulo[]): Modulo[] {
    return data.sort((a, b) => {
      const aComplete = this.isModuloComplete(a);
      const bComplete = this.isModuloComplete(b);
      if (aComplete === bComplete) {
        return a.nombre.localeCompare(b.nombre);
      }
      return aComplete ? 1 : -1;
    });
  }

  // =========================================================================
  // PROJECT REORDERING (CDK Drag Drop)
  // =========================================================================
  onProjectDrop(event: CdkDragDrop<Proyecto[]>): void {
    console.log('[Dashboard] Project drop:', event.previousIndex, '->', event.currentIndex);
    moveItemInArray(this.proyectos, event.previousIndex, event.currentIndex);
    this.cdr.detectChanges();
    // TODO: Optionally persist the new order to backend
  }



  // =========================================================================
  // PROJECTION VIEW
  // =========================================================================
  openProjectionView(mesa: any): void {
    console.log('[Dashboard] Opening projection for:', mesa.nombre, 'Linked:', mesa.is_linked, 'Mesa Object:', mesa);
    if (!mesa.is_linked) {
      alert('Mesa no vinculada. Póngase en contacto con administración.');
      return;
    }
    // Open visor in new tab for this mesa
    window.open(`/visor/${mesa.id}`, '_blank');
  }

}
