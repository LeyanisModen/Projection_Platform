import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';

import {
  ApiService,
  Proyecto, Planta, Modulo, Mesa, ModuloQueueItem, MesaQueueItem, Imagen
} from '../services/api.service';
import { Subject, takeUntil } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  imports: [CommonModule, DragDropModule]
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

  // Data Loading States
  loadingProyectos = false;
  loadingPlantas = false;
  loadingModulos = false;
  loadingImagenes = false; // Loading images for expanded module
  loadingMesas = false;

  // Selection State
  // Selection State
  selectedProyecto: Proyecto | null = null;
  selectedPlanta: Planta | null = null;
  selectedModulo: Modulo | null = null;

  // UI State
  expandedModulo: number | null = null; // ID of expanded module
  droppedImage: Imagen | null = null; // Temp holder for drop logic
  dragOverMesa: number | null = null; // ID of mesa being dragged over

  // Drag State
  draggedImagen: Imagen | null = null;
  draggedModulo: Modulo | null = null;

  // Confirm Modal State
  showConfirmModal = false;
  confirmModalMessage = '';
  pendingActionItem: MesaQueueItem | null = null;
  pendingActionType: 'DELETE' | 'FINISH' | null = null;

  // Maps for tracking
  moduloImagenes = new Map<number, Imagen[]>(); // moduloId -> images
  // imagenId -> { mesaName, status: 'EN_COLA' | 'MOSTRANDO' | 'HECHO' }
  imagenAssignedToMesa = new Map<number, { mesaName: string, status: string }>();
  activePhases = new Set<string>(); // "moduloId-FASE" (e.g. "101-INFERIOR")

  // Pairing Modal State
  showPairingModal = false;
  pairingMesa: Mesa | null = null;
  pairingCode = '';
  pairingError = '';
  pairingLoading = false;
  pairingSuccess = false;

  // Unbind Modal State
  showUnbindModal = false;
  unbindMesa: Mesa | null = null;
  unbindLoading = false;

  private destroy$ = new Subject<void>();

  constructor(private api: ApiService, private cdr: ChangeDetectorRef) { }

  ngOnInit(): void {
    this.loadProyectos();
    this.loadMesas();
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
    this.imagenAssignedToMesa.clear();
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
          // First, remove old assignments for this mesa from tracking
          const oldItems = this.mesaQueueItems.get(mesaId) || [];
          oldItems.forEach(oldItem => {
            const oldImagenId = this.extractIdFromUrl(oldItem.imagen);
            if (oldImagenId) this.imagenAssignedToMesa.delete(oldImagenId);
          });

          // Update the map with new items (Filter out HECHO for display)
          const activeItems = items.filter(i => i.status !== 'HECHO');
          this.mesaQueueItems.set(mesaId, activeItems);

          // Track assigned images for this mesa (including HECHO to prevent re-assignment)
          const mesa = this.mesas.find(m => m.id === mesaId);
          items.forEach(item => {
            const imagenId = this.extractIdFromUrl(item.imagen);
            if (imagenId) {
              this.imagenAssignedToMesa.set(imagenId, {
                mesaName: mesa?.nombre || `Mesa ${mesaId}`,
                status: item.status
              });
            }
          });
          this.updateActivePhases();
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

  // =========================================================================
  // MODULE EXPANSION (to show images)
  // =========================================================================
  toggleModulo(modulo: Modulo): void {
    // Toggle logic: If already selected, deselect (collapse)
    if (this.selectedModulo?.id === modulo.id) {
      this.selectedModulo = null;
      this.expandedModulo = null;
    } else {
      // Select logic
      this.selectedModulo = modulo;
      this.expandedModulo = modulo.id;
      this.loadImagenesForModulo(modulo.id);
    }
    this.cdr.detectChanges();
  }

  loadImagenesForModulo(moduloId: number): void {
    if (this.moduloImagenes.has(moduloId)) return;

    this.loadingImagenes = true;
    this.api.getModuloImagenes(moduloId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (imagenes) => {
          this.moduloImagenes.set(moduloId, imagenes);
          this.loadingImagenes = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading imagenes', err);
          this.loadingImagenes = false;
        }
      });
  }

  getModuloImagenes(moduloId: number): Imagen[] {
    return this.moduloImagenes.get(moduloId) || [];
  }

  // =========================================================================
  // IMAGE DRAG AND DROP
  // =========================================================================
  onImageDragStart(event: DragEvent, imagen: Imagen, modulo: Modulo): void {
    console.log('[Dashboard] Drag Start:', imagen.nombre, modulo.nombre);
    this.draggedImagen = imagen;
    this.draggedModulo = modulo;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', JSON.stringify({
        imagenId: imagen.id,
        moduloId: modulo.id,
        fase: imagen.fase
      }));
    }
  }

  onDragEnd(event: DragEvent): void {
    console.log('[Dashboard] Drag End');
    this.draggedImagen = null;
    this.draggedModulo = null;
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

  onImageDrop(event: DragEvent, mesa: Mesa): void {
    event.preventDefault();
    event.stopPropagation();
    console.log('[Dashboard] Drop on Mesa:', mesa.nombre, 'Imagen:', this.draggedImagen?.nombre);
    this.dragOverMesa = null;

    if (!this.draggedImagen || !this.draggedModulo) {
      console.warn('[Dashboard] Drop failed: No dragged imagen/modulo');
      return;
    }

    const imagen = this.draggedImagen;
    const modulo = this.draggedModulo;

    this.draggedImagen = null;
    this.draggedModulo = null;

    // Check if image is already assigned
    const assignment = this.imagenAssignedToMesa.get(imagen.id);
    if (assignment) {
      alert(`⚠️ Esta imagen (${imagen.nombre}) ya está asignada a ${assignment.mesaName}`);
      this.cdr.detectChanges();
      return;
    }

    // Get current queue length for position
    const currentItems = this.mesaQueueItems.get(mesa.id) || [];
    const newPosition = currentItems.length + 1;

    // Create the queue item
    this.api.createMesaQueueItem(mesa.id, modulo.id, imagen.fase, imagen.id, newPosition)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (item) => {
          // Track the new assignment
          this.imagenAssignedToMesa.set(imagen.id, { mesaName: mesa.nombre, status: 'EN_COLA' });
          this.loadMesaQueueItems(mesa.id);
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error creating mesa queue item', err);
          alert('Error al asignar trabajo a la mesa');
        }
      });
  }

  // =========================================================================
  // MESA QUEUE ACTIONS
  // =========================================================================
  mostrarItem(item: MesaQueueItem): void {
    const mesaId = this.extractIdFromUrl(item.mesa);
    this.api.mostrarMesaQueueItem(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          if (mesaId) this.loadMesaQueueItems(mesaId);
          this.cdr.detectChanges();
        },
        error: (err) => console.error('Error mostrando item', err)
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
          const imagenId = this.extractIdFromUrl(item.imagen);
          if (imagenId) {
            const mesa = this.mesas.find(m => m.id === mesaId);
            this.imagenAssignedToMesa.set(imagenId, { mesaName: mesa?.nombre || `Mesa ${mesaId}`, status: 'HECHO' });
          }
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

  private ejecutarEliminar(item: MesaQueueItem): void {
    const mesaId = this.extractIdFromUrl(item.mesa);
    const imagenId = this.extractIdFromUrl(item.imagen);

    this.api.deleteMesaQueueItem(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          // Remove from assignment tracking
          if (imagenId) this.imagenAssignedToMesa.delete(imagenId);
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

  // Returns formatted status label for an image (e.g., "En cola en Mesa-01...")
  getImageAssignmentLabel(imagenId: number): string {
    const assignment = this.imagenAssignedToMesa.get(imagenId);
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

  isPhaseInProgress(modulo: Modulo, fase: string): boolean {
    const key = `${modulo.id}-${fase}`;
    return this.activePhases.has(key);
  }

  getAssignmentText(imagen: Imagen): string {
    if (this.imagenAssignedToMesa.has(imagen.id)) {
      const info = this.imagenAssignedToMesa.get(imagen.id);
      if (info && info.status === 'HECHO') {
        return `Realizado en ${info.mesaName}`;
      } else if (info && info.status === 'MOSTRANDO') {
        return `Proyectando en ${info.mesaName}`;
      } else if (info) {
        return `Asignada en ${info.mesaName}`;
      }
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
  // DEVICE PAIRING MODAL
  // =========================================================================
  openPairingModal(mesa: Mesa): void {
    this.pairingMesa = mesa;
    this.pairingCode = '';
    this.pairingError = '';
    this.pairingLoading = false;
    this.pairingSuccess = false;
    this.showPairingModal = true;
  }

  closePairingModal(): void {
    this.showPairingModal = false;
    this.pairingMesa = null;
    this.pairingCode = '';
    this.pairingError = '';
    this.pairingLoading = false;
    this.pairingSuccess = false;
  }

  submitPairing(): void {
    if (!this.pairingMesa || !this.pairingCode.trim()) {
      this.pairingError = 'Introduce un código válido';
      return;
    }

    this.pairingLoading = true;
    this.pairingError = '';

    this.api.pairDevice(this.pairingMesa.id, this.pairingCode.trim().toUpperCase())
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.pairingLoading = false;
          if (res.status === 'ok') {
            this.pairingSuccess = true;
            // Reload mesas to update is_linked status
            this.loadMesas();
          } else {
            this.pairingError = 'Error desconocido';
          }
        },
        error: (err) => {
          this.pairingLoading = false;
          this.pairingError = err.error?.detail || 'Error al vincular dispositivo';
        }
      });
  }

  onPairingCodeInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.pairingCode = input.value.toUpperCase();
  }

  // Unbind Modal Methods
  openUnbindModal(mesa: Mesa): void {
    this.unbindMesa = mesa;
    this.unbindLoading = false;
    this.showUnbindModal = true;
  }

  closeUnbindModal(): void {
    this.showUnbindModal = false;
    this.unbindMesa = null;
    this.unbindLoading = false;
  }

  confirmUnbind(): void {
    if (!this.unbindMesa) return;

    this.unbindLoading = true;
    this.api.unbindDevice(this.unbindMesa.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.loadMesas();
          this.closeUnbindModal();
        },
        error: () => {
          this.unbindLoading = false;
        }
      });
  }

  // =========================================================================
  // PROJECTION VIEW
  // =========================================================================
  openProjectionView(mesa: any): void {
    // Open visor in new tab for this mesa
    window.open(`/visor/${mesa.id}`, '_blank');
  }
}
