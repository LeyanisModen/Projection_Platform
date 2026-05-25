import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';

import {
  ApiService,
  Proyecto, Planta, Modulo, Mesa, ModuloQueueItem, MesaQueueItem, Imagen,
  GrupoMesas, GrupoMesasProyectoEntry, ProductionStatsResponse
} from '../services/api.service';
import {
  ListaMaterialesService,
  ListaMaterialesProyecto,
  ListaMaterialesGeneral,
  RenglonLista,
  RenglonGeneralAgrupado,
  BloqueGeneralPorProyecto,
  GrupoMaterial,
} from '../services/lista-materiales.service';
import { Subject, takeUntil, forkJoin, interval } from 'rxjs';
import { environment } from '../../environments/environment';

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
  gruposMesas: GrupoMesas[] = [];
  selectedProyectoPorGrupo: Record<number, number | null> = {};

  // Subfases for the selected module
  activeSubfases: Subfase[] = [];

  // Data Loading States
  loadingProyectos = false;
  loadingPlantas = false;
  loadingModulos = false;
  loadingImagenes = false; // Loading images for expanded module
  loadingMesas = false;
  loadingGruposMesas = false;

  // Selection State
  selectedProyecto: Proyecto | null = null;
  selectedPlanta: Planta | null = null;
  selectedModulo: Modulo | null = null;

  // Stats State
  statsData: ProductionStatsResponse | null = null;
  loadingStats = false;
  statsPreset: 'day' | 'week' | 'month' | 'custom' = 'day';
  statsFrom: string = '';
  statsTo: string = '';

  // UI State
  expandedModulo: number | null = null; // ID of expanded module
  dragOverMesa: number | null = null; // ID of mesa being dragged over

  // Drag State
  draggedSubfase: Subfase | null = null;
  transferInProgress = false;
  planningGroupId: number | null = null;

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
  private queueErrorLogByMesa = new Map<number, number>();
  private readonly queueErrorLogCooldownMs = 30000;

  // Pairing Modal State

  // Blueprint Modal State
  showBlueprintModal = false;
  blueprintUrl: string | null = null;

  // Project-plan Modal State
  showPlanModal = false;
  planModalProyecto: Proyecto | null = null;
  planModalModulos: Modulo[] = [];
  private planModalPlantas = new Map<number, string>();
  loadingPlanModal = false;

  // Materiales-list Modal State (per-project)
  showMaterialesModal = false;
  materialesModalProyecto: Proyecto | null = null;
  materialesModalData: ListaMaterialesProyecto | null = null;
  loadingMaterialesModal = false;
  private materialesPendingByClave = new Set<string>();

  // Materiales-list Modal State (general)
  showMaterialesGeneralModal = false;
  materialesGeneralData: ListaMaterialesGeneral | null = null;
  loadingMaterialesGeneralModal = false;
  private materialesGeneralPendingByClave = new Set<string>();
  private materialesGeneralPendingProyectoClave = new Set<string>();

  // Gestionar Mesa Modal State (rename grupo + mesas, manage project queue)
  showGestionarModal = false;
  gestionandoGrupo: GrupoMesas | null = null;
  gestionarGrupoNombre: string = '';
  // Estado pendiente por mesa dentro del modal (no aplicado hasta cerrar
  // y confirmar). Tres valores posibles: 'INFERIOR', 'SUPERIOR',
  // 'INACTIVA' -- la mesa solo es una cosa a la vez.
  gestionarMesasEstados: Record<number, 'INFERIOR' | 'SUPERIOR' | 'INACTIVA'> = {};
  gestionarAplicandoCambios = false;
  gestionarAddProyectoId: number | null = null;
  gestionarBusy = false;

  verPlano(planta: Planta): void {
    if (planta.plano_imagen) {
      this.blueprintUrl = this.resolveUrl(planta.plano_imagen);
      this.showBlueprintModal = true;
      this.cdr.detectChanges();
    }
  }

  private resolveUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http')) return url;

    // Strip '/api' from base URL to get root domain
    let base = environment.apiUrl;
    if (base.endsWith('/')) base = base.slice(0, -1);
    if (base.endsWith('/api')) base = base.substring(0, base.length - 4);

    // Ensure path starts with /
    const path = url.startsWith('/') ? url : `/${url}`;
    return `${base}${path}`;
  }

  cerrarBlueprintModal(): void {
    this.showBlueprintModal = false;
    this.blueprintUrl = null;
    this.cdr.detectChanges();
  }

  openPlanModal(proyecto: Proyecto, event?: Event): void {
    event?.stopPropagation();
    this.showPlanModal = true;
    this.planModalProyecto = proyecto;
    this.planModalModulos = [];
    this.planModalPlantas.clear();
    this.loadingPlanModal = true;
    this.cdr.detectChanges();

    forkJoin({
      modulos: this.api.getProyectoModulos(proyecto.id),
      plantas: this.api.getPlantas(proyecto.id)
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: ({ modulos, plantas }) => {
        this.planModalModulos = modulos;
        this.planModalPlantas = new Map(plantas.map(p => [p.id, p.nombre]));
        this.loadingPlanModal = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.loadingPlanModal = false;
        this.cdr.detectChanges();
      }
    });
  }

  closePlanModal(): void {
    this.showPlanModal = false;
    this.planModalProyecto = null;
    this.planModalModulos = [];
    this.planModalPlantas.clear();
    this.cdr.detectChanges();
  }

  // --- Lista de materiales: por proyecto ---

  openMaterialesModal(proyecto: Proyecto, event?: Event): void {
    event?.stopPropagation();
    this.showMaterialesModal = true;
    this.materialesModalProyecto = proyecto;
    this.materialesModalData = null;
    this.materialesPendingByClave.clear();
    this.loadingMaterialesModal = true;
    this.cdr.detectChanges();

    this.listaMateriales.getListaProyecto(proyecto.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.materialesModalData = data;
          this.loadingMaterialesModal = false;
          this.cdr.detectChanges();
        },
        error: () => {
          this.loadingMaterialesModal = false;
          this.cdr.detectChanges();
        },
      });
  }

  closeMaterialesModal(): void {
    this.showMaterialesModal = false;
    this.materialesModalProyecto = null;
    this.materialesModalData = null;
    this.materialesPendingByClave.clear();
    this.cdr.detectChanges();
  }

  toggleMaterialesProyecto(renglon: RenglonLista): void {
    if (!this.materialesModalProyecto || !this.materialesModalData) return;
    if (this.materialesPendingByClave.has(renglon.clave)) return;
    if (this.isMaterialesRowConsumed(renglon)) return;

    const proyectoId = this.materialesModalProyecto.id;
    const nuevo = !renglon.informado;
    this.materialesPendingByClave.add(renglon.clave);
    this.cdr.detectChanges();

    this.listaMateriales.setInformadoProyecto(proyectoId, renglon.clave, nuevo)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (updated) => {
          if (this.materialesModalData && updated) {
            this.materialesModalData = {
              ...this.materialesModalData,
              renglones: this.materialesModalData.renglones.map((r) =>
                r.clave === updated.clave ? updated : r,
              ),
            };
          }
          this.materialesPendingByClave.delete(renglon.clave);
          this.cdr.detectChanges();
        },
        error: () => {
          this.materialesPendingByClave.delete(renglon.clave);
          this.cdr.detectChanges();
        },
      });
  }

  isMaterialesRowPending(clave: string): boolean {
    return this.materialesPendingByClave.has(clave);
  }

  isMaterialesRowConsumed(renglon: RenglonLista): boolean {
    return renglon.pendiente <= 0;
  }

  materialesRowProgressPct(renglon: RenglonLista): number {
    if (renglon.total <= 0) return 0;
    const consumido = renglon.total - renglon.pendiente;
    return Math.max(0, Math.min(100, (consumido / renglon.total) * 100));
  }

  // --- Lista de materiales: general ---

  openMaterialesGeneralModal(): void {
    this.showMaterialesGeneralModal = true;
    this.materialesGeneralData = null;
    this.materialesGeneralPendingByClave.clear();
    this.materialesGeneralPendingProyectoClave.clear();
    this.loadingMaterialesGeneralModal = true;
    this.cdr.detectChanges();

    this.listaMateriales.getListaGeneral()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.materialesGeneralData = data;
          this.loadingMaterialesGeneralModal = false;
          this.cdr.detectChanges();
        },
        error: () => {
          this.loadingMaterialesGeneralModal = false;
          this.cdr.detectChanges();
        },
      });
  }

  closeMaterialesGeneralModal(): void {
    this.showMaterialesGeneralModal = false;
    this.materialesGeneralData = null;
    this.materialesGeneralPendingByClave.clear();
    this.materialesGeneralPendingProyectoClave.clear();
    this.cdr.detectChanges();
  }

  toggleMaterialesGeneral(agrupado: RenglonGeneralAgrupado): void {
    if (this.materialesGeneralPendingByClave.has(agrupado.clave)) return;
    if (this.isAgrupadoConsumed(agrupado)) return;

    const nuevo = !agrupado.todos_marcados;
    this.materialesGeneralPendingByClave.add(agrupado.clave);
    this.cdr.detectChanges();

    this.listaMateriales.setInformadoGeneral(agrupado.clave, nuevo)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.materialesGeneralData = data;
          this.materialesGeneralPendingByClave.delete(agrupado.clave);
          this.cdr.detectChanges();
        },
        error: () => {
          this.materialesGeneralPendingByClave.delete(agrupado.clave);
          this.cdr.detectChanges();
        },
      });
  }

  toggleMaterialesGeneralEspecifico(proyectoId: number, renglon: RenglonLista): void {
    const key = `${proyectoId}::${renglon.clave}`;
    if (this.materialesGeneralPendingProyectoClave.has(key)) return;
    if (this.isMaterialesRowConsumed(renglon)) return;

    const nuevo = !renglon.informado;
    this.materialesGeneralPendingProyectoClave.add(key);
    this.cdr.detectChanges();

    this.listaMateriales.setInformadoProyecto(proyectoId, renglon.clave, nuevo)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (updated) => {
          if (this.materialesGeneralData && updated) {
            this.materialesGeneralData = {
              ...this.materialesGeneralData,
              por_proyecto: this.materialesGeneralData.por_proyecto.map((bloque) =>
                bloque.proyecto_id !== proyectoId
                  ? bloque
                  : {
                      ...bloque,
                      renglones: bloque.renglones.map((r) =>
                        r.clave === updated.clave ? updated : r,
                      ),
                    },
              ),
            };
          }
          this.materialesGeneralPendingProyectoClave.delete(key);
          this.cdr.detectChanges();
        },
        error: () => {
          this.materialesGeneralPendingProyectoClave.delete(key);
          this.cdr.detectChanges();
        },
      });
  }

  isAgrupadoPending(clave: string): boolean {
    return this.materialesGeneralPendingByClave.has(clave);
  }

  isAgrupadoConsumed(agrupado: RenglonGeneralAgrupado): boolean {
    return agrupado.pendiente <= 0;
  }

  isEspecificoPending(proyectoId: number, clave: string): boolean {
    return this.materialesGeneralPendingProyectoClave.has(`${proyectoId}::${clave}`);
  }

  agrupadoProgressPct(agrupado: RenglonGeneralAgrupado): number {
    if (agrupado.total <= 0) return 0;
    const consumido = agrupado.total - agrupado.pendiente;
    return Math.max(0, Math.min(100, (consumido / agrupado.total) * 100));
  }

  agrupadoInformadoPct(agrupado: RenglonGeneralAgrupado): number {
    if (agrupado.pendiente <= 0) return 100;
    const denominador = agrupado.total;
    if (denominador <= 0) return 0;
    return Math.max(0, Math.min(100, (agrupado.informado_total / denominador) * 100));
  }

  /** Group rows in a stable display order (consumibles → barras → elementos). */
  groupRowsByGrupo<T extends { grupo: GrupoMaterial }>(rows: T[]): Array<{ grupo: GrupoMaterial; label: string; rows: T[] }> {
    const order: Array<{ grupo: GrupoMaterial; label: string }> = [
      { grupo: 'consumibles', label: 'Consumibles' },
      { grupo: 'barras', label: 'Barras' },
      { grupo: 'elementos', label: 'Elementos' },
    ];
    return order
      .map((g) => ({ ...g, rows: rows.filter((r) => r.grupo === g.grupo) }))
      .filter((g) => g.rows.length > 0);
  }

  /** Groups modulos of the open plan modal by planta (in-project order). */
  planModalGroupedByPlanta(): Array<{ plantaId: number | null; plantaNombre: string; modulos: Modulo[]; done: number; total: number }> {
    const groups = new Map<number | null, Modulo[]>();
    for (const m of this.planModalModulos) {
      const key = m.planta ?? null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    const result: Array<{ plantaId: number | null; plantaNombre: string; modulos: Modulo[]; done: number; total: number }> = [];
    for (const [plantaId, modulos] of groups.entries()) {
      const sorted = [...modulos].sort((a, b) =>
        a.nombre.localeCompare(b.nombre, undefined, { numeric: true })
      );
      const done = sorted.filter(m => m.inferior_hecho && m.superior_hecho).length;
      result.push({
        plantaId,
        plantaNombre: plantaId != null ? (this.planModalPlantas.get(plantaId) || `Planta ${plantaId}`) : 'Sin planta',
        modulos: sorted,
        done,
        total: sorted.length
      });
    }
    result.sort((a, b) => a.plantaNombre.localeCompare(b.plantaNombre, undefined, { numeric: true }));
    return result;
  }

  moduloEstadoLabel(m: Modulo): 'Fabricado' | 'En proceso' | 'Pendiente' {
    if (m.inferior_hecho && m.superior_hecho) return 'Fabricado';
    if (m.inferior_hecho || m.superior_hecho) return 'En proceso';
    return 'Pendiente';
  }

  moduloEstadoClass(m: Modulo): 'done' | 'partial' | 'pending' {
    if (m.inferior_hecho && m.superior_hecho) return 'done';
    if (m.inferior_hecho || m.superior_hecho) return 'partial';
    return 'pending';
  }

  /**
   * Visual state of a project card: 'fabricando' when it's at the head of
   * at least one grupo-mesas queue (production running now); 'en-cola' when
   * it appears elsewhere in some queue but isn't the head; 'libre' when it
   * isn't in any queue.
   */
  proyectoEstado(proyecto: Proyecto): 'finalizado' | 'fabricando' | 'en-cola' | 'libre' {
    const total = proyecto.modulos_count || 0;
    const done = proyecto.modulos_completados || 0;
    if (total > 0 && done >= total) return 'finalizado';
    let enCola = false;
    for (const grupo of this.gruposMesas) {
      const cola = grupo.proyectos_cola || [];
      if (!cola.length) continue;
      if (cola[0].proyecto === proyecto.id) return 'fabricando';
      if (cola.some(e => e.proyecto === proyecto.id)) enCola = true;
    }
    return enCola ? 'en-cola' : 'libre';
  }

  proyectoEstadoLabel(proyecto: Proyecto): string {
    switch (this.proyectoEstado(proyecto)) {
      case 'finalizado': return 'Finalizado';
      case 'fabricando': return 'En fabricación';
      case 'en-cola': return 'En cola';
      default: return 'Sin asignar';
    }
  }

  // =========================================================================
  // GESTIONAR MESA MODAL
  // =========================================================================
  openGestionarModal(grupo: GrupoMesas): void {
    this.gestionandoGrupo = grupo;
    this.gestionarGrupoNombre = grupo.nombre;
    this.gestionarMesasEstados = {};
    for (const mesa of this.getMesasForGrupo(grupo.id)) {
      this.gestionarMesasEstados[mesa.id] = this.mesaEstadoActual(mesa);
    }
    this.gestionarAddProyectoId = null;
    this.showGestionarModal = true;
    this.cdr.detectChanges();
  }

  /** Estado tri-state derivado del modelo (tipo + activa). */
  mesaEstadoActual(mesa: { tipo: string; activa: boolean }): 'INFERIOR' | 'SUPERIOR' | 'INACTIVA' {
    if (!mesa.activa) return 'INACTIVA';
    return mesa.tipo === 'SUPERIOR' ? 'SUPERIOR' : 'INFERIOR';
  }

  /** Cambios pendientes vs estado actual de cada mesa. */
  cambiosMesasPendientes(): { mesa_id: number; tipo?: 'INFERIOR' | 'SUPERIOR'; activa?: boolean }[] {
    if (!this.gestionandoGrupo) return [];
    const out: { mesa_id: number; tipo?: 'INFERIOR' | 'SUPERIOR'; activa?: boolean }[] = [];
    for (const mesa of this.getMesasForGrupo(this.gestionandoGrupo.id)) {
      const estadoPendiente = this.gestionarMesasEstados[mesa.id];
      const estadoActual = this.mesaEstadoActual(mesa);
      if (!estadoPendiente || estadoPendiente === estadoActual) continue;

      const cambio: { mesa_id: number; tipo?: 'INFERIOR' | 'SUPERIOR'; activa?: boolean } = {
        mesa_id: mesa.id,
      };
      if (estadoPendiente === 'INACTIVA') {
        cambio.activa = false;
        // Conservamos el tipo actual.
      } else {
        cambio.tipo = estadoPendiente;
        cambio.activa = true;
      }
      out.push(cambio);
    }
    return out;
  }

  /** Cierre del modal: si hay cambios pendientes, confirma y aplica
   * antes de cerrar. Si no hay cambios, cierra directo. */
  intentarCerrarGestionarModal(): void {
    const cambios = this.cambiosMesasPendientes();
    if (cambios.length === 0) {
      this.cerrarGestionarSinCambios();
      return;
    }
    const total = cambios.length;
    const palabra = total === 1 ? 'cambio' : 'cambios';
    const msg = (
      `Aplicar ${total} ${palabra} en las mesas?\n\n` +
      'Los modulos pendientes se redistribuyen segun la nueva configuracion. ' +
      'Los bastidores INF en curso y los items SUP a medio fabricar se quedan donde estan.'
    );
    if (!confirm(msg)) return;

    if (!this.gestionandoGrupo) return;
    const grupo = this.gestionandoGrupo;
    this.gestionarAplicandoCambios = true;
    this.api.actualizarMesasGrupo(grupo.id, cambios).subscribe({
      next: () => {
        this.loadMesas();
        this.loadGruposMesas();
        this.gestionarAplicandoCambios = false;
        this.cerrarGestionarSinCambios();
      },
      error: (err) => {
        this.gestionarAplicandoCambios = false;
        alert(err?.error?.detail || 'No se pudieron aplicar los cambios.');
        this.cdr.detectChanges();
      },
    });
  }

  /** Cierra el modal limpiando el estado local. No aplica nada. */
  cerrarGestionarSinCambios(): void {
    this.showGestionarModal = false;
    this.gestionandoGrupo = null;
    this.gestionarGrupoNombre = '';
    this.gestionarMesasEstados = {};
    this.gestionarAplicandoCambios = false;
    this.gestionarAddProyectoId = null;
    this.cdr.detectChanges();
  }

  /** Alias retrocompat para callsites que ya esperan 'close' del modal. */
  closeGestionarModal(): void {
    this.intentarCerrarGestionarModal();
  }

  /** Projects that aren't already queued on this grupo — used for the 'add' dropdown. */
  proyectosDisponibles(grupo: GrupoMesas | null): Proyecto[] {
    if (!grupo) return this.proyectos;
    const queued = new Set(grupo.proyectos_cola.map(e => e.proyecto));
    return this.proyectos.filter(p => !queued.has(p.id));
  }

  /** Persist grupo rename (only if it actually changed). */
  saveGestionarGrupoNombre(): void {
    if (!this.gestionandoGrupo) return;
    const grupo = this.gestionandoGrupo;
    const target = this.gestionarGrupoNombre.trim();
    if (!target || target === grupo.nombre) return;
    this.gestionarBusy = true;
    this.api.updateGrupoMesas(grupo.id, { nombre: target }).subscribe({
      next: (updated) => {
        grupo.nombre = updated.nombre;
        // Also refresh the local grupo reference in gruposMesas
        const found = this.gruposMesas.find(g => g.id === grupo.id);
        if (found) found.nombre = updated.nombre;
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      },
      error: () => {
        alert('No se pudo renombrar el grupo.');
        this.gestionarGrupoNombre = grupo.nombre;
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      }
    });
  }


  addProyectoToCola(): void {
    if (!this.gestionandoGrupo || !this.gestionarAddProyectoId) return;
    const grupo = this.gestionandoGrupo;
    this.gestionarBusy = true;
    this.api.colaGrupoMesasAdd(grupo.id, this.gestionarAddProyectoId).subscribe({
      next: (updated) => {
        this.applyGestionarGrupoUpdate(updated);
        this.gestionarAddProyectoId = null;
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        alert(err?.error?.detail || 'No se pudo añadir el proyecto a la cola.');
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      }
    });
  }

  removeProyectoFromCola(proyectoId: number): void {
    if (!this.gestionandoGrupo) return;
    const grupo = this.gestionandoGrupo;
    this.gestionarBusy = true;
    this.api.colaGrupoMesasRemove(grupo.id, proyectoId).subscribe({
      next: (updated) => {
        this.applyGestionarGrupoUpdate(updated);
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      },
      error: () => {
        alert('No se pudo quitar el proyecto de la cola.');
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      }
    });
  }

  /**
   * Reorder via CDK drag-drop. Applies the new order locally (for instant
   * feedback), then persists. On error we revert.
   */
  onColaDrop(event: CdkDragDrop<GrupoMesasProyectoEntry[]>): void {
    if (!this.gestionandoGrupo) return;
    if (event.previousIndex === event.currentIndex) return;

    const grupo = this.gestionandoGrupo;
    const previous = [...grupo.proyectos_cola];
    moveItemInArray(grupo.proyectos_cola, event.previousIndex, event.currentIndex);
    this.cdr.detectChanges();

    const ids = grupo.proyectos_cola.map(e => e.proyecto);
    this.gestionarBusy = true;
    this.api.colaGrupoMesasReorder(grupo.id, ids).subscribe({
      next: (updated) => {
        this.applyGestionarGrupoUpdate(updated);
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      },
      error: () => {
        alert('No se pudo reordenar la cola.');
        grupo.proyectos_cola = previous;
        this.gestionarBusy = false;
        this.cdr.detectChanges();
      }
    });
  }

  /** Apply a fresh GrupoMesas payload onto the open modal and the sidebar list. */
  private applyGestionarGrupoUpdate(updated: GrupoMesas): void {
    const grupo = this.gruposMesas.find(g => g.id === updated.id);
    if (grupo) {
      grupo.proyecto_actual = updated.proyecto_actual;
      grupo.proyectos_cola = updated.proyectos_cola;
      grupo.nombre = updated.nombre;
    }
    if (this.gestionandoGrupo?.id === updated.id) {
      this.gestionandoGrupo = grupo || updated;
    }
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

  constructor(
    private api: ApiService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private listaMateriales: ListaMaterialesService,
  ) { }

  username: string = '';

  ngOnInit(): void {
    // Check auth
    if (!this.api.isLoggedIn()) {
      this.router.navigate(['/']);
      return;
    }

    this.username = this.api.getUsername() || 'Usuario';

    // Prevent back navigation
    history.pushState(null, '', location.href);
    window.onpopstate = function () {
      history.go(1);
    };

    this.loadProyectos();
    this.loadMesas();
    this.loadGruposMesas();
    this.selectStatsPreset('day');

    // Start Polling for Queue Updates (Every 5 seconds)
    // This handles the "Auto-DJ" logic: if an item finishes, the next one is picked up
    interval(5000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.pollMesasQueue();
        this.refreshActivePlantaModules();
      });

    // Slower loop (20s) to refresh project counters + production stats
    // so donut and stats boards follow admin actions without a reload.
    interval(20000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.silentRefreshProyectosAndStats();
      });
  }

  logout(): void {
    this.api.logout();
    this.router.navigate(['/']);
  }

  // Polling function to refresh queues and check for auto-advance
  pollMesasQueue(): void {
    // Skip polling during cross-mesa transfers to avoid DOM conflicts
    if (this.mesas.length === 0 || this.transferInProgress) return;

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
          error: (err) => this.logQueueError(mesa.id, 'polling', err)
        });
    });
  }

  private logQueueError(mesaId: number, context: 'polling' | 'loading', err: any): void {
    const now = Date.now();
    const last = this.queueErrorLogByMesa.get(mesaId) ?? 0;
    const status = err?.status;
    const isServerOrGatewayError = status >= 500 && status < 600;

    if (isServerOrGatewayError && now - last < this.queueErrorLogCooldownMs) {
      return;
    }

    this.queueErrorLogByMesa.set(mesaId, now);
    console.warn(`[Dashboard] Queue ${context} error mesa ${mesaId} (status: ${status ?? 'unknown'})`);
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
          // Refresh the selected project reference so the donut picks
          // up updated modulos_completados / modulos_completados_hoy.
          if (this.selectedProyecto) {
            const updated = data.find(p => p.id === this.selectedProyecto?.id);
            if (updated) this.selectedProyecto = updated;
          } else if (data.length > 0) {
            // Auto-select the first project on initial load so the stats
            // boards and donut have something to show without requiring
            // the user to click the sidebar card first.
            this.selectProyecto(data[0]);
          }
          this.loadingProyectos = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading proyectos', err);
          this.loadingProyectos = false;
        }
      });
  }

  /**
   * Silent refresh of projects + production stats — used by the polling
   * loop so donut and stats boards stay in sync with what the admin
   * does in parallel (completar/reiniciar) without a full page reload.
   */
  silentRefreshProyectosAndStats(): void {
    this.api.getProyectos()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.proyectos = data;
          if (this.selectedProyecto) {
            const updated = data.find(p => p.id === this.selectedProyecto?.id);
            if (updated) this.selectedProyecto = updated;
          }
          this.cdr.detectChanges();
        }
      });
    // Stats aggregate everything the ferralla owns — always refresh,
    // silently so the polling doesn't toggle the loading placeholder.
    this.loadStats(true);
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

  loadGruposMesas(): void {
    this.loadingGruposMesas = true;
    this.api.getGruposMesas()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.gruposMesas = data;
          this.gruposMesas.forEach((grupo) => {
            this.selectedProyectoPorGrupo[grupo.id] = grupo.proyecto_actual;
          });
          this.loadingGruposMesas = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading grupos de mesas', err);
          this.loadingGruposMesas = false;
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
        error: (err) => this.logQueueError(mesaId, 'loading', err)
      });
  }

  planificarGrupo(grupo: GrupoMesas): void {
    const proyectoId = this.selectedProyectoPorGrupo[grupo.id];
    if (!proyectoId) {
      alert('Selecciona un proyecto para planificar este grupo.');
      return;
    }

    this.planningGroupId = grupo.id;
    this.api.planificarGrupoMesas(grupo.id, proyectoId)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          this.selectedProyectoPorGrupo[grupo.id] = response.grupo.proyecto_actual;
          this.planningGroupId = null;
          this.loadGruposMesas();
          this.loadMesas();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.planningGroupId = null;
          console.error('Error planificando grupo', err);
          const detail = err?.error?.detail;
          const conflicts = err?.error?.conflicts;
          if (Array.isArray(conflicts) && conflicts.length) {
            alert(`${detail || 'No se pudo planificar el grupo.'}\n\n${conflicts.join('\n')}`);
            return;
          }
          alert(detail || 'No se pudo planificar el grupo.');
        }
      });
  }

  onProyectoGrupoSeleccionado(grupo: GrupoMesas, proyectoId: number | null): void {
    this.selectedProyectoPorGrupo[grupo.id] = proyectoId;
    if (!proyectoId) {
      return;
    }
    this.planificarGrupo(grupo);
  }

  // =========================================================================
  // PROJECT SELECTION
  // =========================================================================
  selectProyecto(proyecto: Proyecto): void {
    this.selectedProyecto = proyecto;
    this.selectedPlanta = null;
    this.selectedModulo = null;
    this.navLevel = 'projects';
    this.cdr.detectChanges();
  }

  /**
   * Loads stats for the currently selected range (statsFrom..statsTo).
   * Stats are aggregated at the ferralla level — one request covers
   * everything the user needs on the board.
   *
   * silent=true skips the loading flag so the periodic polling doesn't
   * flash 'Cargando…' every 20s when data already exists.
   */
  loadStats(silent: boolean = false): void {
    if (!this.statsFrom || !this.statsTo) {
      // Defaults: today → today
      const today = this.toLocalIsoDate(new Date());
      this.statsFrom = today;
      this.statsTo = today;
    }
    if (!silent || !this.statsData) this.loadingStats = true;
    this.api.getProductionStats({ from: this.statsFrom, to: this.statsTo })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.statsData = res;
          this.loadingStats = false;
          this.cdr.detectChanges();
        },
        error: () => {
          this.loadingStats = false;
          this.cdr.detectChanges();
        }
      });
  }

  selectStatsPreset(preset: 'day' | 'week' | 'month'): void {
    const today = new Date();
    this.statsPreset = preset;
    if (preset === 'day') {
      this.statsFrom = this.toLocalIsoDate(today);
      this.statsTo = this.toLocalIsoDate(today);
    } else if (preset === 'week') {
      this.statsFrom = this.toLocalIsoDate(this.getMondayOfWeek(today));
      this.statsTo = this.toLocalIsoDate(today);
    } else if (preset === 'month') {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      this.statsFrom = this.toLocalIsoDate(firstDay);
      this.statsTo = this.toLocalIsoDate(today);
    }
    this.loadStats();
  }

  onStatsDateChange(): void {
    this.statsPreset = 'custom';
    if (this.statsFrom && this.statsTo && this.statsFrom > this.statsTo) {
      this.statsTo = this.statsFrom;
    }
    this.loadStats();
  }

  private toLocalIsoDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private getMondayOfWeek(d: Date): Date {
    const result = new Date(d);
    const day = result.getDay(); // 0 (Sun) to 6 (Sat)
    const diff = (day === 0 ? -6 : 1 - day);
    result.setDate(result.getDate() + diff);
    return result;
  }

  mesaStatsLabel(mesa: { tipo: string; indice: number }): string {
    const tipoSuffix = mesa.tipo === 'INFERIOR' ? ' INF' :
                       mesa.tipo === 'SUPERIOR' ? ' SUP' : '';
    return `Mesa ${mesa.indice}${tipoSuffix}`;
  }

  dayLabel(iso: string): string {
    const parts = iso.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const names = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    return `${names[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}`;
  }

  // =========================================================================
  // STATS BUCKETS (daily for short ranges, ISO-week for long ones)
  // =========================================================================

  /**
   * Splits the selected range into chart buckets. Ranges up to 20 days
   * produce one bucket per day so short views stay readable; longer
   * ranges collapse each ISO week into a single bucket so a month+
   * selection doesn't create a forest of skinny bars.
   *
   * Each bucket already includes its own expected meta (daily cap ×
   * working days it covers), so the charts can draw the objetivo line
   * correctly regardless of granularity.
   */
  statsBuckets(): Array<{
    key: string;
    label: string;
    modulos_completados: number;
    fases_completadas: number;
    peso_malla_inicial_kg: number;
    peso_malla_final_kg: number;
    desperdicio_kg: number;
    dificultad_total: number;
    meta_modulos: number;
    working_days: number;
    granularity: 'hour' | 'day' | 'week';
  }> {
    if (!this.statsData || !this.statsFrom || !this.statsTo) return [];
    const from = this.parseIsoDate(this.statsFrom);
    const to = this.parseIsoDate(this.statsTo);
    if (!from || !to || from > to) return [];

    const dayCount = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
    const byDate = new Map(this.statsData.por_dia.map(d => [d.fecha, d]));
    const dailyCap = this.statsData.esperado?.capacidad_diaria_modulos || 0;

    // Single-day view: bucket por hour using por_hora from the backend.
    // Fixed working window 08h-17h so the X axis stays predictable; data
    // outside that window is rare and would only be visible in the table.
    if (dayCount === 1 && this.statsData.por_hora) {
      const byHour = new Map(this.statsData.por_hora.map(h => [h.hora, h]));
      const hoursToShow = ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17'];
      const hourlyCap = dailyCap > 0 ? dailyCap / hoursToShow.length : 0;
      return hoursToShow.map((hh) => {
        const found = byHour.get(hh);
        return {
          key: hh,
          label: `${hh}h`,
          modulos_completados: found?.modulos_completados || 0,
          fases_completadas: found?.fases_completadas || 0,
          peso_malla_inicial_kg: found?.peso_malla_inicial_kg || 0,
          peso_malla_final_kg: found?.peso_malla_final_kg || 0,
          desperdicio_kg: found?.desperdicio_kg || 0,
          dificultad_total: found?.dificultad_total || 0,
          meta_modulos: hourlyCap,
          working_days: 0,
          granularity: 'hour' as const,
        };
      });
    }

    if (dayCount <= 20) {
      // Daily view: skip weekends entirely so the X axis stays clean
      // (no empty Sat/Sun columns breaking the visual).
      const buckets = [];
      for (let i = 0; i < dayCount; i++) {
        const d = new Date(from);
        d.setDate(from.getDate() + i);
        if (!this.isWorkingDay(d)) continue;
        const iso = this.toLocalIsoDate(d);
        const found = byDate.get(iso);
        buckets.push({
          key: iso,
          label: this.dayLabel(iso),
          modulos_completados: found?.modulos_completados || 0,
          fases_completadas: found?.fases_completadas || 0,
          peso_malla_inicial_kg: found?.peso_malla_inicial_kg || 0,
          peso_malla_final_kg: found?.peso_malla_final_kg || 0,
          desperdicio_kg: found?.desperdicio_kg || 0,
          dificultad_total: found?.dificultad_total || 0,
          meta_modulos: dailyCap,
          working_days: 1,
          granularity: 'day' as const
        });
      }
      return buckets;
    }

    const buckets = [];
    const cursor = this.getMondayOfWeek(from);
    while (cursor <= to) {
      const weekStart = new Date(cursor);
      const weekEnd = new Date(cursor);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const segStart = weekStart < from ? new Date(from) : weekStart;
      const segEnd = weekEnd > to ? new Date(to) : weekEnd;

      let modulos = 0, fases = 0, pi = 0, pf = 0, desp = 0, dif = 0, workDays = 0;
      const d = new Date(segStart);
      while (d <= segEnd) {
        const iso = this.toLocalIsoDate(d);
        const found = byDate.get(iso);
        if (found) {
          modulos += found.modulos_completados || 0;
          fases += found.fases_completadas || 0;
          pi += found.peso_malla_inicial_kg || 0;
          pf += found.peso_malla_final_kg || 0;
          desp += found.desperdicio_kg || 0;
          dif += found.dificultad_total || 0;
        }
        if (this.isWorkingDay(d)) workDays++;
        d.setDate(d.getDate() + 1);
      }

      buckets.push({
        key: this.toLocalIsoDate(weekStart),
        label: `S${this.getIsoWeek(weekStart)}`,
        modulos_completados: modulos,
        fases_completadas: fases,
        peso_malla_inicial_kg: pi,
        peso_malla_final_kg: pf,
        desperdicio_kg: desp,
        dificultad_total: dif,
        meta_modulos: dailyCap * workDays,
        working_days: workDays,
        granularity: 'week' as const
      });

      cursor.setDate(cursor.getDate() + 7);
    }
    return buckets;
  }

  private parseIsoDate(iso: string): Date | null {
    if (!iso) return null;
    const parts = iso.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  private isWorkingDay(d: Date): boolean {
    const day = d.getDay();
    return day >= 1 && day <= 5;
  }

  private getIsoWeek(d: Date): number {
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayNr = (target.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.getTime();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
      target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
    }
    return 1 + Math.ceil((firstThursday - target.getTime()) / 604800000);
  }

  /** Max Y value for the modules chart (uses meta as the floor). */
  chartMaxModulos(): number {
    const buckets = this.statsBuckets();
    const maxReal = Math.max(0, ...buckets.map(b => b.modulos_completados || 0));
    const maxMeta = Math.max(0, ...buckets.map(b => b.meta_modulos || 0));
    return Math.max(maxReal, maxMeta, 1) * 1.15;
  }

  /** Max Y value for the weight chart. */
  chartMaxPeso(): number {
    const buckets = this.statsBuckets();
    const max = Math.max(0, ...buckets.map(b => b.peso_malla_final_kg || 0));
    return Math.max(max, 1) * 1.15;
  }

  /**
   * Color for the dificultad dot. Gradient: blue (easy, near 0) ->
   * green (average, ~100) -> red (hard, 200+). Values are clamped so
   * the dot never leaves the scale.
   */
  dificultadColor(value: number | null | undefined): string {
    if (value == null) return 'transparent';
    const clamped = Math.min(Math.max(value, 0), 200);
    let hue: number;
    if (clamped <= 100) {
      hue = 210 - (clamped / 100) * 90;          // blue (210) -> green (120)
    } else {
      hue = 120 - ((clamped - 100) / 100) * 120; // green (120) -> red (0)
    }
    return `hsl(${hue}, 65%, 50%)`;
  }

  /** Short label so the tooltip is easier to read than a bare number. */
  dificultadLabel(value: number | null | undefined): string {
    if (value == null) return '';
    if (value < 60) return 'Muy fácil';
    if (value < 90) return 'Fácil';
    if (value < 115) return 'Media';
    if (value < 150) return 'Difícil';
    return 'Muy difícil';
  }

  /**
   * Desperdicio as a percentage of the material initially loaded.
   * Returns null when there's nothing to compare against so the
   * caller can decide whether to render the subtext at all.
   */
  desperdicioPct(totals: { desperdicio_kg?: number; peso_malla_inicial_kg?: number } | null | undefined): number | null {
    if (!totals) return null;
    const initial = totals.peso_malla_inicial_kg || 0;
    if (initial <= 0) return null;
    const waste = totals.desperdicio_kg || 0;
    return (waste / initial) * 100;
  }

  /** % height (0..100) of a value on the modules chart. */
  modulosBarPct(value: number): number {
    const max = this.chartMaxModulos();
    if (max <= 0) return 0;
    return Math.min(100, (value / max) * 100);
  }

  pesoBarPct(value: number): number {
    const max = this.chartMaxPeso();
    if (max <= 0) return 0;
    return Math.min(100, (value / max) * 100);
  }

  chartMaxDificultad(): number {
    const buckets = this.statsBuckets();
    const max = Math.max(0, ...buckets.map(b => b.dificultad_total || 0));
    return Math.max(max, 1) * 1.15;
  }

  dificultadBarPct(value: number): number {
    const max = this.chartMaxDificultad();
    if (max <= 0) return 0;
    return Math.min(100, (value / max) * 100);
  }

  /** Short label for large difficulty numbers (e.g. 1346 -> '1.3k'). */
  formatDificultadShort(value: number): string {
    if (!value) return '';
    if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(value).toString();
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

      // Lock polling during backend sync
      this.transferInProgress = true;

      // Backend strategy: Create in new mesa FIRST, then delete from old mesa.
      // If create fails, we reload causing a "revert".
      // If delete fails, we might have a duplicate, reload fixes it too.

      this.api.moveMesaQueueItem(item.id, mesaId, event.currentIndex).subscribe({
        next: () => {
          console.log('[Dashboard] Transfer success (Atomic Move)');
          // Reload both queues to ensure positions are correct (close gaps in source, open gap in target)
          if (sourceMesaId) this.loadMesaQueueItems(sourceMesaId);
          this.loadMesaQueueItems(mesaId);

          setTimeout(() => {
            this.transferInProgress = false;
          }, 300);
        },
        error: (err) => {
          console.error('Transfer failed (Atomic Move)', err);
          // Revert UI by reloading from backend
          this.mesas.forEach(m => this.loadMesaQueueItems(m.id));
          this.transferInProgress = false;
          alert('Error al mover el item. Se recargarán las colas.');
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
    // Hide items already done; they shouldn't stay in the queue view.
    return (this.mesaQueueItems.get(mesaId) || []).filter(i => i.status !== 'HECHO');
  }

  getMesaRoleLabel(mesa: { indice: number }): string {
    return `Mesa ${mesa.indice}`;
  }

  getMesaTipoLabel(mesa: { tipo: string }): string {
    switch (mesa.tipo) {
      case 'INFERIOR': return 'INF';
      case 'SUPERIOR': return 'SUP';
      default: return '';
    }
  }

  /**
   * Muestra separador "Grupo N" antes de un item si el plan_group_index
   * difiere del item anterior. Solo se aplica a mesas inferiores;
   * en mesas SUPERIORES no tiene sentido agrupar visualmente.
   */
  shouldShowGroupDivider(item: MesaQueueItem, index: number, mesa: Mesa): boolean {
    if (mesa.tipo === 'SUPERIOR') return false;
    const current = item.plan_group_index;
    if (current == null) return false;
    if (index === 0) return true;
    const items = this.getMesaQueueItems(mesa.id);
    const previous = items[index - 1]?.plan_group_index;
    return current !== previous;
  }

  getItemGrupoIndice(item: MesaQueueItem): number | null {
    return item.plan_group_index ?? null;
  }

  /**
   * Divider label for queue items. Reads the grupo_bastidor name
   * stored on the backend (seeded as "Grupo N" on creation, editable
   * from the admin). The value restarts per project because each
   * project owns its own GrupoBastidor rows.
   */
  getItemGrupoLabel(item: MesaQueueItem): string {
    const nombre = (item.grupo_bastidor_nombre || '').trim();
    if (nombre) return nombre;
    const indice = item.grupo_bastidor_indice;
    return indice != null ? `Grupo ${indice}` : 'Grupo';
  }

  /**
   * The item currently MOSTRANDO on a SUP mesa is shown above both
   * INF1/INF2 sub-columns (full width) so the operator can spot it fast.
   */
  getSupMostrandoItem(mesaId: number): MesaQueueItem | null {
    return this.getMesaQueueItems(mesaId).find(i => i.status === 'MOSTRANDO') || null;
  }

  /**
   * Daily cap shown in each mesa queue.
   * The ferralla has a total daily capacity (e.g. 12) which is split
   * evenly between INF1 and INF2 (6 each). SUP has to finish the
   * superiores of both, so SUP = sum of INF items actually visible.
   */
  private getFerrallaDailyTotal(): number {
    return this.selectedProyecto?.capacidad_diaria_usuario || 12;
  }

  private getMesaDailyCapForProject(mesa?: Mesa): number {
    const total = this.getFerrallaDailyTotal();
    if (!mesa) return total;
    if (mesa.tipo === 'SUPERIOR') {
      const infMesas = this.mesas.filter(
        m => m.grupo === mesa.grupo && m.tipo === 'INFERIOR' && m.activa
      );
      const numInf = Math.max(infMesas.length, 1);
      const infCap = Math.ceil(total / numInf);
      let sum = 0;
      for (const inf of infMesas) {
        sum += Math.min(this.getMesaQueueItems(inf.id).length, infCap);
      }
      // Reparte la suma entre las superiores activas del grupo (round-robin).
      const numSup = Math.max(
        this.mesas.filter(m => m.grupo === mesa.grupo && m.tipo === 'SUPERIOR' && m.activa).length,
        1,
      );
      return Math.ceil(sum / numSup);
    }
    if (mesa.tipo === 'INFERIOR') {
      const numInf = Math.max(
        this.mesas.filter(m => m.grupo === mesa.grupo && m.tipo === 'INFERIOR' && m.activa).length,
        1,
      );
      return Math.ceil(total / numInf);
    }
    return total;
  }

  /**
   * Items visible in a regular (INF) mesa queue: at most `capacidad_diaria`
   * entries. Everything else is collapsed into a "+N más" caption.
   */
  getVisibleMesaQueueItems(mesaId: number): MesaQueueItem[] {
    const mesa = this.mesas.find(m => m.id === mesaId);
    return this.getMesaQueueItems(mesaId).slice(0, this.getMesaDailyCapForProject(mesa));
  }

  getHiddenMesaQueueCount(mesaId: number): number {
    const mesa = this.mesas.find(m => m.id === mesaId);
    const total = this.getMesaQueueItems(mesaId).length;
    return Math.max(0, total - this.getMesaDailyCapForProject(mesa));
  }

  /**
   * Split SUP queue into two columns based on item parity among non-showing items.
   * The planner emits items alternating between INF1 and INF2 feeders.
   * Only the first `2 x capacidad_diaria` items are surfaced so SUP matches
   * the daily output of both INF mesas combined.
   */
  getSupQueueColumn(mesaId: number, columnIndex: number): MesaQueueItem[] {
    const mesa = this.mesas.find(m => m.id === mesaId);
    const rest = this.getMesaQueueItems(mesaId)
      .filter(i => i.status !== 'MOSTRANDO')
      .slice(0, this.getMesaDailyCapForProject(mesa));
    return rest.filter((_, i) => i % 2 === columnIndex);
  }

  getSupHiddenCount(mesaId: number): number {
    const mesa = this.mesas.find(m => m.id === mesaId);
    const rest = this.getMesaQueueItems(mesaId).filter(i => i.status !== 'MOSTRANDO');
    return Math.max(0, rest.length - this.getMesaDailyCapForProject(mesa));
  }


  getProyectoNombre(projectId: number | null): string {
    if (!projectId) return 'Sin proyecto asignado';
    return this.proyectos.find((proyecto) => proyecto.id === projectId)?.nombre || `Proyecto ${projectId}`;
  }

  // =========================================================================
  // PROJECT PROGRESS DONUT
  // =========================================================================
  private getProyectoBreakdown(p: Proyecto) {
    const total = p.modulos_count || 0;
    const done = p.modulos_completados || 0;
    const pending = Math.max(total - done, 0);
    // Only the project at the head of some grupo-mesas queue is actually
    // being worked on right now; queued/free projects shouldn't show a
    // forecast on the donut because nobody is producing them yet.
    const isFabricando = this.proyectoEstado(p) === 'fabricando';
    if (!isFabricando) {
      return { total, done, hoy: 0, semana: 0, resto: pending };
    }
    const daily = p.capacidad_diaria_usuario || 12;
    const doneToday = p.modulos_completados_hoy || 0;
    // How many more can still be produced today after what's already done.
    const remainingToday = Math.max(daily - doneToday, 0);
    const hoy = Math.min(pending, remainingToday);
    // Week = 5 working days; today already covers doneToday + hoy, so the
    // rest-of-the-week slot fits at most the remaining 4 days of capacity.
    const semana = Math.min(Math.max(pending - hoy, 0), daily * 4);
    const resto = Math.max(pending - hoy - semana, 0);
    return { total, done, hoy, semana, resto };
  }

  getProyectoHoy(p: Proyecto): number {
    return this.getProyectoBreakdown(p).hoy;
  }

  getProyectoSemana(p: Proyecto): number {
    return this.getProyectoBreakdown(p).semana;
  }

  getProyectoPct(p: Proyecto): number {
    const { total, done } = this.getProyectoBreakdown(p);
    if (!total) return 0;
    return Math.round((done / total) * 100);
  }

  /**
   * Returns the stroke-dasharray for the requested donut layer.
   * Each layer is additive (done ⊂ todayish ⊂ weekish), so the outer
   * rings partially cover the base track.
   */
  getDonutDash(p: Proyecto, layer: 'done' | 'todayish' | 'weekish'): string {
    const { total, done, hoy, semana } = this.getProyectoBreakdown(p);
    if (!total) return '0 100';
    let value = 0;
    if (layer === 'done') value = done;
    else if (layer === 'todayish') value = done + hoy;
    else value = done + hoy + semana;
    const pct = (value / total) * 100;
    return `${pct} ${100 - pct}`;
  }

  getMesasForGrupo(grupoId: number): Mesa[] {
    // Ahora el indice es global por grupo, asi que ordenar por indice
    // basta. Mesa 1, Mesa 2, ... independientemente del tipo.
    return this.mesas
      .filter((mesa) => mesa.grupo === grupoId)
      .sort((a, b) => (a.indice ?? 0) - (b.indice ?? 0));
  }

  getMesasSinGrupo(): Mesa[] {
    return this.mesas
      .filter((mesa) => mesa.grupo === null)
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  abrirProyectoGrupo(grupo: GrupoMesas): void {
    const proyectoId = this.selectedProyectoPorGrupo[grupo.id] ?? grupo.proyecto_actual;
    if (!proyectoId) {
      alert('Este grupo todavía no tiene un proyecto seleccionado.');
      return;
    }

    const proyecto = this.proyectos.find((item) => item.id === proyectoId);
    if (!proyecto) {
      alert('No se encontró el proyecto asociado a este grupo.');
      return;
    }

    this.selectProyecto(proyecto);
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

  trackByGrupo(index: number, grupo: GrupoMesas): number {
    return grupo.id;
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
