import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule, formatDate, formatNumber } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DragDropModule, CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';

import {
  ApiService,
  Proyecto, Modulo, Mesa, ModuloQueueItem, MesaQueueItem, Imagen, FotoFabricacion,
  EstrategiaColaSuperior, GrupoMesas, GrupoMesasProyectoEntry, ProductionStatsResponse, ModuloFase,
  GrupoBastidor, GrupoBastidorModulo, FerrallaCaptureConfig, TurnoConfig,
  TiempoFabricacion, ProductionStatsBucket, ProductionStatsTiempos, ProductionStatsModulo, ProductionStatsModuloFase,
  ProductionStatsActividadDia,
  ElementosSueltos, ElementosSueltosHoja, ElementosSueltosSeccion, ElementosSueltosCelda,
} from '../services/api.service';
import { LineChartSeries, SplitArea, StatsLineChart } from './stats-line-chart';
import { PlanificacionFerralla } from './planificacion-ferralla';
import { TurnosEditorComponent } from '../shared/turnos-editor.component';
import { copiarTurnos, turnosError, turnosLabel } from '../shared/turnos';
import {
  ListaMaterialesService,
  ListaMaterialesProyecto,
  ListaMaterialesGeneral,
  RenglonLista,
  RenglonGeneralAgrupado,
  BloqueGeneralPorProyecto,
  GrupoMaterial,
} from '../services/lista-materiales.service';
import { Subject, takeUntil, interval, forkJoin, Observable, of } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { ZoomableImageComponent } from '../shared/zoomable-image/zoomable-image.component';
import { planningIssues, planningLabel } from '../shared/project-planning';
import { agruparPorEdificio, GrupoEdificio } from '../shared/edificios';

// Graficas: naranja de marca para la serie principal, gris para las secundarias
// y azul + naranja donde hay dos series (par validado para daltonismo).
const CHART_NARANJA = '#f0640f';
const CHART_AZUL = '#2a78d6';
const CHART_GRIS = '#52606d';
// El tiempo muerto va en mostaza, el mismo color que sus cifras (--warn del tema):
// en la grafica del turno es el relleno de encima de la linea.
const CHART_AMARILLO = '#b7791f';

/** Pestanas del dashboard, cada una con su ruta (/dashboard, /dashboard/estadisticas...). */
type DashboardVista = 'produccion' | 'estadisticas' | 'planificacion';

/** Un dia o una hora tal y como los da el servidor (la hora trae minutos, no horas). */
type StatsFuente = ProductionStatsBucket & ProductionStatsTiempos & ProductionStatsActividadDia & {
  modulos_completados: number;
  minutos_turno?: number;
  minutos_trabajo?: number;
  minutos_muertos?: number;
};

/** Una columna de las graficas y una fila de la tabla por periodo. */
export interface StatsBucket {
  key: string;
  label: string;
  modulos_completados: number;
  fases_completadas: number;
  /** Peso real fabricado (malla + refuerzos + zunchos + separadores + punzonamientos). */
  peso_total_kg: number;
  peso_malla_inicial_kg: number;
  peso_malla_final_kg: number;
  desperdicio_kg: number;
  desperdicio_pct: number | null;
  dificultad_total: number;
  tiempo_inferior_min: number | null;
  tiempo_superior_min: number | null;
  /** Horas de turno, de trabajo y muertas (null si el servidor no las da). */
  horas_turno: number | null;
  horas_trabajo: number | null;
  horas_muertas: number | null;
  /** Trabajo fuera de las horas de turno, ya dentro de horas_trabajo. */
  horas_fuera_turno: number | null;
  /** Ninguna señal en el turno: todo el tiempo muerto es "sin registro". */
  sin_registro: boolean;
  /** Sin registro de eventos: el trabajo sale de fotos y fases hechas. */
  estimado: boolean;
  /** Primera y última señal del día (ISO); solo por día. */
  abre: string | null;
  cierra: string | null;
  meta_modulos: number;
  working_days: number;
  granularity: 'hour' | 'day' | 'week';
  /** Aun no ha llegado: no se dibuja. */
  futuro: boolean;
  /** Es la hora, el dia o la semana de ahora mismo: aun puede llegar al objetivo. */
  en_curso: boolean;
}

interface StatsVecino {
  modulos: number;
  peso: number;
  dificultad: number;
  desperdicio_pct: number | null;
  tiempo_inferior: number | null;
  tiempo_superior: number | null;
}

/** Todo lo que pintan las graficas y la tabla por periodo de las estadisticas. */
export interface StatsVista {
  labels: string[];
  pending: boolean[];
  objetivo: Array<number | null> | null;
  objetivoLabel: string;
  modulos: LineChartSeries[];
  peso: LineChartSeries[];
  tiempo: LineChartSeries[];
  /** % del turno trabajado: debajo de la linea el trabajo, encima el tiempo muerto. */
  horas: LineChartSeries[];
  /** Por hora del dia, las horas van en minutos. */
  horasUnidad: 'h' | 'min';
  /** Solo las filas por dia traen la primera y la ultima señal. */
  conSenales: boolean;
  filas: StatsBucket[];
  detalleTitulo: string;
  periodoLabel: string;
}

export interface StatsResumen {
  /** Vista de un dia: media y mejor van por hora, no por dia. */
  porHora: boolean;
  media: number | null;
  mejor: { modulos: number; label: string } | null;
  kgPorModulo: number | null;
  dificultadMedia: number | null;
  /** Lo que se gasta: peso producido mas desperdicio. */
  pesoTotal: number;
}

/** Un bastidor del plan tal y como lo ve la ferralla: en orden de fabricacion. */
export interface PlanSeccion {
  key: string;
  titulo: string;
  grupo: GrupoBastidor | null;
  modulos: Modulo[];
  hechos: number;
  /** Todos sus modulos fabricados: ya no va a pasar por la mesa. */
  terminado: boolean;
}

/** Una mesa inferior del plan con los bastidores que tiene por delante. */
export interface PlanColumna {
  key: string;
  mesaId: number | null;
  nombre: string;
  secciones: PlanSeccion[];
  terminados: number;
}

const compareModulosByName = (a: Modulo, b: Modulo) =>
  a.nombre.localeCompare(b.nombre, undefined, { numeric: true });

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
  styleUrls: ['../admin/admin-theme.css', './dashboard.css', './dashboard-responsive.css'],
  imports: [CommonModule, DragDropModule, FormsModule, ZoomableImageComponent, StatsLineChart, TurnosEditorComponent, PlanificacionFerralla]
})
export class Dashboard implements OnInit, OnDestroy {
  readonly planningLabel = planningLabel;
  // Sidebar State
  panelState: 'collapsed' | 'expanded' = 'expanded';
  // Data
  proyectos: Proyecto[] = [];
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
  loadingModulos = false;
  loadingImagenes = false; // Loading images for expanded module
  loadingMesas = false;
  loadingGruposMesas = false;

  // Selection State
  selectedProyecto: Proyecto | null = null;
  selectedModulo: Modulo | null = null;

  // Stats State
  statsData: ProductionStatsResponse | null = null;
  loadingStats = false;
  statsError = '';
  private statsVistaCache: {
    data: ProductionStatsResponse; from: string; to: string; horario: FerrallaCaptureConfig | null; hora: number; vista: StatsVista;
  } | null = null;
  private statsRequestId = 0;
  /** Peticiones de estadisticas aun sin respuesta: el refresco no manda otra encima. */
  private statsEnVuelo = 0;
  /** Sondeo de 5 s aun sin respuesta: si el servidor va lento, no se amontona. */
  private colasEnVuelo = false;
  private modulosEnVuelo = false;
  statsPreset: 'day' | 'week' | 'month' | 'proyecto' | 'custom' = 'day';
  /** Proyecto al que se limitan las estadisticas; null = todos. */
  statsProyecto: number | null = null;
  /** Estadisticas de un edificio entero (todos sus forjados). */
  statsEdificio: number | null = null;
  /** Turno al que se limitan las estadisticas; null = todos. */
  statsTurno: number | null = null;
  /** Turnos de la ferralla segun las ultimas estadisticas (para el selector). */
  statsTurnos: Array<{ indice: number; nombre: string }> = [];
  statsFrom: string = '';
  statsTo: string = '';

  // UI State
  expandedModulo: number | null = null; // ID of expanded module
  dragOverMesa: number | null = null; // ID of mesa being dragged over

  // Drag State
  draggedSubfase: Subfase | null = null;
  transferInProgress = false;

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

  /** Dos dashboards sobre el mismo componente: produccion (mesas y proyectos) o estadisticas. */
  vista: DashboardVista = 'produccion';

  // Turnos de trabajo de la ferralla (los cambia ella; Moden los usa para la captura).
  horario: FerrallaCaptureConfig | null = null;
  horarioEditing = false;
  /** Copia de los turnos que se esta editando. */
  turnosDraft: TurnoConfig[] = [];
  savingHorario = false;
  horarioError = '';

  // Project-plan Modal State
  showPlanModal = false;
  planModalProyecto: Proyecto | null = null;
  planModalModulos: Modulo[] = [];
  /** Bastidores del proyecto (raices y partes), en orden de fabricacion. */
  planModalGrupos: GrupoBastidor[] = [];
  planModalBusy = false;
  planModalError = '';
  /** Los bastidores terminados se apilan al principio de su mesa, plegados por defecto. */
  planModalShowDone = false;
  private planSeccionesCache: { modulos: Modulo[]; grupos: GrupoBastidor[]; value: PlanSeccion[] } | null = null;
  private planColumnasCache: {
    secciones: PlanSeccion[]; grupos: GrupoMesas[]; showDone: boolean; value: PlanColumna[];
  } | null = null;
  readonly modulePhases: ModuloFase[] = ['INFERIOR', 'SUPERIOR'];
  phaseResetTarget: { module: Modulo; phase: ModuloFase } | null = null;
  resettingPhase = false;
  phaseResetError = '';
  loadingPlanModal = false;
  showPlanFotosModal = false;
  planFotosTarget: { id: number; nombre: string } | null = null;
  planFotos: FotoFabricacion[] = [];
  loadingPlanFotos = false;
  selectedPlanFotoIndex = 0;
  downloadingPlanFotosZip = false;

  // Materiales-list Modal State (per-project)
  // Excel de elementos sueltos (barras, vigas, zunchos que van a obra fuera de los modulos).
  elementosModalProyecto: Proyecto | null = null;
  elementosModalData: ElementosSueltos | null = null;
  elementosModalLoading = false;
  elementosModalError = '';
  elementosModalHoja = 0;
  private elementosModalRequest = 0;

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
  gestionarBusy = false;
  showColaModal = false;
  /** Grupo cuyo orden de superiores se está cambiando desde el card de su mesa SUP. */
  estrategiaBusyGrupoId: number | null = null;
  /** Mesa SUP cuya cola se está reordenando con las flechas del card. */
  mesaReorderBusyId: number | null = null;
  /** Proyecto cuya fecha de montaje en obra se está guardando desde su card. */
  fechaObraGuardandoId: number | null = null;
  /** Proyectos que Moden ha asignado y la ferralla aún no ha aceptado. */
  proyectosPendientes: Proyecto[] = [];
  showNotificacionesModal = false;
  aceptandoProyectoId: number | null = null;
  /** Opciones de orden de la cola superior, en el card de cada mesa SUP. */
  readonly estrategiasSuperior: { valor: EstrategiaColaSuperior; etiqueta: string; icono: string; ayuda: string }[] = [
    { valor: 'PLANIFICADA', etiqueta: 'Planificado', icono: 'fa-random', ayuda: 'Planificado: intercala las mesas inferiores una a una.' },
    { valor: 'ADAPTATIVA', etiqueta: 'Adaptativo', icono: 'fa-bolt', ayuda: 'Adaptativo: prioriza los superiores que ya necesita la producción inferior.' },
    { valor: 'MANUAL', etiqueta: 'Manual', icono: 'fa-hand-paper-o', ayuda: 'Manual: lo ordenáis vosotros con las flechas; lo nuevo entra al final.' },
  ];

