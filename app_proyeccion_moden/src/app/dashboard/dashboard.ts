import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import {
  ApiService,
  Proyecto, Modulo, Mesa, ModuloQueueItem, MesaQueueItem, Imagen
} from '../services/api.service';
import { Subject, takeUntil } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, DragDropModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard implements OnInit, OnDestroy {
  // Data
  proyectos: Proyecto[] = [];
  modulos: Modulo[] = [];
  mesas: Mesa[] = [];
  queueItems: ModuloQueueItem[] = [];
  mesaQueueItems: Map<number, MesaQueueItem[]> = new Map();
  moduloImagenes: Map<number, Imagen[]> = new Map();

  // Selection state
  selectedProyecto: Proyecto | null = null;
  selectedModulo: Modulo | null = null;
  expandedModulo: number | null = null;

  // Loading states
  loadingProyectos = true;
  loadingModulos = false;
  loadingMesas = true;
  loadingImagenes = false;

  // Drag state
  draggedImagen: Imagen | null = null;
  draggedModulo: Modulo | null = null;
  dragOverMesa: number | null = null;

  private destroy$ = new Subject<void>();

  constructor(private api: ApiService, private cdr: ChangeDetectorRef) { }

  ngOnInit(): void {
    this.loadProyectos();
    this.loadMesas();
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
          this.mesaQueueItems.set(mesaId, items);
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
    this.selectedModulo = null;
    this.expandedModulo = null;
    this.moduloImagenes.clear();
    this.loadModulosForProyecto(proyecto.id);
  }

  loadModulosForProyecto(proyectoId: number): void {
    this.loadingModulos = true;
    this.api.getModulos(proyectoId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.modulos = data;
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
    if (this.expandedModulo === modulo.id) {
      this.expandedModulo = null;
    } else {
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

    // Get current queue length for position
    const currentItems = this.mesaQueueItems.get(mesa.id) || [];
    const newPosition = currentItems.length + 1;

    // Create the queue item
    this.api.createMesaQueueItem(mesa.id, modulo.id, imagen.fase, imagen.id, newPosition)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (item) => {
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
    this.api.mostrarMesaQueueItem(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => this.loadMesas(),
        error: (err) => console.error('Error mostrando item', err)
      });
  }

  marcarHecho(item: MesaQueueItem): void {
    this.api.marcarMesaQueueItemHecho(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.loadMesas();
          if (this.selectedProyecto) {
            this.loadModulosForProyecto(this.selectedProyecto.id);
          }
        },
        error: (err) => console.error('Error marcando hecho', err)
      });
  }

  eliminarItem(item: MesaQueueItem): void {
    if (!confirm(`¿Eliminar ${item.modulo_nombre} (${item.fase}) de la cola?`)) return;

    this.api.deleteMesaQueueItem(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => this.loadMesas(),
        error: (err) => console.error('Error eliminando item', err)
      });
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

  // =========================================================================
  // PROJECT REORDERING (CDK Drag Drop)
  // =========================================================================
  onProjectDrop(event: CdkDragDrop<Proyecto[]>): void {
    console.log('[Dashboard] Project drop:', event.previousIndex, '->', event.currentIndex);
    moveItemInArray(this.proyectos, event.previousIndex, event.currentIndex);
    this.cdr.detectChanges();
    // TODO: Optionally persist the new order to backend
  }
}
