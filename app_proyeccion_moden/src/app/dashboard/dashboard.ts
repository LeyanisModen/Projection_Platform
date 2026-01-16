import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ApiService,
  Proyecto, Modulo, Mesa, ModuloQueueItem, MesaQueueItem
} from '../services/api.service';
import { Subject, takeUntil, forkJoin } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
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

  // Selection state
  selectedProyecto: Proyecto | null = null;
  selectedModulo: Modulo | null = null;

  // Loading states
  loadingProyectos = true;
  loadingModulos = false;
  loadingMesas = true;

  // Drag state
  draggedModulo: Modulo | null = null;

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
    console.log('[Dashboard] loadProyectos() called');
    this.loadingProyectos = true;
    this.api.getProyectos()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          console.log('[Dashboard] Proyectos received:', data);
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
          // Load queue items for each mesa
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
  // DRAG AND DROP
  // =========================================================================
  onDragStart(event: DragEvent, modulo: Modulo): void {
    this.draggedModulo = modulo;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', JSON.stringify({
        moduloId: modulo.id,
        moduloNombre: modulo.nombre
      }));
    }
  }

  onDragEnd(event: DragEvent): void {
    this.draggedModulo = null;
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onDrop(event: DragEvent, mesa: Mesa, fase: 'INFERIOR' | 'SUPERIOR'): void {
    event.preventDefault();
    if (!this.draggedModulo) return;

    const modulo = this.draggedModulo;
    this.draggedModulo = null;

    // First get the images for this module to find the correct one for the fase
    this.api.getModuloImagenes(modulo.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (imagenes) => {
          const imagen = imagenes.find(img => img.fase === fase);
          if (!imagen) {
            alert(`El módulo ${modulo.nombre} no tiene imagen ${fase}`);
            return;
          }

          // Get current queue length for position
          const currentItems = this.mesaQueueItems.get(mesa.id) || [];
          const newPosition = currentItems.length + 1;

          // Create the queue item
          this.api.createMesaQueueItem(mesa.id, modulo.id, fase, imagen.id, newPosition)
            .pipe(takeUntil(this.destroy$))
            .subscribe({
              next: (item) => {
                // Refresh mesa queue
                this.loadMesaQueueItems(mesa.id);
              },
              error: (err) => {
                console.error('Error creating mesa queue item', err);
                alert('Error al asignar trabajo a la mesa');
              }
            });
        },
        error: (err) => {
          console.error('Error loading imagenes', err);
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
        next: () => {
          // Extract mesa ID from URL or reload all
          this.loadMesas();
        },
        error: (err) => console.error('Error mostrando item', err)
      });
  }

  marcarHecho(item: MesaQueueItem): void {
    this.api.marcarMesaQueueItemHecho(item.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.loadMesas();
          // Reload modulos to see updated state
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
}