  verPlano(proyecto: Proyecto): void {
    if (proyecto.plano_archivo) {
      this.blueprintUrl = this.resolveUrl(proyecto.plano_archivo);
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
    this.planModalGrupos = [];
    this.planModalError = '';
    // Un proyecto terminado solo tiene bastidores terminados: se abren a la vista.
    this.planModalShowDone = !!proyecto.modulos_count && (proyecto.modulos_completados ?? 0) >= proyecto.modulos_count;
    this.loadingPlanModal = true;
    this.cdr.detectChanges();

    forkJoin({
      modulos: this.api.getProyectoModulos(proyecto.id),
      grupos: this.api.getGruposBastidor(proyecto.id).pipe(catchError(() => of([] as GrupoBastidor[]))),
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: ({ modulos, grupos }) => {
        this.planModalModulos = modulos;
        this.planModalGrupos = grupos;
        if (modulos.length && modulos.every(m => this.moduloEstadoClass(m) === 'done')) this.planModalShowDone = true;
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
    if (this.resettingPhase || this.planModalBusy) return;
    this.phaseResetTarget = null;
    this.showPlanModal = false;
    this.planModalProyecto = null;
    this.planModalModulos = [];
    this.planModalGrupos = [];
    this.planModalError = '';
    this.planModalShowDone = false;
    this.closePlanFotosModal();
    this.cdr.detectChanges();
  }

  // ---- Plan por bastidores: lo que la ferralla puede tocar --------------

  grupoEtiqueta(grupo: GrupoBastidor): string {
    if (grupo.etiqueta) return grupo.etiqueta;
    const base = grupo.nombre || `Bastidor ${grupo.indice}`;
    if (!grupo.sufijo) return base;
    return grupo.nombre ? `${base} ${grupo.sufijo}` : `${base}${grupo.sufijo}`;
  }

  /**
   * Secciones del modal: un bastidor por seccion, con sus modulos en orden
   * de fabricacion (el card del admin se fabrica de abajo arriba). Los
   * modulos sin bastidor van al final.
   */
  planModalSecciones(): PlanSeccion[] {
    const cache = this.planSeccionesCache;
    if (cache && cache.modulos === this.planModalModulos && cache.grupos === this.planModalGrupos) {
      return cache.value;
    }
    const value = this.buildPlanSecciones();
    this.planSeccionesCache = { modulos: this.planModalModulos, grupos: this.planModalGrupos, value };
    return value;
  }

  private buildPlanSecciones(): PlanSeccion[] {
    const byId = new Map(this.planModalModulos.map(m => [m.id, m]));
    const asignados = new Set<number>();
    const secciones: PlanSeccion[] = [];
    for (const grupo of this.planModalGrupos) {
      const modulos = this.fabricacionOrder(grupo)
        .map(gm => byId.get(gm.id))
        .filter((m): m is Modulo => !!m);
      modulos.forEach(m => asignados.add(m.id));
      const hechos = modulos.filter(m => m.inferior_hecho && m.superior_hecho).length;
      secciones.push({
        key: `g${grupo.id}`,
        titulo: this.grupoEtiqueta(grupo),
        grupo,
        modulos,
        hechos,
        terminado: modulos.length > 0 && hechos === modulos.length,
      });
    }
    const sueltos = this.planModalModulos.filter(m => !asignados.has(m.id)).sort(compareModulosByName);
    if (sueltos.length > 0 || secciones.length === 0) {
      secciones.push({
        key: 'sin-bastidor',
        titulo: secciones.length ? 'Sin bastidor' : 'Módulos',
        grupo: null,
        modulos: sueltos,
        hechos: sueltos.filter(m => m.inferior_hecho && m.superior_hecho).length,
        terminado: false,
      });
    }
    return secciones;
  }

  /** Mesas inferiores activas de la ferralla, en el orden de sus grupos. */
  planMesas(): Array<{ id: number | null; nombre: string }> {
    const mesas: Array<{ id: number; nombre: string }> = [];
    for (const grupo of this.gruposMesas) {
      const propias = (grupo.mesas || [])
        .filter(m => m.tipo === 'INFERIOR' && m.activa)
        .sort((a, b) => a.indice - b.indice)
        .map(m => ({ id: m.id, nombre: m.nombre }));
      mesas.push(...propias);
    }
    return mesas.length ? mesas : [{ id: null, nombre: 'Mesa' }];
  }

  /**
   * Columnas del modal: cada mesa inferior con sus bastidores. Un bastidor
   * va a la columna de la mesa donde se fabrica; si aun no ha pasado por
   * ninguna, a la primera. Los terminados se apilan al principio.
   */
  planModalColumnas(): PlanColumna[] {
    const secciones = this.planModalSecciones();
    const cache = this.planColumnasCache;
    if (cache && cache.secciones === secciones && cache.grupos === this.gruposMesas
        && cache.showDone === this.planModalShowDone) {
      return cache.value;
    }
    const mesas = this.planMesas();
    const columnas: PlanColumna[] = mesas.map(mesa => ({
      key: `m${mesa.id ?? 'x'}`, mesaId: mesa.id, nombre: mesa.nombre, secciones: [], terminados: 0,
    }));
    const porMesa = new Map(columnas.map(c => [c.mesaId, c]));
    for (const seccion of secciones) {
      const destino = porMesa.get(seccion.grupo?.mesa_actual ?? null) || columnas[0];
      if (seccion.terminado) {
        destino.terminados += 1;
        if (!this.planModalShowDone) continue;
      }
      destino.secciones.push(seccion);
    }
    for (const columna of columnas) {
      // Terminados al principio, en espera al final, el resto en su orden.
      const rango = (s: PlanSeccion) => (s.terminado ? 0 : s.grupo?.en_espera ? 2 : 1);
      columna.secciones.sort((a, b) => rango(a) - rango(b));
    }
    this.planColumnasCache = {
      secciones, grupos: this.gruposMesas, showDone: this.planModalShowDone, value: columnas,
    };
    return columnas;
  }

  /** Superior en mesa pasado el paso 2: se puede mover, pero se pregunta antes. */
  private supEmpezadaEnMesa(item: MesaQueueItem): boolean {
    return item.status === 'MOSTRANDO' && (item.current_image_index ?? 0) > 1;
  }

  /** La que está en mesa deja de proyectarse si se mueve o se le pone otra delante: se pregunta antes. */
  private confirmarMoverSup(item: MesaQueueItem, vecino: MesaQueueItem, dir: -1 | 1, mesaNombre: string): boolean {
    const enMesa = [item, vecino].find(i => this.supEmpezadaEnMesa(i));
    if (!enMesa || (enMesa === item ? dir !== 1 : dir !== -1)) return true;
    return confirm(`${enMesa.modulo_nombre} va por el paso ${(enMesa.current_image_index ?? 0) + 1} en ${mesaNombre}. `
      + 'Volverá a la cola y retomará en ese paso cuando le toque. ¿Seguro?');
  }

  /** Cola superior tal y como la enseña el card: lo no hecho, de todos los proyectos. */
  private colaSuperiorDeMesa(mesa: Mesa): MesaQueueItem[] {
    return (this.mesaQueueItems.get(mesa.id) || []).filter(i => i.status !== 'HECHO');
  }

  canMoverSupEnMesa(mesa: Mesa, item: MesaQueueItem, dir: -1 | 1): boolean {
    const lista = this.colaSuperiorDeMesa(mesa);
    const index = lista.indexOf(item);
    const target = index + dir;
    return index >= 0 && target >= 0 && target < lista.length;
  }

  /** Flechas del card de la mesa SUP en orden manual: el superior pasa delante o detrás de su vecino. */
  moverSupEnMesa(mesa: Mesa, item: MesaQueueItem, dir: -1 | 1): void {
    if (this.mesaReorderBusyId != null || !this.canMoverSupEnMesa(mesa, item, dir)) return;
    const todos = this.colaSuperiorDeMesa(mesa);
    const desde = todos.indexOf(item);
    if (!this.confirmarMoverSup(item, todos[desde + dir], dir, mesa.nombre)) return;
    todos.splice(desde + dir, 0, todos.splice(desde, 1)[0]);
    this.mesaReorderBusyId = mesa.id;
    this.cdr.detectChanges();
    this.api.reorderMesaQueue(todos.map((i, index) => ({ id: i.id, position: index })))
      .pipe(takeUntil(this.destroy$)).subscribe({
        next: () => {
          this.mesaReorderBusyId = null;
          this.loadMesaQueueItems(mesa.id);
          this.loadGruposMesas();
          this.cdr.detectChanges();
        },
        error: error => {
          this.mesaReorderBusyId = null;
          alert(error?.error?.detail || 'No se pudo cambiar el orden de la mesa superior.');
          this.cdr.detectChanges();
        },
      });
  }

  togglePlanModalDone(): void {
    this.planModalShowDone = !this.planModalShowDone;
    this.cdr.detectChanges();
  }

  private planColumnaDe(grupo: GrupoBastidor): number {
    const columnas = this.planModalColumnas();
    const index = columnas.findIndex(c => c.secciones.some(s => s.grupo?.id === grupo.id));
    return index >= 0 ? index : 0;
  }

  mesaVecina(grupo: GrupoBastidor, dir: -1 | 1): { id: number | null; nombre: string } | null {
    const columnas = this.planModalColumnas();
    const vecina = columnas[this.planColumnaDe(grupo) + dir];
    return vecina && vecina.mesaId !== null ? { id: vecina.mesaId, nombre: vecina.nombre } : null;
  }

  canMoverBastidorAMesa(grupo: GrupoBastidor, dir: -1 | 1): boolean {
    return this.mesaVecina(grupo, dir) !== null;
  }

  moverBastidorAMesa(grupo: GrupoBastidor, dir: -1 | 1): void {
    const vecina = this.mesaVecina(grupo, dir);
    if (!vecina || vecina.id === null) return;
    this.runPlanAction(this.api.llevarBastidorAMesa(grupo.id, vecina.id));
  }

  /** Orden real de fabricacion del bastidor: inverso al card del admin. */
  private fabricacionOrder(grupo: GrupoBastidor): GrupoBastidorModulo[] {
    return [...(grupo.modulos || [])].reverse();
  }

  private planRoots(): GrupoBastidor[] {
    return this.planModalGrupos.filter(g => !g.es_division);
  }

  /** Raices vecinas dentro de la misma mesa, en el orden en que se muestran. */
  private raicesEnSuMesa(grupo: GrupoBastidor): GrupoBastidor[] {
    const columna = this.planModalColumnas()[this.planColumnaDe(grupo)];
    return columna.secciones
      .map(s => s.grupo)
      .filter((g): g is GrupoBastidor => !!g && !g.es_division);
  }

  canMoveGrupo(grupo: GrupoBastidor, dir: -1 | 1): boolean {
    if (grupo.es_division) return false;
    const vecinas = this.raicesEnSuMesa(grupo);
    const index = vecinas.findIndex(g => g.id === grupo.id);
    const target = index + dir;
    return index >= 0 && target >= 0 && target < vecinas.length;
  }

  canDividir(grupo: GrupoBastidor): boolean {
    return !grupo.es_division && !grupo.dividido;
  }

  /** Aparta el bastidor de las mesas (p.ej. sin acero cortado) o lo suelta. */
  toggleEsperaEnPlan(grupo: GrupoBastidor): void {
    this.runPlanAction(this.api.esperaBastidor(grupo.id, !grupo.en_espera));
  }

  canUnir(grupo: GrupoBastidor): boolean {
    return !!(grupo.es_division || grupo.dividido);
  }

  /** Adelanta o retrasa el bastidor respecto a su vecino en la misma mesa. */
  moveGrupoEnPlan(grupo: GrupoBastidor, dir: -1 | 1): void {
    if (!this.planModalProyecto || !this.canMoveGrupo(grupo, dir)) return;
    const vecinas = this.raicesEnSuMesa(grupo);
    const vecino = vecinas[vecinas.findIndex(g => g.id === grupo.id) + dir];
    const ids = this.planRoots().map(g => g.id).filter(id => id !== grupo.id);
    const posVecino = ids.indexOf(vecino.id);
    ids.splice(dir < 0 ? posVecino : posVecino + 1, 0, grupo.id);
    this.runPlanAction(this.api.reorderBastidores(this.planModalProyecto.id, ids));
  }

  dividirGrupoEnPlan(grupo: GrupoBastidor): void {
    if (!this.canDividir(grupo)) return;
    this.runPlanAction(this.api.dividirBastidor(grupo.id));
  }

  unirGrupoEnPlan(grupo: GrupoBastidor): void {
    if (!this.canUnir(grupo)) return;
    this.runPlanAction(this.api.unirBastidor(grupo.id));
  }

  private runPlanAction(action: Observable<GrupoBastidor[]>): void {
    if (this.planModalBusy) return;
    this.planModalBusy = true;
    this.planModalError = '';
    this.cdr.detectChanges();
    action.pipe(takeUntil(this.destroy$)).subscribe({
      next: grupos => {
        this.planModalGrupos = grupos;
        this.planModalBusy = false;
        this.reloadPlanModalModulos();
        this.loadMesas();
        this.silentRefreshProyectosAndStats();
        this.cdr.detectChanges();
      },
      error: error => {
        this.planModalError = error?.error?.detail || 'No se pudo aplicar el cambio.';
        this.planModalBusy = false;
        this.cdr.detectChanges();
      },
    });
  }

  private reloadPlanModalGrupos(): void {
    const proyecto = this.planModalProyecto;
    if (!proyecto) return;
    this.api.getGruposBastidor(proyecto.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: grupos => {
        if (this.planModalProyecto?.id !== proyecto.id) return;
        this.planModalGrupos = grupos;
        this.cdr.detectChanges();
      },
      error: () => { /* sin bastidores se lista plano */ },
    });
  }

  private reloadPlanModalModulos(): void {
    const proyecto = this.planModalProyecto;
    if (!proyecto) return;
    this.api.getProyectoModulos(proyecto.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: modulos => {
        if (this.planModalProyecto?.id !== proyecto.id) return;
        this.planModalModulos = modulos;
        this.cdr.detectChanges();
      },
      error: () => { /* la lista anterior sigue siendo valida */ },
    });
  }

  phaseDone(module: Modulo, phase: ModuloFase): boolean {
    return phase === 'INFERIOR' ? module.inferior_hecho : module.superior_hecho;
  }

  phaseFinishedAt(module: Modulo, phase: ModuloFase): string | null {
    return (phase === 'INFERIOR' ? module.inferior_completado_at : module.superior_completado_at) || null;
  }

  /** Fase que se esta proyectando ahora mismo, segun lo que sabe el plan del bastidor. */
  phaseEnCurso(module: Modulo, phase: ModuloFase): boolean {
    const info = this.planModuloInfo(module.id);
    if (!info) return false;
    return !!(phase === 'INFERIOR' ? info.inferior_en_curso : info.superior_en_curso);
  }

  /** Solo se reinicia lo que ya tiene trabajo: una fase hecha o en curso. */
  phaseResettable(module: Modulo, phase: ModuloFase): boolean {
    return this.phaseDone(module, phase) || this.phaseEnCurso(module, phase);
  }

  phaseTitle(module: Modulo, phase: ModuloFase): string {
    const nombre = phase === 'INFERIOR' ? 'Inferior' : 'Superior';
    if (this.phaseDone(module, phase)) {
      const finished = this.phaseFinishedAt(module, phase);
      const cuando = finished ? formatDate(finished, 'dd/MM/yyyy HH:mm', 'en-US') : 'fecha no registrada';
      return `${nombre} terminada · ${cuando}. Clic para reiniciar`;
    }
    if (this.phaseEnCurso(module, phase)) return `${nombre} en curso. Clic para reiniciar`;
    return `${nombre} pendiente`;
  }

  private planModuloInfo(moduloId: number): GrupoBastidorModulo | undefined {
    for (const grupo of this.planModalGrupos) {
      const info = (grupo.modulos || []).find(m => m.id === moduloId);
      if (info) return info;
    }
    return undefined;
  }

  requestPhaseReset(module: Modulo, phase: ModuloFase): void {
    this.phaseResetTarget = {module, phase};
    this.phaseResetError = '';
  }

  cancelPhaseReset(): void {
    if (!this.resettingPhase) this.phaseResetTarget = null;
  }

  confirmPhaseReset(): void {
    const target = this.phaseResetTarget;
    if (!target || this.resettingPhase) return;
    this.resettingPhase = true;
    this.api.reiniciarFaseModulo(target.module.id, target.phase).pipe(takeUntil(this.destroy$)).subscribe({
      next: module => {
        this.planModalModulos = this.planModalModulos.map(m => m.id === module.id ? module : m);
        this.phaseResetTarget = null;
        this.resettingPhase = false;
        this.silentRefreshProyectosAndStats();
        this.loadMesas();
        this.reloadPlanModalGrupos();
        this.cdr.detectChanges();
      },
      error: error => {
        this.phaseResetError = error?.error?.detail || 'No se pudo reiniciar esta fase.';
        this.resettingPhase = false;
        this.cdr.detectChanges();
      },
    });
  }

  openPlanFotosModal(modulo: Modulo, event?: Event): void {
    event?.stopPropagation();
    if (!this.moduloHasFotos(modulo)) return;

    this.planFotosTarget = { id: modulo.id, nombre: modulo.nombre };
    this.planFotos = [];
    this.selectedPlanFotoIndex = 0;
    this.showPlanFotosModal = true;
    this.loadingPlanFotos = true;
    this.cdr.detectChanges();

    this.api.getFotos({ modulo: modulo.id })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (fotos) => {
          this.planFotos = fotos;
          this.loadingPlanFotos = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading fotos', err);
          this.loadingPlanFotos = false;
          this.cdr.detectChanges();
        }
      });
  }

  closePlanFotosModal(): void {
    this.showPlanFotosModal = false;
    this.planFotosTarget = null;
    this.planFotos = [];
    this.loadingPlanFotos = false;
    this.selectedPlanFotoIndex = 0;
    this.downloadingPlanFotosZip = false;
  }

  prevPlanFoto(): void {
    if (this.selectedPlanFotoIndex > 0) this.selectedPlanFotoIndex--;
  }

  nextPlanFoto(): void {
    if (this.selectedPlanFotoIndex < this.planFotos.length - 1) this.selectedPlanFotoIndex++;
  }

  getPlanFotoUrl(foto: FotoFabricacion): string {
    return this.resolveUrl(foto.url);
  }

  moduloHasFotos(modulo: Modulo): boolean {
    return (modulo.fotos_count || 0) > 0;
  }

  planModalFotosTotal(): number {
    return this.planModalModulos.reduce((total, modulo) => total + (modulo.fotos_count || 0), 0);
  }

  downloadPlanFotosZip(scope: 'modulo' | 'proyecto', modulo?: Modulo, event?: Event): void {
    event?.stopPropagation();
    const params: { modulo?: number; proyecto?: number } = {};
    let targetName = 'fotos';

    if (scope === 'modulo') {
      if (modulo) {
        if (!this.moduloHasFotos(modulo)) return;
        params.modulo = modulo.id;
        targetName = modulo.nombre || 'modulo';
      } else {
        if (!this.planFotosTarget || this.planFotos.length === 0) return;
        params.modulo = this.planFotosTarget.id;
        targetName = this.planFotosTarget.nombre || 'modulo';
      }
    } else {
      if (!this.planModalProyecto || this.planModalFotosTotal() === 0) return;
      params.proyecto = this.planModalProyecto.id;
      targetName = this.planModalProyecto.nombre || 'proyecto';
    }

    // Preparar el ZIP tarda: el boton y el modal lo dicen enseguida.
    this.downloadingPlanFotosZip = true;
    this.cdr.detectChanges();
    this.api.downloadFotosZip(params)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (blob) => {
          this.triggerZipDownload(blob, `fotos_${targetName}.zip`);
          this.downloadingPlanFotosZip = false;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error downloading ZIP', err);
          this.downloadingPlanFotosZip = false;
          alert('Error descargando fotos');
          this.cdr.detectChanges();
        }
      });
  }

  private triggerZipDownload(blob: Blob, filename: string): void {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
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

  planModalDoneCount(): number {
    return this.planModalModulos.filter(m => m.inferior_hecho && m.superior_hecho).length;
  }

  openElementosModal(proyecto: Proyecto, event?: Event): void {
    event?.stopPropagation();
    if (!proyecto.elementos_sueltos_disponible) return;
    const request = ++this.elementosModalRequest;
    this.elementosModalProyecto = proyecto;
    this.elementosModalData = null;
    this.elementosModalError = '';
    this.elementosModalHoja = 0;
    this.elementosModalLoading = true;
    this.cdr.detectChanges();
    this.api.getElementosSueltos(proyecto.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: data => {
        if (request !== this.elementosModalRequest) return;
        this.elementosModalData = data;
        this.elementosModalLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        if (request !== this.elementosModalRequest) return;
        this.elementosModalError = 'No se ha podido cargar el Excel. Puedes descargarlo para abrirlo.';
        this.elementosModalLoading = false;
        this.cdr.detectChanges();
      },
    });
  }

  closeElementosModal(): void {
    this.elementosModalRequest++;
    this.elementosModalProyecto = null;
    this.elementosModalData = null;
    this.elementosModalError = '';
    this.elementosModalLoading = false;
  }

  elementosHojaActual(): ElementosSueltosHoja | null {
    return this.elementosModalData?.hojas[this.elementosModalHoja] ?? null;
  }

  /** Enlace de descarga del despiece (mismo origen: viaja la cookie de /media/). */
  elementosDescargaUrl(): string {
    const proyecto = this.elementosModalProyecto;
    const url = this.elementosModalData?.url || proyecto?.despiece_archivo || proyecto?.elementos_sueltos_archivo || '';
    return url ? this.resolveUrl(url) : '';
  }

  elementosCeldaNumerica(valor: ElementosSueltosCelda): boolean {
    return typeof valor === 'number';
  }

  /** Columna con solo numeros en sus filas: cabecera y celdas alineadas a la derecha. */
  elementosColumnaNumerica(seccion: ElementosSueltosSeccion, indice: number): boolean {
    const valores = seccion.filas.map(fila => fila[indice]).filter(valor => valor !== null && valor !== undefined);
    return valores.length > 0 && valores.every(valor => typeof valor === 'number');
  }

  elementosMomentoLabel(momento: ElementosSueltosSeccion['momento']): string {
    return momento === 'antes' ? 'Antes de los módulos' : momento === 'despues' ? 'Después de los módulos' : '';
  }

  openProjectDocument(proyecto: Proyecto, type: 'plano' | 'despiece', event?: Event): void {
    event?.stopPropagation();
    const url = type === 'plano' ? proyecto.plano_archivo : proyecto.despiece_archivo;
    if (!url) return;
    window.open(this.resolveUrl(url), '_blank', 'noopener');
  }

  moduloEstadoLabel(m: Modulo): 'Fabricado' | 'En proceso' | 'Pendiente' {
    const state = this.moduloEstadoOperativo(m);
    if (state === 'COMPLETADO' || state === 'CERRADO') return 'Fabricado';
    if (state === 'EN_PROGRESO') return 'En proceso';
    return 'Pendiente';
  }

  moduloEstadoClass(m: Modulo): 'done' | 'partial' | 'pending' {
    const state = this.moduloEstadoOperativo(m);
    if (state === 'COMPLETADO' || state === 'CERRADO') return 'done';
    if (state === 'EN_PROGRESO') return 'partial';
    return 'pending';
  }

  private moduloEstadoOperativo(m: Modulo): Modulo['estado'] {
    if (m.estado_operativo) return m.estado_operativo;
    if (m.inferior_hecho && m.superior_hecho) return 'COMPLETADO';
    if (m.inferior_hecho || m.superior_hecho) return 'EN_PROGRESO';
    return m.estado || 'PENDIENTE';
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
    this.cdr.detectChanges();
  }

  /** Alias retrocompat para callsites que ya esperan 'close' del modal. */
  closeGestionarModal(): void {
    this.intentarCerrarGestionarModal();
  }

  /** La cola de proyectos del grupo: en mesa y en espera, en su propio modal. */
  openColaModal(grupo: GrupoMesas): void {
    this.gestionandoGrupo = grupo;
    this.showColaModal = true;
    this.cdr.detectChanges();
  }

  closeColaModal(): void {
    this.showColaModal = false;
    this.gestionandoGrupo = null;
    this.cdr.detectChanges();
  }

  // ---- Proyectos nuevos: esperan en notificaciones hasta que se aceptan ----

  openNotificaciones(): void {
    this.showNotificacionesModal = true;
    this.cdr.detectChanges();
  }

  closeNotificaciones(): void {
    this.showNotificacionesModal = false;
    this.cdr.detectChanges();
  }

  /** Aceptar un proyecto nuevo: pasa a la lista y ya se puede poner en mesa. */
  aceptarProyecto(proyecto: Proyecto): void {
    if (this.aceptandoProyectoId != null) return;
    this.aceptandoProyectoId = proyecto.id;
    this.cdr.detectChanges();
    this.api.aceptarProyecto(proyecto.id)
      .pipe(takeUntil(this.destroy$)).subscribe({
        next: () => {
          this.aceptandoProyectoId = null;
          this.proyectosPendientes = this.proyectosPendientes.filter(p => p.id !== proyecto.id);
          if (this.proyectosPendientes.length === 0) this.showNotificacionesModal = false;
          this.loadProyectos();
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.aceptandoProyectoId = null;
          alert(err?.error?.detail || 'No se pudo aceptar el proyecto.');
          this.cdr.detectChanges();
        },
      });
  }

  /** La fecha de montaje en obra es de la ferralla: se edita en el card y sin ella el proyecto no entra en mesa. */
  guardarFechaMontajeObra(proyecto: Proyecto, event: Event): void {
    const input = event.target as HTMLInputElement;
    const valor = input.value || null;
    if (valor === (proyecto.fecha_montaje_obra || null)) {
      // Nada que guardar: vuelve a enseñar la suya o la orientativa.
      input.value = proyecto.fecha_montaje_obra || proyecto.fecha_montaje || '';
      return;
    }
    this.guardarFechaObra(proyecto, valor, input);
  }

  /** La orientativa de ingenieria es la buena: se confirma con un clic. */
  confirmarFechaOrientativa(proyecto: Proyecto): void {
    if (!proyecto.fecha_montaje || proyecto.fecha_montaje_obra) return;
    this.guardarFechaObra(proyecto, proyecto.fecha_montaje);
  }

  private guardarFechaObra(proyecto: Proyecto, valor: string | null, input?: HTMLInputElement): void {
    this.fechaObraGuardandoId = proyecto.id;
    this.cdr.detectChanges();
    this.api.updateProyecto(proyecto.id, { fecha_montaje_obra: valor })
      .pipe(takeUntil(this.destroy$)).subscribe({
        next: (actualizado) => {
          proyecto.fecha_montaje_obra = actualizado.fecha_montaje_obra ?? valor;
          proyecto.fecha_montaje_obra_anterior = actualizado.fecha_montaje_obra_anterior ?? null;
          proyecto.fecha_montaje_obra_cambiada_at = actualizado.fecha_montaje_obra_cambiada_at ?? null;
          this.fechaObraGuardandoId = null;
          this.cdr.detectChanges();
        },
        error: (err) => {
          if (input) input.value = proyecto.fecha_montaje_obra || proyecto.fecha_montaje || '';
          this.fechaObraGuardandoId = null;
          alert(err?.error?.detail || err?.error?.fecha_montaje_obra?.[0] || 'No se pudo guardar la fecha de montaje en obra.');
          this.cdr.detectChanges();
        },
      });
  }

  /** Proyectos que se pueden añadir a la cola de este grupo: los que no
   * están ya en ella, aún tienen módulos pendientes, Moden ha validado y
   * la ferralla les ha puesto fecha de montaje en obra (sin ella no entran).
   * Los que tienen validaciones previas sin completar (geometría,
   * equivalencias...) no se ofrecen ni se mencionan: la ferralla no los
   * ve hasta que Moden los libera. Los proyectos sin pendientes los
   * expulsa _plan_cola en el backend al replanificar. */
  /** Proyectos de la ferralla que no estan en mesa y aun tienen trabajo, por
   *  fecha de montaje en obra (los que no la tienen, al final). */
  proyectosEnEspera(grupo: GrupoMesas | null): Proyecto[] {
    const enCola = new Set(grupo?.proyectos_cola.map(e => e.proyecto) ?? []);
    return this.proyectos
      .filter(p => {
        if (enCola.has(p.id) || p.archivado_at) return false;
        const total = p.modulos_count ?? 0;
        const done = p.modulos_completados ?? 0;
        // Sin total: lo mostramos (todavia no se han creado modulos).
        // Con total: solo si quedan pendientes.
        return total === 0 || done < total;
      })
      .sort((a, b) => (a.fecha_montaje_obra || a.fecha_montaje || '9999').localeCompare(b.fecha_montaje_obra || b.fecha_montaje || '9999')
        || a.nombre.localeCompare(b.nombre));
  }

  /** Por que un proyecto en espera no puede subir a mesa ('' si puede). */
  motivoNoSubeAMesa(p: Proyecto): string {
    if (p.produccion_bloqueada) return 'Faltan validaciones de Moden antes de fabricarlo';
    if (!p.fecha_montaje_obra && p.fecha_montaje) return 'Confirma su fecha de montaje en obra (la orientativa o la vuestra) para subirlo a mesa';
    if (!p.fecha_montaje_obra) return 'Ponle fecha de montaje en obra para subirlo a mesa';
    return '';
  }

  /** "monta 12/11" con la fecha de montaje en obra del proyecto. */
  montajeColaLabel(proyectoId: number): string {
    const proyecto = this.proyectos.find(p => p.id === proyectoId);
    const fecha = proyecto?.fecha_montaje_obra || proyecto?.fecha_montaje;
    if (!fecha) return '';
    const [, mes, dia] = fecha.split('-');
    return `${proyecto?.fecha_montaje_obra ? 'monta' : 'orientativa'} ${dia}/${mes}`;
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

  /** Cambia el orden de la cola superior del grupo desde el card de su mesa SUP. */
  setEstrategiaColaSuperior(grupo: GrupoMesas, estrategia: EstrategiaColaSuperior): void {
    if (this.estrategiaBusyGrupoId != null) return;
    const anterior = grupo.estrategia_cola_superior || 'PLANIFICADA';
    if (anterior === estrategia) return;

    grupo.estrategia_cola_superior = estrategia;
    this.estrategiaBusyGrupoId = grupo.id;
    this.cdr.detectChanges();

    this.api.updateGrupoMesas(grupo.id, { estrategia_cola_superior: estrategia })
      .pipe(takeUntil(this.destroy$)).subscribe({
        next: (updated) => {
          this.applyGestionarGrupoUpdate(updated);
          this.loadMesas();
          this.estrategiaBusyGrupoId = null;
          this.cdr.detectChanges();
        },
        error: (err) => {
          grupo.estrategia_cola_superior = anterior;
          this.estrategiaBusyGrupoId = null;
          alert(err?.error?.detail || 'No se pudo cambiar el orden de superiores.');
          this.cdr.detectChanges();
        },
      });
  }


  /** Flecha de la lista de espera: el servidor lo coloca en mesa por su fecha de montaje en obra. */
  subirAMesa(proyecto: Proyecto): void {
    if (!this.gestionandoGrupo || this.gestionarBusy || this.motivoNoSubeAMesa(proyecto)) return;
    const grupo = this.gestionandoGrupo;
    this.gestionarBusy = true;
    this.api.colaGrupoMesasAdd(grupo.id, proyecto.id).subscribe({
      next: (updated) => {
        this.applyGestionarGrupoUpdate(updated);
        this.loadMesas();
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
        // El backend borro items del proyecto en las mesas y replano
        // los restantes: refrescamos colas para que los cards reflejen
        // el nuevo estado inmediatamente.
        this.loadMesas();
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
        // El backend reordeno la cola y replanifico las mesas, asi que
        // las colas internas de cada mesa cambiaron. Recargamos para
        // que los cards reflejen el nuevo orden inmediatamente.
        this.loadMesas();
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
      grupo.estrategia_cola_superior = updated.estrategia_cola_superior;
    }
    if (this.gestionandoGrupo?.id === updated.id) {
      this.gestionandoGrupo = grupo || updated;
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

  irA(vista: DashboardVista): void {
    if (vista === this.vista) return;
    this.router.navigate([vista === 'produccion' ? '/dashboard' : `/dashboard/${vista}`]);
  }

  scrollToSection(sectionId: string): void {
    const section = document.getElementById(sectionId) as HTMLElement | null;
    if (!section) return;

    const container = this.getScrollContainer(section);
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      const targetTop = sectionRect.top - containerRect.top + container.scrollTop - 16;
      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      return;
    }

    const targetTop = section.getBoundingClientRect().top + window.scrollY - 16;
    window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }

  private getScrollContainer(element: HTMLElement): HTMLElement | null {
    let current = element.parentElement;
    while (current) {
      const { overflowY } = window.getComputedStyle(current);
      const canScroll = /(auto|scroll)/.test(overflowY);
      if (canScroll && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  ngOnInit(): void {
    // Check auth
    if (!this.api.isLoggedIn()) {
      this.router.navigate(['/']);
      return;
    }

    this.username = this.api.getUsername() || 'Usuario';
    this.vista = this.router.url.includes('/dashboard/estadisticas') ? 'estadisticas'
      : this.router.url.includes('/dashboard/planificacion') ? 'planificacion' : 'produccion';

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
        // Las colas solo se ven en Produccion (y el player avanza solo).
        if (this.vista !== 'produccion') return;
        this.pollMesasQueue();
        this.refreshActiveProjectModules();
      });

    // Slower loop (20s) to refresh project counters + production stats
    // so donut and stats boards follow admin actions without a reload.
    interval(20000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.silentRefreshProyectosAndStats();
        this.refreshMesasHealth();
      });
  }

  logout(): void {
    this.api.logout();
    this.router.navigate(['/']);
  }

  // Polling function to refresh queues and check for auto-advance
  pollMesasQueue(): void {
    // Skip polling during cross-mesa transfers to avoid DOM conflicts
    if (this.mesas.length === 0 || this.transferInProgress || this.colasEnVuelo) return;

    // One request for every mesa instead of one per mesa. The backend also
    // promotes the first EN_COLA item of any idle mesa before answering, so
    // the auto-advance below only fires if that somehow did not happen.
    const mesaIds = this.mesas.map(mesa => mesa.id);
    this.colasEnVuelo = true;
    this.api.getMesasQueues(mesaIds)
      .pipe(takeUntil(this.destroy$), finalize(() => this.colasEnVuelo = false))
      .subscribe({
        next: (queues) => {
          this.mesas.forEach(mesa => {
            const items = queues[String(mesa.id)];
            if (items) this.applyPolledQueue(mesa, items);
          });
          this.cdr.detectChanges();
        },
        error: (err) => mesaIds.forEach(id => this.logQueueError(id, 'polling', err))
      });
  }

  private applyPolledQueue(mesa: Mesa, items: MesaQueueItem[]): void {
    // 1. Filter active items (API might return HECHO depending on implementation, but typically filtered)
    // FORCE SORT: MOSTRANDO always first
    const activeItems = items
      .filter(i => i.status !== 'HECHO')
      .sort((a, b) => {
        if (a.status === 'MOSTRANDO') return -1;
        if (b.status === 'MOSTRANDO') return 1;
        return a.position - b.position;
      });

    // 2. Update the map
    this.mesaQueueItems.set(mesa.id, activeItems);

    // 3. Clear STALE assignments for this mesa: anything in
    // `subfaseAssignedToMesa` pointing at this mesa that is no longer in the
    // list finished or was deleted. This fixes the "Proyectando..." stuck status.
    for (let [key, val] of this.subfaseAssignedToMesa) {
      if (val.mesaName === mesa.nombre) {
        // Key format: "moduloId-FASE"
        const stillExists = items.some(i => `${i.modulo}-${i.fase}` === key && i.status !== 'HECHO');
        if (!stillExists) {
          this.subfaseAssignedToMesa.delete(key);
        }
      }
    }

    // 4. Auto-advance fallback (the server normally did this already)
    if (activeItems.length > 0) {
      const firstItem = activeItems[0];
      if (firstItem.status === 'EN_COLA') {
        console.log(`[Dashboard] Auto-Advancing Mesa ${mesa.nombre} -> Showing ${firstItem.modulo_nombre}`);
        this.mostrarItem(firstItem);
      }
    }

    // 5. Update assignment tracking (for dots) with NEW items
    this.updateAssignmentTracking(mesa, items);
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
        next: (all) => {
          // Los archivados ya no se fabrican: fuera del dashboard de la ferralla.
          const vivos = all.filter(p => !p.archivado_at);
          // Los nuevos esperan en notificaciones hasta que la ferralla los acepta.
          this.proyectosPendientes = vivos.filter(p => !p.aceptado_por_ferralla_at);
          const data = vivos.filter(p => !!p.aceptado_por_ferralla_at);
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
        next: (all) => {
          // Los archivados ya no se fabrican: fuera del dashboard de la ferralla.
          const vivos = all.filter(p => !p.archivado_at);
          // Los nuevos esperan en notificaciones hasta que la ferralla los acepta.
          this.proyectosPendientes = vivos.filter(p => !p.aceptado_por_ferralla_at);
          const data = vivos.filter(p => !!p.aceptado_por_ferralla_at);
          this.proyectos = data;
          if (this.selectedProyecto) {
            const updated = data.find(p => p.id === this.selectedProyecto?.id);
            if (updated) this.selectedProyecto = updated;
          }
          this.cdr.detectChanges();
        }
      });
    // Las estadisticas se refrescan en silencio solo si se estan viendo y el
    // periodo llega a hoy (lo pasado no cambia): cada peticion de un rango
    // largo cuesta segundos al servidor.
    if (this.vista === 'estadisticas' && (!this.statsTo || this.statsTo >= this.toLocalIsoDate(new Date()))) {
      this.loadStats(true);
    }
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

  private refreshMesasHealth(): void {
    this.api.getMesas()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (freshMesas) => {
          const freshById = new Map(freshMesas.map(mesa => [mesa.id, mesa]));
          this.mesas = this.mesas.map((mesa) => {
            const fresh = freshById.get(mesa.id);
            if (!fresh) return mesa;
            return {
              ...mesa,
              is_linked: fresh.is_linked,
              last_seen: fresh.last_seen,
              capture_service_online: fresh.capture_service_online,
              camera_sharpness: fresh.camera_sharpness,
            };
          });
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.warn('[Dashboard] No se pudo refrescar la salud de las mesas.', err);
        },
      });
  }

  isMesaCameraUnavailable(mesa: Mesa): boolean {
    return mesa.is_linked && mesa.capture_service_online === false;
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
          this.loadHorario();
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error loading grupos de mesas', err);
          this.loadingGruposMesas = false;
        }
      });
  }

  // ---- Horario de trabajo ------------------------------------------------

  private get horarioUserId(): number | null {
    return this.gruposMesas[0]?.usuario ?? null;
  }

  loadHorario(): void {
    const userId = this.horarioUserId;
    if (!userId) return;
    this.api.getFerrallaCaptureConfig(userId).pipe(takeUntil(this.destroy$)).subscribe({
      next: config => { this.horario = config; this.cdr.detectChanges(); },
      error: () => { /* sin horario no hay editor, las estadisticas siguen */ },
    });
  }

  /** "Mañana Lun–Vie 06:00–16:00 · Noche Lun–Jue, Dom 19:00–05:00". */
  horarioLabel(): string {
    return this.horario ? turnosLabel(this.horario.turnos) : '';
  }

  editHorario(): void {
    if (!this.horario) return;
    this.turnosDraft = copiarTurnos(this.horario.turnos);
    this.horarioError = '';
    this.horarioEditing = true;
    this.cdr.detectChanges();
  }

  cancelHorario(): void {
    if (this.savingHorario) return;
    this.horarioEditing = false;
    this.cdr.detectChanges();
  }

  saveHorario(): void {
    const userId = this.horarioUserId;
    if (!this.horario || !userId || this.savingHorario) return;
    const error = turnosError(this.turnosDraft);
    if (error) {
      this.horarioError = error;
      this.cdr.detectChanges();
      return;
    }
    this.savingHorario = true;
    this.horarioError = '';
    this.api.updateFerrallaCaptureConfig(userId, {
      turnos: copiarTurnos(this.turnosDraft),
      interval_seconds: this.horario.interval_seconds,
      rotations: [],
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: config => {
        this.horario = config;
        this.horarioEditing = false;
        this.savingHorario = false;
        // Las estadisticas cuentan horas de jornada: recalcular con el horario nuevo.
        this.loadStats();
        this.silentRefreshProyectosAndStats();
        this.cdr.detectChanges();
      },
      error: error => {
        this.horarioError = error?.error?.detail || 'No se pudo guardar el horario.';
        this.savingHorario = false;
        this.cdr.detectChanges();
      },
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

  // =========================================================================
  // PROJECT SELECTION
  // =========================================================================
  selectProyecto(proyecto: Proyecto): void {
    this.selectedProyecto = proyecto;
    this.selectedModulo = null;
    this.loadModulosForProyecto(proyecto.id);
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
    // Un refresco nunca se apila sobre una peticion que no ha vuelto: si el
    // servidor tarda mas que el intervalo, se amontonaban hasta colgarlo.
    if (silent && (this.loadingStats || this.statsEnVuelo > 0)) return;
    const requestId = ++this.statsRequestId;
    if (!this.statsFrom || !this.statsTo) {
      // Defaults: today → today
      const today = this.toLocalIsoDate(new Date());
      this.statsFrom = today;
      this.statsTo = today;
    }
    if (!silent || !this.statsData) this.loadingStats = true;
    if (!silent) this.statsData = null;
    this.statsError = '';
    this.statsEnVuelo++;
    const todoElProyecto = this.statsPreset === 'proyecto' && (this.statsProyecto !== null || this.statsEdificio !== null);
    this.api.getProductionStats({
      from: this.statsFrom,
      to: this.statsTo,
      proyecto: this.statsProyecto ?? undefined,
      rango: todoElProyecto ? (this.statsEdificio !== null ? 'edificio' : 'proyecto') : undefined,
      ...(this.statsEdificio !== null ? { edificio: this.statsEdificio } : {}),
      ...(this.statsTurno !== null ? { turno: this.statsTurno } : {}),
    })
      .pipe(takeUntil(this.destroy$), finalize(() => this.statsEnVuelo--))
      .subscribe({
        next: (res) => {
          if (requestId !== this.statsRequestId) return;
          if (todoElProyecto && res.range) {
            // El servidor fija el rango: del primer modulo terminado a hoy.
            this.statsFrom = res.range.from;
            this.statsTo = res.range.to;
          }
          this.statsData = res;
          this.statsTurnos = res.turnos || [];
          this.loadingStats = false;
          this.cdr.detectChanges();
        },
        error: () => {
          if (requestId !== this.statsRequestId) return;
          this.loadingStats = false;
          this.statsError = this.statsData
            ? 'No se han podido actualizar las estadísticas. Se muestran los últimos datos disponibles.'
            : 'No se han podido cargar las estadísticas. Inténtalo de nuevo.';
          this.cdr.detectChanges();
        }
      });
  }

  statsPlanningIssues(): number {
    const unknown = this.statsData?.esperado.proyectos_sin_objetivo;
    if (unknown !== undefined) return unknown;
    const planning = this.statsData?.planificacion;
    return planning
      ? planning.sin_planificar + planning.urgentes
      : planningIssues(this.proyectos);
  }

  statsPeriodTarget(): number | null {
    return this.statsData?.esperado.modulos_esperados ?? null;
  }

  /** Proyectos agrupados por edificio, de abajo arriba (tarjetas y selector). */
  gruposEdificio(): GrupoEdificio[] {
    return agruparPorEdificio(this.proyectos);
  }

  hayEdificios(): boolean {
    return this.proyectos.some(proyecto => proyecto.edificio != null);
  }

  edificioModulos(grupo: GrupoEdificio): { hechos: number; total: number } {
    return grupo.proyectos.reduce((acc, p) => ({
      hechos: acc.hechos + (p.modulos_completados || 0),
      total: acc.total + Math.max(p.modulos_count || 0, p.modulos_previstos || 0),
    }), { hechos: 0, total: 0 });
  }

  /** Valor del selector: todos, un proyecto (p:id) o un edificio entero (e:id). */
  statsAlcance(): string {
    if (this.statsEdificio !== null) return `e:${this.statsEdificio}`;
    return this.statsProyecto !== null ? `p:${this.statsProyecto}` : 'todos';
  }

  selectStatsAlcance(valor: string): void {
    const [tipo, id] = (valor || '').split(':');
    if (tipo === 'e' && id) {
      this.statsProyecto = null;
      this.statsEdificio = Number(id);
      this.selectStatsPreset('proyecto');
      return;
    }
    this.selectStatsProyecto(tipo === 'p' && id ? Number(id) : null);
  }

  /** Limita las estadisticas a un turno (null = todos). */
  selectStatsTurno(valor: string): void {
    this.statsTurno = valor === '' || valor === null || valor === undefined ? null : Number(valor);
    this.loadStats();
  }

  /** Limita las estadisticas a un proyecto (null = todos). Al elegir uno se ve entero. */
  selectStatsProyecto(proyectoId: number | null): void {
    this.statsEdificio = null;
    this.statsProyecto = proyectoId;
    if (proyectoId === null) {
      this.selectStatsPreset(this.statsPreset === 'proyecto' ? 'month' : this.statsPreset);
      return;
    }
    this.selectStatsPreset('proyecto');
  }

  selectStatsPreset(preset: 'day' | 'week' | 'month' | 'proyecto' | 'custom'): void {
    const today = new Date();
    if (preset === 'proyecto' && this.statsProyecto === null && this.statsEdificio === null) preset = 'month';
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

  /** Dia, semana o mes anterior o siguiente (con fechas a mano, tantos dias como el rango). */
  moverPeriodo(delta: -1 | 1): void {
    const periodo = this.puedeMoverPeriodo(delta) ? this.periodoDesplazado(delta) : null;
    if (!periodo) return;
    this.statsFrom = periodo.from;
    this.statsTo = periodo.to;
    this.loadStats();
  }

  /** No hay periodo siguiente al de hoy, ni anterior a "desde el inicio". */
  puedeMoverPeriodo(delta: -1 | 1): boolean {
    const periodo = this.periodoDesplazado(delta);
    return !!periodo && periodo.from <= this.toLocalIsoDate(new Date());
  }

  private periodoDesplazado(delta: -1 | 1): { from: string; to: string } | null {
    const from = this.parseIsoDate(this.statsFrom);
    const to = this.parseIsoDate(this.statsTo);
    if (!from || !to) return null;
    const masDias = (d: Date, dias: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dias);
    let desde: Date;
    let hasta: Date;
    switch (this.statsPreset) {
      case 'day':
        desde = masDias(from, delta);
        hasta = desde;
        break;
      case 'week':
        desde = masDias(this.getMondayOfWeek(from), 7 * delta);
        hasta = masDias(desde, 6);
        break;
      case 'month':
        desde = new Date(from.getFullYear(), from.getMonth() + delta, 1);
        hasta = new Date(desde.getFullYear(), desde.getMonth() + 1, 0);
        break;
      case 'custom': {
        const dias = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
        desde = masDias(from, dias * delta);
        hasta = masDias(to, dias * delta);
        break;
      }
      default:
        return null;
    }
    // El periodo en curso llega hasta hoy.
    const hoy = this.toLocalIsoDate(new Date());
    const hastaIso = this.toLocalIsoDate(hasta);
    return { from: this.toLocalIsoDate(desde), to: hastaIso > hoy ? hoy : hastaIso };
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

  /** Minutos por panel (mediana) o guion si no hay paneles en el rango. */
  tiempoLabel(tiempo: TiempoFabricacion | undefined | null): string {
    if (!tiempo || tiempo.mediana_min === null || tiempo.mediana_min === undefined) return '—';
    return String(Math.round(tiempo.mediana_min));
  }

  tiempoDetalle(tiempo: TiempoFabricacion | undefined | null): string {
    if (!tiempo || !tiempo.paneles) return 'sin paneles';
    const base = `mediana de ${tiempo.paneles} ${tiempo.paneles === 1 ? 'panel' : 'paneles'}`;
    if (tiempo.medidos >= tiempo.paneles) return base + ' medidos';
    if (tiempo.medidos === 0) return base + ', aproximado';
    return `${base}, ${tiempo.medidos} medidos`;
  }

  /** Nota al pie mientras el rango mezcle paneles aproximados y medidos. */
  tiempoNota(): string {
    const t = this.statsData?.tiempos;
    if (!t) return '';
    const paneles = t.inferior.paneles + t.superior.paneles;
    const medidos = t.inferior.medidos + t.superior.medidos;
    if (!paneles || medidos >= paneles) return '';
    return 'Tiempo por panel: minutos de jornada entre un panel hecho y el anterior en la misma mesa '
      + '(o desde el inicio de jornada). Los paneles fabricados desde ahora se miden con el tiempo real en pantalla.';
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
  // STATS BUCKETS (por hora en un dia, por dia hasta 45 dias, por semana mas alla)
  // =========================================================================

  /**
   * Parte el rango elegido en columnas para las graficas y la tabla por periodo.
   * Cada columna lleva su objetivo: el del periodo repartido entre sus dias
   * laborables, asi la linea de meta suma lo mismo que el "/ objetivo" del
   * indicador de modulos.
   */
  statsBuckets(): StatsBucket[] {
    const data = this.statsData;
    if (!data || !this.statsFrom || !this.statsTo) return [];
    const from = this.parseIsoDate(this.statsFrom);
    const to = this.parseIsoDate(this.statsTo);
    if (!from || !to || from > to) return [];

    const dayCount = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    const byDate = new Map(data.por_dia.map(d => [d.fecha, d]));
    const now = new Date();
    const todayIso = this.toLocalIsoDate(now);
    const objetivo = this.objetivoPorDia();
    // Desperdicio sobre el peso total fabricado de la columna.
    const pct = (waste: number, total: number): number | null => total > 0 ? (waste / total) * 100 : null;
    // Trabajo y tiempo muerto: por dia vienen en horas; por hora, en minutos.
    const aHoras = (h: number | undefined, min: number | undefined): number | null =>
      typeof h === 'number' ? h : typeof min === 'number' ? min / 60 : null;
    const base = (found: StatsFuente | undefined) => ({
      modulos_completados: found?.modulos_completados || 0,
      fases_completadas: found?.fases_completadas || 0,
      peso_total_kg: this.pesoTotal(found),
      peso_malla_inicial_kg: found?.peso_malla_inicial_kg || 0,
      peso_malla_final_kg: found?.peso_malla_final_kg || 0,
      desperdicio_kg: found?.desperdicio_kg || 0,
      desperdicio_pct: pct(found?.desperdicio_kg || 0, this.pesoTotal(found)),
      dificultad_total: found?.dificultad_total || 0,
      tiempo_inferior_min: found?.tiempo_inferior_min ?? null,
      tiempo_superior_min: found?.tiempo_superior_min ?? null,
      horas_turno: aHoras(found?.horas_turno, found?.minutos_turno),
      horas_trabajo: aHoras(found?.horas_trabajo, found?.minutos_trabajo),
      horas_muertas: aHoras(found?.horas_muertas, found?.minutos_muertos),
      horas_fuera_turno: found?.horas_fuera_turno ?? null,
      sin_registro: !!found?.sin_registro,
      estimado: !!found?.estimado,
      abre: found?.abre ?? null,
      cierra: found?.cierra ?? null,
    });

    // Un dia con un turno elegido: ese turno entero (la noche empieza el dia
    // anterior), de una hora antes a la hora en que acaba.
    if (dayCount === 1 && data.por_hora && data.range.eje?.length) {
      const byHour = new Map(data.por_hora.map(h => [h.hora, h]));
      const horasTurno = data.range.horas || [];
      const metaDia = objetivo.get(this.statsFrom) ?? 0;
      const hourlyCap = metaDia > 0 && horasTurno.length ? metaDia / horasTurno.length : 0;
      return data.range.eje.map(({ hora, inicio }) => {
        const desde = new Date(inicio);
        const hasta = new Date(desde.getTime() + 3600000);
        return {
          key: hora,
          label: `${hora}h`,
          ...base(byHour.get(hora)),
          meta_modulos: horasTurno.includes(hora) ? hourlyCap : 0,
          working_days: 0,
          granularity: 'hour' as const,
          futuro: desde > now,
          en_curso: desde <= now && now < hasta,
        };
      });
    }

    // Un dia (de 00:00 a 24:00): una columna por hora, de la primera a la
    // ultima de sus turnos o con actividad, para que la linea sea continua.
    if (dayCount === 1 && data.por_hora) {
      const byHour = new Map(data.por_hora.map(h => [Number(h.hora), h]));
      const horasTurno = (data.range.horas || []).map(Number);
      const horas = [...horasTurno, ...byHour.keys()];
      if (!horas.length) return [];
      const metaDia = objetivo.get(this.statsFrom) ?? 0;
      const hourlyCap = metaDia > 0 ? metaDia / (horasTurno.length || 8) : 0;
      const isToday = this.statsFrom === todayIso;
      const buckets: StatsBucket[] = [];
      for (let h = Math.min(...horas); h <= Math.max(...horas); h++) {
        const hh = String(h).padStart(2, '0');
        buckets.push({
          key: hh,
          label: `${hh}h`,
          ...base(byHour.get(h)),
          // Entre turnos no hay objetivo.
          meta_modulos: !horasTurno.length || horasTurno.includes(h) ? hourlyCap : 0,
          working_days: 0,
          granularity: 'hour',
          futuro: this.statsFrom > todayIso || (isToday && h > now.getHours()),
          en_curso: isToday && h === now.getHours(),
        });
      }
      return buckets;
    }

    if (dayCount <= 45) {
      // Por dia hasta mes y medio (una linea lo aguanta bien): sin fines de
      // semana, salvo que se haya trabajado.
      const buckets: StatsBucket[] = [];
      for (let i = 0; i < dayCount; i++) {
        const d = new Date(from);
        d.setDate(from.getDate() + i);
        const iso = this.toLocalIsoDate(d);
        const found = byDate.get(iso);
        if (!this.isWorkingDay(d) && !found) continue;
        buckets.push({
          key: iso,
          label: this.dayLabel(iso),
          ...base(found),
          meta_modulos: objetivo.get(iso) ?? 0,
          working_days: 1,
          granularity: 'day',
          futuro: iso > todayIso,
          en_curso: iso === todayIso,
        });
      }
      return buckets;
    }

    const buckets: StatsBucket[] = [];
    const cursor = this.getMondayOfWeek(from);
    while (cursor <= to) {
      const weekStart = new Date(cursor);
      const weekEnd = new Date(cursor);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const segStart = weekStart < from ? new Date(from) : weekStart;
      const segEnd = weekEnd > to ? new Date(to) : weekEnd;

      let modulos = 0, fases = 0, pt = 0, pi = 0, pf = 0, desp = 0, dif = 0, workDays = 0, meta = 0;
      let tiSum = 0, tiN = 0, tsSum = 0, tsN = 0;
      let hTurno: number | null = null, hTrabajo: number | null = null, hMuertas: number | null = null;
      let hFuera: number | null = null, estimado = false;
      let diasTurno = 0, diasSinRegistro = 0;
      const d = new Date(segStart);
      while (d <= segEnd) {
        const found = byDate.get(this.toLocalIsoDate(d));
        if (found) {
          modulos += found.modulos_completados || 0;
          if (typeof found.horas_trabajo === 'number') {
            hTurno = (hTurno ?? 0) + (found.horas_turno ?? 0);
            hTrabajo = (hTrabajo ?? 0) + found.horas_trabajo;
            hMuertas = (hMuertas ?? 0) + (found.horas_muertas ?? 0);
            hFuera = (hFuera ?? 0) + (found.horas_fuera_turno ?? 0);
            estimado = estimado || !!found.estimado;
            if (found.horas_turno) {
              diasTurno++;
              if (found.sin_registro) diasSinRegistro++;
            }
          }
          fases += found.fases_completadas || 0;
          pt += this.pesoTotal(found);
          pi += found.peso_malla_inicial_kg || 0;
          pf += found.peso_malla_final_kg || 0;
          desp += found.desperdicio_kg || 0;
          dif += found.dificultad_total || 0;
          // Media de las medianas diarias, ponderada por paneles.
          if (typeof found.tiempo_inferior_min === 'number') {
            const peso = found.tiempo_inferior_paneles || 1;
            tiSum += found.tiempo_inferior_min * peso;
            tiN += peso;
          }
          if (typeof found.tiempo_superior_min === 'number') {
            const peso = found.tiempo_superior_paneles || 1;
            tsSum += found.tiempo_superior_min * peso;
            tsN += peso;
          }
        }
        if (this.isWorkingDay(d)) workDays++;
        meta += objetivo.get(this.toLocalIsoDate(d)) ?? 0;
        d.setDate(d.getDate() + 1);
      }

      const segStartIso = this.toLocalIsoDate(segStart);
      buckets.push({
        key: this.toLocalIsoDate(weekStart),
        label: `S${this.getIsoWeek(weekStart)}`,
        modulos_completados: modulos,
        fases_completadas: fases,
        peso_total_kg: pt,
        peso_malla_inicial_kg: pi,
        peso_malla_final_kg: pf,
        desperdicio_kg: desp,
        desperdicio_pct: pct(desp, pt),
        dificultad_total: dif,
        tiempo_inferior_min: tiN ? tiSum / tiN : null,
        tiempo_superior_min: tsN ? tsSum / tsN : null,
        horas_turno: hTurno,
        horas_trabajo: hTrabajo,
        horas_muertas: hMuertas,
        horas_fuera_turno: hFuera,
        // Una semana entera sin señal es "sin registro"; la mitad, ya no.
        sin_registro: diasTurno > 0 && diasSinRegistro === diasTurno,
        estimado,
        abre: null,
        cierra: null,
        meta_modulos: meta,
        working_days: workDays,
        granularity: 'week',
        futuro: segStartIso > todayIso,
        en_curso: segStartIso <= todayIso && todayIso <= this.toLocalIsoDate(segEnd),
      });

      cursor.setDate(cursor.getDate() + 7);
    }
    return buckets;
  }

  /** Jornada de la ferralla ese dia de la semana, en horas enteras de reloj. */
  /** Periodo anterior y siguiente al rango, para prolongar las lineas desvanecidas. */
  private statsVecinos(granularity: StatsBucket['granularity'] | undefined): { prev: StatsVecino | null; next: StatsVecino | null } {
    const ctx = this.statsData?.contexto;
    const from = this.parseIsoDate(this.statsFrom);
    const to = this.parseIsoDate(this.statsTo);
    if (!ctx || !from || !to || !granularity || granularity === 'hour') return { prev: null, next: null };
    const dias = new Map([...ctx.anterior, ...ctx.siguiente].map(d => [d.fecha, d]));
    const todayIso = this.toLocalIsoDate(new Date());
    const mover = (date: Date, delta: number): Date => {
      const d = new Date(date);
      d.setDate(d.getDate() + delta);
      return d;
    };
    const sumar = (start: Date, days: number): StatsVecino | null => {
      // Lo que aun no ha pasado no es un cero: no hay linea hacia ahi.
      if (this.toLocalIsoDate(start) > todayIso) return null;
      let modulos = 0, peso = 0, desperdicio = 0, dificultad = 0;
      let tiSum = 0, tiN = 0, tsSum = 0, tsN = 0;
      for (let k = 0; k < days; k++) {
        const found = dias.get(this.toLocalIsoDate(mover(start, k)));
        if (!found) continue;
        modulos += found.modulos_completados || 0;
        peso += this.pesoTotal(found);
        desperdicio += found.desperdicio_kg || 0;
        dificultad += found.dificultad_total || 0;
        if (typeof found.tiempo_inferior_min === 'number') {
          const w = found.tiempo_inferior_paneles || 1;
          tiSum += found.tiempo_inferior_min * w;
          tiN += w;
        }
        if (typeof found.tiempo_superior_min === 'number') {
          const w = found.tiempo_superior_paneles || 1;
          tsSum += found.tiempo_superior_min * w;
          tsN += w;
        }
      }
      return {
        modulos, peso, dificultad,
        desperdicio_pct: peso > 0 ? (desperdicio / peso) * 100 : null,
        tiempo_inferior: tiN ? tiSum / tiN : null,
        tiempo_superior: tsN ? tsSum / tsN : null,
      };
    };
    if (granularity === 'day') {
      let prev = mover(from, -1);
      for (let i = 0; i < 14 && !this.isWorkingDay(prev); i++) prev = mover(prev, -1);
      let next = mover(to, 1);
      for (let i = 0; i < 14 && !this.isWorkingDay(next); i++) next = mover(next, 1);
      return { prev: sumar(prev, 1), next: sumar(next, 1) };
    }
    return {
      prev: sumar(mover(this.getMondayOfWeek(from), -7), 7),
      next: sumar(mover(this.getMondayOfWeek(to), 7), 7),
    };
  }

  /** Series de las graficas y filas de la tabla por periodo (se recalcula al cambiar los datos). */
  statsVista(): StatsVista | null {
    const data = this.statsData;
    if (!data) return null;
    const hora = new Date().getHours();
    const cache = this.statsVistaCache;
    if (cache && cache.data === data && cache.from === this.statsFrom && cache.to === this.statsTo
      && cache.horario === this.horario && cache.hora === hora) {
      return cache.vista;
    }

    const buckets = this.statsBuckets();
    const granularity = buckets[0]?.granularity;
    const { prev, next } = this.statsVecinos(granularity);
    const valores = (pick: (b: StatsBucket) => number | null): Array<number | null> =>
      buckets.map(b => b.futuro ? null : pick(b));
    const hayObjetivo = buckets.some(b => b.meta_modulos > 0);
    // El objetivo va por tramos de montaje: si cambia dentro del rango, se dice el rango.
    const metas = buckets.filter(b => b.granularity !== 'week' && b.meta_modulos > 0).map(b => b.meta_modulos);
    const cap = metas.length ? Math.max(...metas) : 0;
    const minCap = metas.length ? Math.min(...metas) : 0;
    const capLabel = Math.abs(cap - minCap) < 0.05 ? formatNumber(cap, 'en-US', '1.0-1')
      : `${formatNumber(metas[0], 'en-US', '1.0-1')} → ${formatNumber(metas[metas.length - 1], 'en-US', '1.0-1')}`;
    // La dificultad por modulo va en la grafica de modulos, en su escala: su media del
    // periodo cae a la altura de la media de modulos (encima, mas dificil de lo normal).
    // Un solo eje, el de los modulos; la lectura dice los puntos reales.
    const pasados = buckets.filter(b => !b.futuro);
    const conModulos = pasados.filter(b => b.modulos_completados > 0);
    const totalModulos = conModulos.reduce((total, b) => total + b.modulos_completados, 0);
    const mediaModulos = conModulos.length ? totalModulos / conModulos.length : 0;
    const mediaDificultad = totalModulos > 0
      ? conModulos.reduce((total, b) => total + b.dificultad_total, 0) / totalModulos : 0;
    // Del turno, la parte trabajada (lo de fuera de turno cuenta dentro del entero).
    const horasTexto = (h: number): string => granularity === 'hour'
      ? `${Math.round(h * 60)} min` : `${formatNumber(h, 'en-US', '1.0-1')} h`;
    const trabajado = (b: StatsBucket): number | null => {
      const total = (b.horas_trabajo ?? 0) + (b.horas_muertas ?? 0);
      return b.horas_trabajo === null || total <= 0 ? null : ((b.horas_trabajo ?? 0) / total) * 100;
    };
    const desperdicioVecino = (v: StatsVecino | null): number | null =>
      v && v.desperdicio_pct !== null ? (v.peso * v.desperdicio_pct) / 100 : null;
    const porModulo = (modulos: number, dificultad: number): number | null => modulos > 0 ? dificultad / modulos : null;
    const enEscalaDeModulos = (dificultad: number | null): number | null =>
      dificultad === null || mediaDificultad <= 0 ? null : (dificultad / mediaDificultad) * mediaModulos;
    const vista: StatsVista = {
      labels: buckets.map(b => b.label),
      pending: buckets.map(b => b.en_curso),
      objetivo: hayObjetivo ? buckets.map(b => b.meta_modulos > 0 ? b.meta_modulos : null) : null,
      objetivoLabel: granularity === 'hour' ? `Objetivo ${capLabel} por hora`
        : granularity === 'week' ? 'Objetivo de la semana'
        : `Objetivo ${capLabel} al día`,
      modulos: [
        {
          name: 'Módulos', color: CHART_NARANJA, values: valores(b => b.modulos_completados),
          prev: prev?.modulos ?? null, next: next?.modulos ?? null,
        },
        {
          name: 'Dificultad por módulo', color: CHART_AZUL,
          values: valores(b => enEscalaDeModulos(porModulo(b.modulos_completados, b.dificultad_total))),
          prev: prev ? enEscalaDeModulos(porModulo(prev.modulos, prev.dificultad)) : null,
          next: next ? enEscalaDeModulos(porModulo(next.modulos, next.dificultad)) : null,
          tooltips: buckets.map(b => {
            const dificultad = b.futuro ? null : porModulo(b.modulos_completados, b.dificultad_total);
            return dificultad === null ? null : `${formatNumber(dificultad, 'en-US', '1.0-0')} puntos`;
          }),
        },
      ],
      // Peso y desperdicio, los dos en kilos: la misma escala.
      peso: [
        {
          name: 'Peso producido', color: CHART_NARANJA, values: valores(b => b.peso_total_kg),
          prev: prev?.peso ?? null, next: next?.peso ?? null,
        },
        {
          // Lo que se tira, en gris oscuro.
          name: 'Desperdicio', color: CHART_GRIS, values: valores(b => b.desperdicio_kg),
          prev: desperdicioVecino(prev), next: desperdicioVecino(next),
        },
      ],
      tiempo: [
        {
          name: 'Inferior', color: CHART_AZUL, values: valores(b => b.tiempo_inferior_min),
          prev: prev?.tiempo_inferior ?? null, next: next?.tiempo_inferior ?? null,
        },
        {
          name: 'Superior', color: CHART_NARANJA, values: valores(b => b.tiempo_superior_min),
          prev: prev?.tiempo_superior ?? null, next: next?.tiempo_superior ?? null,
        },
      ],
      horas: [{
        name: 'Trabajado', color: CHART_AZUL, values: valores(trabajado),
        tooltips: buckets.map(b => {
          const pct = b.futuro ? null : trabajado(b);
          return pct === null ? null
            : `${formatNumber(pct, 'en-US', '1.0-0')} % · ${horasTexto(b.horas_trabajo ?? 0)} de trabajo + ${horasTexto(b.horas_muertas ?? 0)} muertas`;
        }),
      }],
      horasUnidad: granularity === 'hour' ? 'min' : 'h',
      conSenales: granularity === 'day',
      filas: buckets.filter(b => !b.futuro),
      detalleTitulo: granularity === 'hour' ? 'Detalle por hora' : granularity === 'week' ? 'Detalle por semana' : 'Detalle por día',
      periodoLabel: granularity === 'hour' ? 'Hora' : granularity === 'week' ? 'Semana' : 'Día',
    };
    this.statsVistaCache = { data, from: this.statsFrom, to: this.statsTo, horario: this.horario, hora, vista };
    return vista;
  }

  /** Indicadores derivados del rango: media, mejor dia (u hora), pesos. */
  statsResumen(): StatsResumen | null {
    const data = this.statsData;
    if (!data) return null;
    const modulos = data.totals.modulos_completados || 0;
    // Un dia: por hora (media de las horas con produccion y la mejor hora).
    const porHora = this.statsFrom === this.statsTo && !!data.por_hora;
    const periodos = porHora
      ? (data.por_hora || []).map(h => ({ modulos: h.modulos_completados, label: `${h.hora}h` }))
      : data.por_dia.map(d => ({ modulos: d.modulos_completados, label: this.dayLabel(d.fecha) }));
    const conProduccion = periodos.filter(p => p.modulos > 0);
    const mejor = conProduccion.reduce<typeof conProduccion[number] | null>(
      (best, p) => !best || p.modulos > best.modulos ? p : best, null);
    const producido = this.pesoTotal(data.totals);

    return {
      porHora,
      media: conProduccion.length ? modulos / conProduccion.length : null,
      mejor,
      kgPorModulo: modulos > 0 ? producido / modulos : null,
      dificultadMedia: modulos > 0 ? (data.totals.dificultad_total || 0) / modulos : null,
      pesoTotal: producido + (data.totals.desperdicio_kg || 0),
    };
  }

  /** Peso real fabricado de un bloque de estadisticas: malla recortada mas refuerzos,
   *  zunchos, separadores y punzonamientos. */
  pesoTotal(bucket: { peso_total_kg?: number; peso_malla_final_kg?: number } | null | undefined): number {
    return bucket?.peso_total_kg ?? bucket?.peso_malla_final_kg ?? 0;
  }

  /** Porcentaje de modulos terminados de un proyecto sobre su total (sin decimales). */
  avanceProyecto(proyecto: { modulos_total: number; modulos_completados: number } | null | undefined): number | null {
    if (!proyecto || !proyecto.modulos_total) return null;
    return Math.round((proyecto.modulos_completados / proyecto.modulos_total) * 100);
  }

  /** "+2" / "−1.5" frente al objetivo de la fila. */
  diferenciaLabel(fila: StatsBucket): string {
    const diff = fila.modulos_completados - fila.meta_modulos;
    const valor = formatNumber(Math.abs(diff), 'en-US', '1.0-1');
    return `${diff >= -1e-9 ? '+' : '−'}${valor}`;
  }

  llegaAlObjetivo(fila: StatsBucket): boolean {
    return fila.modulos_completados >= fila.meta_modulos - 1e-9;
  }

  /** Minutos de una fase: "42" si se midio en la mesa, "~42" si es aproximado. */
  minutosLabel(fase: ProductionStatsModuloFase | null): string {
    if (!fase || fase.minutos === null) return '—';
    return `${fase.medido ? '' : '~'}${Math.round(fase.minutos)}`;
  }

  /** Medido: el trabajo, lo que fue sin pasar diapositiva, lo parado (y fuera de turno) y si pernocto. */
  minutosTitulo(fase: ProductionStatsModuloFase | null): string {
    if (!fase || fase.minutos === null) return 'Sin tiempo registrado';
    if (!fase.medido) return 'Aproximado entre paneles hechos';
    const partes = [`${Math.round(fase.minutos)} min de trabajo medidos en la mesa`];
    if (fase.sin_pulsar_min) partes[0] += ` (${Math.round(fase.sin_pulsar_min)} sin pasar diapositiva)`;
    if (fase.parado_min) {
      let parado = `${Math.round(fase.parado_min)} min parada`;
      if (fase.parado_fuera_min) parado += ` (${Math.round(fase.parado_fuera_min)} fuera de turno)`;
      partes.push(parado);
    }
    if (fase.pernocto) partes.push('pernoctó en la mesa');
    return partes.join(' · ');
  }

  minutosModuloLabel(modulo: ProductionStatsModulo): string {
    if (modulo.minutos === null) return '—';
    const medido = !!modulo.inferior?.medido && !!modulo.superior?.medido;
    return `${medido ? '' : '~'}${Math.round(modulo.minutos)}`;
  }

  /** Lo que el modulo estuvo parado en la mesa: la suma de sus dos fases, si las dos se midieron
   *  (como la mediana del indicador); null si alguna es aproximada. */
  paradoModulo(modulo: ProductionStatsModulo): number | null {
    const inferior = modulo.inferior?.parado_min;
    const superior = modulo.superior?.parado_min;
    return typeof inferior === 'number' && typeof superior === 'number' ? inferior + superior : null;
  }

  /** Grafica del turno: debajo de la linea lo trabajado, encima el tiempo muerto. */
  readonly splitHoras: SplitArea = { below: CHART_AZUL, above: CHART_AMARILLO, belowLabel: 'Trabajo', aboveLabel: 'Tiempo muerto' };

  /** El servidor ya deduce trabajo y tiempo muerto (uno antiguo solo da horas de jornada). */
  hayActividad(): boolean {
    return this.statsData?.totals.horas_trabajo != null;
  }

  /** Hay trabajo medido: los ritmos van por hora de trabajo. */
  ritmoDeTrabajo(): boolean {
    const totals = this.statsData?.totals;
    return !!totals && totals.modulos_por_hora_trabajo != null && !!totals.horas_trabajo;
  }

  /** Horas con un decimal, o guion. */
  horasLabel(horas: number | null | undefined): string {
    return typeof horas === 'number' ? formatNumber(horas, 'en-US', '1.0-1') : '—';
  }

  /** Horas de una fila: por hora del dia, en minutos, que una hora partida en decimas no se lee. */
  horasFilaLabel(fila: StatsBucket, horas: number | null): string {
    if (horas === null) return '—';
    if (fila.granularity === 'hour') return `${Math.round(horas * 60)} min`;
    return this.horasLabel(horas);
  }

  /** Titulo del indicador de horas: el turno del periodo y, si lo hay, el trabajo fuera de turno. */
  horasTitulo(totals: ProductionStatsResponse['totals']): string {
    const base = `Horas de turno del período: ${this.horasLabel(totals.horas_productivas)} h. `
      + 'Trabajo: mientras las mesas dan señales (diapositivas, fotos, fases hechas). Muertas: turno sin trabajo.';
    return totals.horas_fuera_turno
      ? `${base} Incluye ${this.horasLabel(totals.horas_fuera_turno)} h trabajadas fuera de turno.`
      : base;
  }

  /** Titulo de una fila: su turno y sus horas de trabajo y muertas (en que se fue
   *  el tiempo muerto no se detalla: es cosa de la ferralla). */
  horasFilaTitulo(fila: StatsBucket): string {
    if (fila.horas_trabajo === null) return '';
    const unidad = fila.granularity === 'hour' ? '' : ' h';
    const fuera = fila.horas_fuera_turno ?? 0;
    // Dentro del turno, trabajo + muertas suman el turno; lo de fuera va aparte.
    const partes = [
      `Turno de ${this.horasFilaLabel(fila, fila.horas_turno)}${unidad}: ${this.horasFilaLabel(fila, fila.horas_trabajo - fuera)}${unidad} de trabajo`
      + ` + ${this.horasFilaLabel(fila, fila.horas_muertas)}${unidad} muertas`,
    ];
    if (fuera > 0) partes.push(`${this.horasFilaLabel(fila, fuera)}${unidad} trabajadas fuera de turno`);
    if (fila.sin_registro) partes.push('sin ninguna señal en el turno');
    if (fila.estimado) partes.push('estimado: sin registro de eventos, solo fotos y fases hechas');
    return partes.join(' · ');
  }

  /** "06:12 – 15:48": primera y ultima señal del dia, en la hora de la fabrica
   *  (el servidor ya las manda en su zona: no se pasan por la del navegador). */
  senalesLabel(fila: StatsBucket): string {
    if (!fila.abre || !fila.cierra) return '—';
    return `${fila.abre.slice(11, 16)} – ${fila.cierra.slice(11, 16)}`;
  }

  /** Nota al pie con el criterio del servidor para deducir el trabajo de las señales. */
  criterioNota(): string {
    const c = this.statsData?.criterio;
    if (!c) return '';
    const sinPulsar = c.sin_pulsar_min
      ? ` Dentro de una fase, un hueco de hasta ${c.sin_pulsar_min} min cuenta como trabajo sin pasar diapositiva.` : '';
    return `Criterio ${c.version}: una mesa trabaja mientras sus señales (diapositivas, fotos, fases hechas) van a menos de `
      + `${c.umbral_min} min; solo con fotos, ${c.umbral_fotos_min} min y queda como estimado. El resto del turno es tiempo muerto.`
      + sinPulsar;
  }

  private parseIsoDate(iso: string): Date | null {
    if (!iso) return null;
    const parts = iso.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  /**
   * Dia con turnos: dentro del rango, los dias que trae el servidor; fuera,
   * los mismos dias de la semana que en el rango (sin datos, de lunes a viernes).
   */
  private isWorkingDay(d: Date): boolean {
    const iso = this.toLocalIsoDate(d);
    const range = this.statsData?.range;
    const dias = range?.dias;
    if (dias && range && iso >= range.from && iso <= range.to) return dias.some(dia => dia.fecha === iso);
    // Los festivos del calendario no tienen objetivo.
    if ((range?.festivos || []).includes(iso)) return false;
    const semana = dias?.length
      ? new Set(dias.map(dia => this.parseIsoDate(dia.fecha)!.getDay()))
      : new Set([1, 2, 3, 4, 5]);
    return semana.has(d.getDay());
  }

  /** Objetivo de cada dia: el ritmo de su tramo (lo que exigen los montajes), que manda el servidor. */
  private objetivoPorDia(): Map<string, number> {
    const objetivo = new Map<string, number>();
    const data = this.statsData;
    const target = this.statsPeriodTarget();
    if (!data || target === null || target <= 0) return objetivo;
    const dias = data.range.dias;
    if (dias?.some(dia => typeof dia.objetivo === 'number')) {
      dias.forEach(dia => { if (dia.objetivo) objetivo.set(dia.fecha, dia.objetivo); });
      return objetivo;
    }
    if (dias) {
      // Servidor anterior a los tramos: el objetivo del periodo repartido por turnos.
      const turnos = dias.reduce((total, dia) => total + dia.turnos, 0);
      if (turnos > 0) dias.forEach(dia => objetivo.set(dia.fecha, (target * dia.turnos) / turnos));
      return objetivo;
    }
    // Servidor anterior a los turnos: los laborables a partes iguales.
    const from = this.parseIsoDate(data.range.from);
    const to = this.parseIsoDate(data.range.to);
    const laborables: string[] = [];
    for (const d = new Date(from!); from && to && d <= to; d.setDate(d.getDate() + 1)) {
      if (this.isWorkingDay(d)) laborables.push(this.toLocalIsoDate(d));
    }
    laborables.forEach(iso => objetivo.set(iso, target / laborables.length));
    return objetivo;
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
   * Desperdicio como porcentaje del peso total fabricado: los kilos de
   * desperdicio entre los kilos de "Peso producido", los dos numeros que se
   * ven en pantalla. Devuelve null si no hay peso con el que comparar.
   */
  desperdicioPct(totals: { desperdicio_kg?: number; peso_total_kg?: number; peso_malla_final_kg?: number } | null | undefined): number | null {
    if (!totals) return null;
    const total = this.pesoTotal(totals);
    if (total <= 0) return null;
    return ((totals.desperdicio_kg || 0) / total) * 100;
  }

  loadModulosForProyecto(proyectoId: number): void {
    this.loadingModulos = true;
    this.api.getModulos(proyectoId)
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
  refreshActiveProjectModules(): void {
    if (!this.selectedProyecto || this.loadingModulos || this.modulosEnVuelo) return;

    this.modulosEnVuelo = true;
    this.api.getModulos(this.selectedProyecto.id)
      .pipe(takeUntil(this.destroy$), finalize(() => this.modulosEnVuelo = false))
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
          if (this.selectedProyecto) {
            this.api.getModulos(this.selectedProyecto.id)
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

  /**
   * Reorder de items dentro de la cola visible de UNA mesa (dashboard
   * cliente). El cdkDropList trabaja con la sublista visible (cap
   * diario); aqui combinamos esa sublista reordenada con los items
   * ocultos (que mantienen su orden relativo) y mandamos al backend un
   * payload con positions globales 0..N. El primer visible no puede
   * desplazarse si es MOSTRANDO -- esa proteccion la hace el backend
   * via su lectura del status, pero el handler tambien rechaza el drop
   * a index 0 para no parpadear la UI.
   */
  onClienteMesaQueueDrop(event: CdkDragDrop<MesaQueueItem[]>, mesaId: number): void {
    if (event.previousContainer !== event.container) return;
    if (event.previousIndex === event.currentIndex) return;

    const visible = event.container.data;
    const hasMostrando = visible.some(i => i.status === 'MOSTRANDO');
    if (hasMostrando && event.currentIndex === 0) {
      // El MOSTRANDO es ancla visual; redirigir a la posicion 1.
      event.currentIndex = 1;
    }
    moveItemInArray(visible, event.previousIndex, event.currentIndex);

    // Reconstruir la cache local: visibles (reordenados) + ocultos (orden
    // original) + HECHO al final, para no perder lo que no esta en el
    // dropList.
    const cache = this.mesaQueueItems.get(mesaId) || [];
    const active = cache.filter(i => i.status !== 'HECHO');
    const done = cache.filter(i => i.status === 'HECHO');
    const visibleIds = new Set(visible.map(i => i.id));
    const hidden = active.filter(i => !visibleIds.has(i.id));
    const newActive = [...visible, ...hidden];
    this.mesaQueueItems.set(mesaId, [...newActive, ...done]);
    this.cdr.detectChanges();

    // Payload con positions globales para todos los activos.
    const payload = newActive.map((item, index) => ({ id: item.id, position: index }));
    this.api.reorderMesaQueue(payload).subscribe({
      next: () => { /* silent */ },
      error: () => {
        // Revert recargando desde backend.
        this.loadMesaQueueItems(mesaId);
        alert('No se pudo guardar el nuevo orden.');
      },
    });
  }

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
    if (!item.modulo_proyecto_id) {
      console.warn('Navigation IDs missing', item);
      return;
    }

    const proyecto = this.proyectos.find(p => p.id === item.modulo_proyecto_id);
    if (!proyecto) {
      console.warn('Project not found in list', item.modulo_proyecto_id);
      return;
    }

    this.selectedProyecto = proyecto;
    this.selectedModulo = null;
    this.loadingModulos = true;
    this.api.getModulos(proyecto.id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (modulos) => {
          this.modulos = this.sortModulos(modulos);
          this.loadingModulos = false;
          const target = this.modulos.find(m => m.id === item.modulo);
          if (target) this.toggleModulo(target);
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.loadingModulos = false;
          console.error('Error loading project modules', err);
        }
      });
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

  getItemImageProgress(item: MesaQueueItem): string | null {
    if (item.status !== 'MOSTRANDO' || item.imagenes_total < 1) return null;
    const current = Math.min(
      Math.max((item.current_image_index ?? 0) + 1, 1),
      item.imagenes_total
    );
    return `${current} / ${item.imagenes_total}`;
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
   * Muestra separador "<Proyecto> · Bastidor N" antes de un item si cambia
   * el plan_group_index O el proyecto respecto al item anterior. Solo se
   * aplica a mesas inferiores; en SUP no tiene sentido agrupar visualmente.
   */
  shouldShowGroupDivider(item: MesaQueueItem, index: number, mesa: Mesa): boolean {
    if (mesa.tipo === 'SUPERIOR') return false;
    const current = item.plan_group_index;
    if (current == null) return false;
    if (index === 0) return true;
    const items = this.getMesaQueueItems(mesa.id);
    const prev = items[index - 1];
    if (!prev) return true;
    return current !== prev.plan_group_index || item.modulo_proyecto_id !== prev.modulo_proyecto_id;
  }

  getItemGrupoIndice(item: MesaQueueItem): number | null {
    return item.plan_group_index ?? null;
  }

  /**
   * Label del divider "<Proyecto> · <Grupo>". Cuando hay varios
   * proyectos en cola de una mesa los GrupoBastidor reinician su
   * numeracion en cada uno, asi que sin el proyecto delante el
   * operario no distingue 'Bastidor 1' de P5 vs 'Bastidor 1' de P3.
   */
  getItemGrupoLabel(item: MesaQueueItem): string {
    const grupoName = (item.grupo_bastidor_nombre || '').trim();
    const grupoIdx = item.grupo_bastidor_indice;
    const sufijo = (item.grupo_bastidor_sufijo || '').trim();
    const base = grupoName || (grupoIdx != null ? `Bastidor ${grupoIdx}` : 'Bastidor');
    const grupo = !sufijo ? base : (grupoName ? `${base} ${sufijo}` : `${base}${sufijo}`);
    const proyecto = (item.modulo_proyecto_nombre || '').trim();
    return proyecto ? `${proyecto} · ${grupo}` : grupo;
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
    // Lo que le toca hoy y el resto de la semana en el plan de la ferralla.
    const hoy = Math.min(pending, p.planificacion?.modulos_hoy || 0);
    const semana = Math.min(Math.max(pending - hoy, 0), p.planificacion?.modulos_semana || 0);
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
