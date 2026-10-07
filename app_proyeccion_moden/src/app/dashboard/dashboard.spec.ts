import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Dashboard } from './dashboard';
import {
  ApiService, FerrallaCaptureConfig, GrupoBastidor, GrupoBastidorModulo, GrupoMesas, Mesa, MesaQueueItem, Modulo, Proyecto,
  ProductionStatsBucket, ProductionStatsDay, ProductionStatsResponse, ElementosSueltos,
} from '../services/api.service';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';

describe('Dashboard', () => {
  let component: Dashboard;
  let fixture: ComponentFixture<Dashboard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Dashboard]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Dashboard);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('production summary and deadline demand', () => {
    let stats: ProductionStatsResponse;
    const render = () => {
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };
    const text = (selector: string): string =>
      fixture.nativeElement.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() || '';

    beforeEach(() => {
      // Las estadisticas viven en su propia vista del dashboard.
      component.vista = 'estadisticas';
      stats = {
        range: {from: '2026-09-01', to: '2026-09-14', working_days: 10},
        totals: {
          fases_completadas: 0, modulos_completados: 0, peso_malla_inicial_kg: 0,
          peso_malla_final_kg: 0, desperdicio_kg: 0, cantidad_cortes: 0,
          cantidad_refuerzos: 0, cantidad_zunchos: 0, cantidad_separadores: 0,
          cantidad_punzos: 0, dificultad_total: 0, horas_productivas: 0,
          modulos_por_hora: 0, kg_por_hora: 0,
        },
        por_mesa: [], por_dia: [],
        esperado: {capacidad_diaria_modulos: 9, modulos_esperados: 9, proyectos_sin_objetivo: 0},
        planificacion: {modulos_por_dia: 9, modulos_hoy: 9, sin_planificar: 0, urgentes: 0, proyectos: []},
      };
      component.statsData = stats;
      component.statsFrom = stats.range.from;
      component.statsTo = stats.range.to;
    });

    it('shows the time per panel as a KPI per phase and a column per mesa', () => {
      stats.tiempos = {
        inferior: {mediana_min: 34.4, media_min: 40.2, paneles: 12, medidos: 3},
        superior: {mediana_min: null, media_min: null, paneles: 0, medidos: 0},
      };
      stats.por_mesa = [{
        mesa_id: 1, mesa_nombre: 'Mesa 1', tipo: 'INFERIOR', indice: 1, fases_completadas: 12,
        peso_malla_inicial_kg: 0, peso_malla_final_kg: 0, desperdicio_kg: 0, cantidad_cortes: 0, cantidad_refuerzos: 0,
        cantidad_zunchos: 0, cantidad_separadores: 0, cantidad_punzos: 0, dificultad_total: 0,
        tiempo_mediana_min: 34.4, tiempo_paneles: 12, tiempo_medidos: 3,
      }];
      stats.totals.fases_completadas = 12;
      render();
      const kpis = Array.from(fixture.nativeElement.querySelectorAll('.stats-kpi-tiempo')) as HTMLElement[];
      expect(kpis.map(k => k.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'Tiempo inferior 34 min/panel', 'Tiempo superior — min/panel',
      ]);
      expect(kpis[0].getAttribute('title')).toBe('Inferior: mediana de 12 paneles, 3 medidos');
      expect(text('.stats-tiempo-cell')).toBe('34');
      expect(text('.stats-tiempo-nota')).toContain('Los paneles fabricados desde ahora se miden');
      expect(component.tiempoDetalle({mediana_min: 20, media_min: 20, paneles: 5, medidos: 5})).toBe('mediana de 5 paneles medidos');
      expect(component.tiempoDetalle({mediana_min: 20, media_min: 20, paneles: 1, medidos: 0})).toBe('mediana de 1 panel, aproximado');
    });

    it('builds the line charts with the daily target, the day in progress and the neighbouring periods', () => {
      const dia = (fecha: string, modulos: number, extra: Partial<ProductionStatsDay> = {}): ProductionStatsDay => ({
        fecha, modulos_completados: modulos, fases_completadas: modulos * 2, peso_total_kg: 130, peso_malla_inicial_kg: 100, peso_malla_final_kg: 90,
        desperdicio_kg: 10, cantidad_cortes: 0, cantidad_refuerzos: 0, cantidad_zunchos: 0, cantidad_separadores: 0,
        cantidad_punzos: 0, dificultad_total: 50, ...extra,
      });
      // Semana del lunes 14 al viernes 18 de septiembre de 2026: 10 modulos de objetivo en 5 dias.
      stats.range = {from: '2026-09-14', to: '2026-09-18', working_days: 5};
      stats.esperado.modulos_esperados = 10;
      stats.totals.modulos_completados = 7;
      stats.totals.fases_completadas = 14;
      stats.por_dia = [
        dia('2026-09-14', 3, {tiempo_inferior_min: 40, tiempo_superior_min: 20}),
        dia('2026-09-15', 1),
        dia('2026-09-17', 3),
      ];
      stats.contexto = {anterior: [dia('2026-09-11', 4)], siguiente: [dia('2026-09-21', 2)]};
      component.statsFrom = '2026-09-14';
      component.statsTo = '2026-09-18';

      const vista = component.statsVista()!;
      expect(vista.labels).toEqual(['Lun 14', 'Mar 15', 'Mié 16', 'Jue 17', 'Vie 18']);
      expect(vista.modulos[0].values).toEqual([3, 1, 0, 3, 0]);
      expect(vista.objetivo).toEqual([2, 2, 2, 2, 2]);
      expect(vista.objetivoLabel).toBe('Objetivo 2 al día');
      // La linea se prolonga hacia el viernes anterior y el lunes siguiente.
      expect(vista.modulos[0].prev).toBe(4);
      expect(vista.modulos[0].next).toBe(2);
      expect(vista.tiempo.map(serie => serie.values[0])).toEqual([40, 20]);
      expect(vista.tiempo[0].values[1]).toBeNull();
      // Desperdicio sobre el peso total: 10 kg de 130 kg fabricados.
      expect(vista.desperdicio[0].values[0]).toBeCloseTo(7.69, 2);
      expect(vista.desperdicio[0].prev).toBeCloseTo(7.69, 2);
      expect(component.desperdicioPct({desperdicio_kg: 184.9, peso_total_kg: 10458, peso_malla_final_kg: 7089})).toBeCloseTo(1.77, 2);
      expect(component.desperdicioPct({desperdicio_kg: 5, peso_total_kg: 0})).toBeNull();
      // El peso de las graficas y tablas es el total del modulo, no solo el mallazo.
      expect(vista.peso[0].values).toEqual([130, 130, 0, 130, 0]);
      expect(vista.peso[0].prev).toBe(130);
      expect(component.statsResumen()).toEqual({
        cumplimiento: 70, diasCumplidos: {cumplidos: 2, total: 5}, mediaDiaria: 7 / 3,
        mejorDia: {modulos: 3, label: 'Lun 14'}, kgPorModulo: 0, dificultadMedia: 0,
      });

      render();
      const filas = Array.from(fixture.nativeElement.querySelectorAll('.stats-table-periodos tbody tr')) as HTMLElement[];
      expect(filas.length).toBe(5);
      expect(Array.from(filas[0].querySelectorAll('td')).slice(0, 4).map(td => td.textContent?.trim()))
        .toEqual(['Lun 14', '3', '2', '+1']);
      // Paneles, peso total y mallazo, en ese orden.
      expect(Array.from(filas[0].querySelectorAll('td')).slice(4, 7).map(td => td.textContent?.trim()))
        .toEqual(['6', '130', '90']);
      expect(filas[1].querySelector('.stats-diferencia')?.classList.contains('is-bajo')).toBe(true);
      expect(filas[0].querySelector('.stats-diferencia')?.classList.contains('is-ok')).toBe(true);
    });

    it('lists every finished module with its mesas, hours, minutes and weight', () => {
      stats.totals.modulos_completados = 1;
      stats.totals.fases_completadas = 2;
      stats.modulos = [{
        id: 5, nombre: 'A73', proyecto_id: 7, proyecto_nombre: 'Torre Norte', grupo: 'Grupo 2B',
        completado_at: '2026-09-14T10:30:00+02:00',
        inferior: {mesa_nombre: 'Mesa 1', done_at: '2026-09-14T09:05:00+02:00', minutos: 41.6, medido: true,
          peso_kg: 40, desperdicio_kg: 2, cortes: 3, refuerzos: 1, dificultad: 80},
        superior: {mesa_nombre: 'Mesa 3', done_at: '2026-09-14T10:30:00+02:00', minutos: 25, medido: false,
          peso_kg: 60, desperdicio_kg: 0, cortes: 1, refuerzos: 0, dificultad: 40},
        minutos: 66.6, peso_kg: 140, malla_kg: 100, desperdicio_kg: 2, dificultad: 120,
      }];
      stats.totals.peso_total_kg = 140;
      stats.totals.peso_malla_final_kg = 100;
      stats.totals.desperdicio_kg = 7;
      render();
      // El indicador de peso es solo el total; el mallazo queda en las tablas.
      expect(text('.stats-kpi[title^="Peso total"] .stats-kpi-value')).toBe('140 kg');
      // Desperdicio: kilos y, al lado, su porcentaje sobre el peso total (7 de 140).
      const desperdicio = fixture.nativeElement.querySelector('.stats-kpi[title^="Kilos de mallazo desechados"] .stats-kpi-value') as HTMLElement;
      expect(desperdicio.querySelector('.stats-kpi-sep')).not.toBeNull();
      expect(desperdicio.querySelector('.stats-kpi-pct')?.textContent).toBe('5.0');
      expect(desperdicio.textContent?.replace(/\s+/g, ' ').trim().startsWith('7 kg')).toBe(true);
      expect(component.statsResumen()?.kgPorModulo).toBe(140);
      const celdas = Array.from(fixture.nativeElement.querySelectorAll('.stats-table-modulos tbody td'))
        .map(td => (td as HTMLElement).textContent?.trim());
      expect(celdas.slice(0, 3)).toEqual(['A73', 'Torre Norte', 'Grupo 2B']);
      expect(celdas[4]).toBe('Mesa 1');
      expect(celdas[6]).toBe('42');
      expect(celdas[7]).toBe('Mesa 3');
      expect(celdas[9]).toBe('~25');
      expect(celdas.slice(10)).toEqual(['~67', '140', '100', '2', '120']);
      expect(text('.stats-table-modulos').length).toBeGreaterThan(0);
    });

    it('shows one project in full, from its first finished module to today', () => {
      component.proyectos = [
        { id: 7, nombre: 'Torre Norte', modulos_count: 110, modulos_completados: 73 } as Proyecto,
        { id: 8, nombre: 'Planta 1', modulos_count: 89, modulos_completados: 0 } as Proyecto,
      ];
      const request = vi.spyOn(TestBed.inject(ApiService), 'getProductionStats').mockImplementation((params = {}) => of({
        ...stats,
        totals: { ...stats.totals, modulos_completados: params.proyecto ? 73 : 0 },
        range: { from: params.rango === 'proyecto' ? '2026-08-04' : params.from!, to: params.rango === 'proyecto' ? '2026-09-30' : params.to!, working_days: 41 },
        proyecto: params.proyecto ? { id: 7, nombre: 'Torre Norte', modulos_total: 110, modulos_completados: 73, fecha_montaje: '2026-11-12' } : null,
      }));
      render();
      expect(Array.from(fixture.nativeElement.querySelectorAll('.stats-proyecto-select option')).map(o => (o as HTMLOptionElement).textContent?.trim()))
        .toEqual(['Todos los proyectos', 'Torre Norte', 'Planta 1']);
      expect(fixture.nativeElement.querySelector('.period-chip[title^="Desde el primer"]')).toBeNull();

      component.selectStatsProyecto(7);
      render();
      expect(request).toHaveBeenLastCalledWith({ from: '2026-09-01', to: '2026-09-14', proyecto: 7, rango: 'proyecto' });
      // El servidor fija las fechas y la pagina las adopta.
      expect(component.statsPreset).toBe('proyecto');
      expect(component.statsFrom).toBe('2026-08-04');
      expect(component.statsTo).toBe('2026-09-30');
      expect(text('.stats-scope')).toBe('Torre Norte · 73 de 110 módulos terminados · desde el 04/08/2026 · montaje el 12/11/2026');
      // Con un proyecto, el indicador dice cuántos lleva de los que tiene, no el objetivo del periodo.
      expect(text('.stats-kpi-modulos .stats-kpi-value')).toBe('73 / 110');
      expect(text('.stats-kpi-avance .stats-kpi-value')).toBe('66 %');
      expect(fixture.nativeElement.querySelector('.period-chip[title^="Desde el primer"]')?.classList.contains('active')).toBe(true);

      // Dentro del proyecto se puede acotar por fechas sin perder el proyecto.
      component.statsFrom = '2026-09-01';
      component.onStatsDateChange();
      expect(request).toHaveBeenLastCalledWith({ from: '2026-09-01', to: '2026-09-30', proyecto: 7, rango: undefined });
      expect(component.statsPreset).toBe('custom');

      // Volver a todos los proyectos recupera el mes en curso.
      component.selectStatsProyecto(null);
      expect(component.statsProyecto).toBeNull();
      expect(component.statsPreset).toBe('custom');
      expect(request).toHaveBeenLastCalledWith({ from: '2026-09-01', to: '2026-09-30', proyecto: undefined, rango: undefined });
    });

    it('shows every zero-valued KPI and the period target before production starts', () => {
      render();
      expect(fixture.nativeElement.querySelectorAll('.stats-kpi').length).toBe(13);
      expect(text('.stats-kpi-value')).toBe('0 / 9 objetivo');
      expect(text('.stats-kpi')).toBe('Módulos 0 / 9 objetivo');
      expect(text('.stats-empty')).toContain('No hay producción registrada');
      expect(fixture.nativeElement.querySelector('.stats-table')).toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-charts')).toBeNull();
      expect(fixture.nativeElement.querySelector('.deadline-summary')).toBeNull();
      expect(fixture.nativeElement.querySelector('#estadisticas-section .stats-module-target')).not.toBeNull();
    });

    it('compares historical production with the target for that period, not daily demand', () => {
      stats.totals.modulos_completados = 53;
      stats.totals.fases_completadas = 106;
      stats.esperado.modulos_esperados = 64;
      render();
      expect(text('.stats-kpi-value')).toBe('53 / 64 objetivo');
      expect(text('.stats-kpi')).toBe('Módulos 53 / 64 objetivo');
      expect(fixture.nativeElement.querySelector('.stats-table')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-charts')).not.toBeNull();
      expect(fixture.nativeElement.querySelectorAll('app-stats-line-chart').length).toBe(5);
      expect(fixture.nativeElement.querySelector('.stats-empty')).toBeNull();
    });

    it('uses factory-wide demand even with no projects in table queues or the project list', () => {
      component.proyectos = [];
      component.gruposMesas = [];
      component.selectedProyecto = {id: 1, planificacion: {modulos_por_dia: 3}} as Proyecto;
      stats.esperado.capacidad_diaria_modulos = 12;
      stats.planificacion!.modulos_por_dia = 12;
      stats.planificacion!.modulos_hoy = 0;
      render();
      expect(component.statsPeriodTarget()).toBe(9);
      expect(text('.stats-kpi-value')).toBe('0 / 9 objetivo');
    });

    it('advances actual production without subtracting it from the period target', () => {
      stats.totals.modulos_completados = 3;
      render();
      expect(text('.stats-kpi-value')).toBe('3 / 9 objetivo');
      stats.totals.modulos_completados = 11;
      render();
      expect(text('.stats-kpi-value')).toBe('11 / 9 objetivo');
    });

    it('keeps a historical target even when current deadlines have elapsed', () => {
      stats.planificacion!.modulos_por_dia = 0;
      stats.planificacion!.urgentes = 1;
      render();
      expect(text('.stats-kpi-value')).toBe('0 / 9 objetivo');
      expect(fixture.nativeElement.querySelector('.stats-planning-warning')).toBeNull();
    });

    it('shows a pending target instead of a misleading zero for unplannable projects', () => {
      stats.planificacion!.modulos_por_dia = 0;
      stats.planificacion!.sin_planificar = 1;
      stats.planificacion!.urgentes = 1;
      stats.esperado.modulos_esperados = null;
      stats.esperado.proyectos_sin_objetivo = 2;
      render();
      expect(component.statsPeriodTarget()).toBeNull();
      expect(text('.stats-kpi-value')).toBe('0 / ? objetivo');
      expect(text('.stats-kpi')).toBe('Módulos 0 / ? objetivo');
      expect(text('.stats-planning-warning')).toContain('2 proyecto(s)');
    });

    it('keeps the calculable demand visible alongside planning warnings', () => {
      stats.planificacion!.sin_planificar = 1;
      stats.esperado.proyectos_sin_objetivo = 1;
      render();
      expect(text('.stats-kpi-value')).toBe('0 / 9 objetivo');
      expect(text('.stats-planning-warning')).toContain('1 proyecto(s)');
    });

    it('shows zero demand when no projects need more production', () => {
      stats.planificacion!.modulos_por_dia = 0;
      stats.esperado.modulos_esperados = 0;
      render();
      expect(text('.stats-kpi-value')).toBe('0 / 0 objetivo');
      expect(fixture.nativeElement.querySelector('.stats-planning-warning')).toBeNull();
    });

    it('does not present a failed request as zero production and allows retry', () => {
      const request = vi.spyOn(TestBed.inject(ApiService), 'getProductionStats')
        .mockReturnValueOnce(throwError(() => new Error('unavailable')))
        .mockReturnValueOnce(of(stats));
      component.loadStats();
      render();
      expect(component.statsData).toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-kpi')).toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-empty')).toBeNull();
      expect(text('.stats-error')).toContain('No se han podido cargar');
      (fixture.nativeElement.querySelector('.stats-error button') as HTMLButtonElement).click();
      render();
      expect(request).toHaveBeenCalledTimes(2);
      expect(fixture.nativeElement.querySelector('.stats-error')).toBeNull();
      expect(text('.stats-kpi-value')).toBe('0 / 9 objetivo');
    });

    it('labels retained statistics as stale after a failed silent refresh', () => {
      vi.spyOn(TestBed.inject(ApiService), 'getProductionStats')
        .mockReturnValue(throwError(() => new Error('unavailable')));
      component.loadStats(true);
      render();
      expect(component.statsData).toBe(stats);
      expect(text('.stats-error')).toContain('últimos datos disponibles');
      expect(fixture.nativeElement.querySelectorAll('.stats-kpi').length).toBe(13);
    });

    it('ignores responses for an older selected period', () => {
      const oldRequest = new Subject<ProductionStatsResponse>();
      const newRequest = new Subject<ProductionStatsResponse>();
      vi.spyOn(TestBed.inject(ApiService), 'getProductionStats')
        .mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest);
      component.loadStats();
      component.statsFrom = '2026-09-14';
      component.loadStats();
      newRequest.next(stats);
      oldRequest.error(new Error('old range failed'));
      expect(component.statsData).toBe(stats);
      expect(component.statsError).toBe('');
    });
  });

  it('takes today and the coming week from the factory plan, never more than what is pending', () => {
    const project = {
      modulos_count: 10, modulos_completados: 0, fecha_montaje: '2026-09-08',
      planificacion: {modulos_hoy: 3, modulos_semana: 6},
    } as Proyecto;
    expect(component.getProyectoHoy(project)).toBe(3);
    expect(component.getProyectoSemana(project)).toBe(6);
    project.modulos_completados = 8;
    expect(component.getProyectoHoy(project)).toBe(2);
    expect(component.getProyectoSemana(project)).toBe(0);
    project.planificacion = undefined;
    expect(component.getProyectoHoy(project)).toBe(0);
  });

  it('draws one column per hour between the first and last production hour, with the hourly target', () => {
    const emptyTotals = (): ProductionStatsBucket => ({
      fases_completadas: 0,
      peso_malla_inicial_kg: 0,
      peso_malla_final_kg: 0,
      desperdicio_kg: 0,
      cantidad_cortes: 0,
      cantidad_refuerzos: 0,
      cantidad_zunchos: 0,
      cantidad_separadores: 0,
      cantidad_punzos: 0,
      dificultad_total: 0,
    });
    component.statsFrom = '2026-08-13';
    component.statsTo = '2026-08-13';
    component.statsData = {
      range: { from: '2026-08-13', to: '2026-08-13', working_days: 1 },
      totals: {
        ...emptyTotals(),
        modulos_completados: 2,
        horas_productivas: 4,
        modulos_por_hora: 0.5,
        kg_por_hora: 25,
      },
      por_mesa: [],
      por_dia: [],
      por_hora: [
        { ...emptyTotals(), hora: '09', modulos_completados: 1 },
        { ...emptyTotals(), hora: '07', modulos_completados: 1 },
      ],
      esperado: { capacidad_diaria_modulos: 12, modulos_esperados: 12 },
    } satisfies ProductionStatsResponse;

    const buckets = component.statsBuckets();

    expect(buckets.map(bucket => bucket.key)).toEqual(['07', '08', '09']);
    expect(buckets.map(bucket => bucket.label)).toEqual(['07h', '08h', '09h']);
    expect(buckets.map(bucket => bucket.modulos_completados)).toEqual([1, 0, 1]);
    // 12 modulos de objetivo en el dia, repartidos en una jornada de 8 horas.
    expect(buckets.every(bucket => bucket.meta_modulos === 1.5)).toBe(true);
  });

  it('keeps projects with pending validations out of the add-to-queue list', () => {
    component.proyectos = [
      { id: 1, nombre: 'Libre', modulos_count: 4, modulos_completados: 0, produccion_bloqueada: false } as Proyecto,
      { id: 2, nombre: 'Bloqueado', modulos_count: 4, modulos_completados: 0, produccion_bloqueada: true } as Proyecto,
      { id: 3, nombre: 'Terminado', modulos_count: 4, modulos_completados: 4, produccion_bloqueada: true } as Proyecto,
    ];

    expect(component.proyectosDisponibles(null).map(p => p.nombre)).toEqual(['Libre']);
    expect(component.proyectosBloqueados(null).map(p => p.nombre)).toEqual(['Bloqueado']);
  });

  describe('loose elements Excel', () => {
    const proyecto = { id: 7, nombre: 'Torre Norte', elementos_sueltos_archivo: '/media/elementos_sueltos/obra.xlsx' } as Proyecto;
    const render = () => {
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };
    const datos: ElementosSueltos = {
      nombre_archivo: 'ESN27_P1_elementos_sueltos.xlsx',
      url: '/media/elementos_sueltos/ESN27_P1_elementos_sueltos.xlsx',
      previsualizable: true,
      motivo: null,
      hojas: [
        {
          nombre: 'ELEMENTOS SUELTOS', notas: [], secciones: [
            {
              titulo: 'ARMADURA SUPLEMENTARIA PILARES INFERIOR (PRE-MODULOS)', momento: 'antes',
              columnas: ['CANTIDAD', 'DIAMETRO(mm)', 'LONGITUD(m)'], filas: [[34, 8, 0.83], [116, 8, 1.32]],
              totales: [[150, 'TOTAL', null]], total_filas: 2, recortado: false,
            },
            {
              titulo: 'ZUNCHOS DE CANTO', momento: null, columnas: ['CODIGO', 'LONGITUD(m)'],
              filas: [['ESN27_B01_P01_VC1', 4.96]], totales: [['TOTAL: 1 ud', null]], total_filas: 1, recortado: false,
            },
          ],
        },
        {
          nombre: 'Vigas', notas: ['Obra Torre Norte'], secciones: [{
            titulo: null, momento: null, columnas: ['Viga', 'Peso (kg)'], filas: [['V-01', 182.5]],
            totales: [], total_filas: 2400, recortado: true,
          }],
        },
      ],
    };

    it('sits between the plan and the documents in each project card', () => {
      component.vista = 'produccion';
      component.proyectos = [{ ...proyecto, modulos_count: 0 } as Proyecto];
      render();
      const etiquetas = Array.from(fixture.nativeElement.querySelectorAll('.project-actions button'))
        .map(boton => (boton as HTMLElement).getAttribute('aria-label'));
      expect(etiquetas.slice(-3)).toEqual(['Abrir plano PDF', 'Ver elementos sueltos', 'Descargar documentos ZIP']);
    });

    it('shows each block of the Excel with its title, header, rows and total, and offers the original', () => {
      const api = TestBed.inject(ApiService);
      const request = vi.spyOn(api, 'getElementosSueltos').mockReturnValue(of(datos));
      component.openElementosModal(proyecto);
      render();
      expect(request).toHaveBeenCalledWith(7);
      const modal: HTMLElement = fixture.nativeElement.querySelector('.elementos-modal');
      expect(modal.querySelector('h3')?.textContent).toBe('Elementos sueltos · Torre Norte');
      expect(Array.from(modal.querySelectorAll('.elementos-hojas button')).map(b => b.textContent?.trim())).toEqual(['ELEMENTOS SUELTOS', 'Vigas']);

      const secciones = Array.from(modal.querySelectorAll('.elementos-seccion')) as HTMLElement[];
      expect(secciones.map(sec => sec.querySelector('h4')?.textContent)).toEqual([
        'ARMADURA SUPLEMENTARIA PILARES INFERIOR (PRE-MODULOS)', 'ZUNCHOS DE CANTO',
      ]);
      expect(secciones[0].querySelector('.elementos-momento')?.textContent).toBe('Antes de los módulos');
      expect(secciones[1].querySelector('.elementos-momento')).toBeNull();
      // Cada bloque con su cabecera; las columnas de numeros, a la derecha.
      const cabecera = Array.from(secciones[0].querySelectorAll('th')) as HTMLElement[];
      expect(cabecera.map(th => th.textContent?.trim())).toEqual(['CANTIDAD', 'DIAMETRO(mm)', 'LONGITUD(m)']);
      expect(cabecera.map(th => th.classList.contains('num'))).toEqual([true, true, true]);
      expect(Array.from(secciones[1].querySelectorAll('th')).map(th => th.textContent?.trim())).toEqual(['CODIGO', 'LONGITUD(m)']);
      expect(Array.from(secciones[0].querySelectorAll('tbody tr:first-child td')).map(td => td.textContent?.trim())).toEqual(['34', '8', '0.83']);
      // La fila de TOTAL va como pie de su tabla.
      expect(Array.from(secciones[0].querySelectorAll('tfoot td')).map(td => td.textContent?.trim())).toEqual(['150', 'TOTAL', '']);
      expect(secciones[1].querySelector('tfoot td')?.textContent?.trim()).toBe('TOTAL: 1 ud');

      const descarga = modal.querySelector('.elementos-descargar') as HTMLAnchorElement;
      expect(descarga.getAttribute('href')).toContain('/media/elementos_sueltos/ESN27_P1_elementos_sueltos.xlsx');
      expect(descarga.getAttribute('download')).toBe('ESN27_P1_elementos_sueltos.xlsx');

      (modal.querySelectorAll('.elementos-hojas button')[1] as HTMLButtonElement).click();
      render();
      expect(modal.querySelector('.elementos-nota')?.textContent).toBe('Obra Torre Norte');
      expect(modal.querySelector('.elementos-seccion h4')).toBeNull();
      expect(Array.from(modal.querySelectorAll('th')).map(th => th.textContent?.trim())).toEqual(['Viga', 'Peso (kg)']);
      expect(modal.querySelector('.elementos-pie')?.textContent?.trim()).toBe('Se muestran 1 de 2400 filas; el resto está en el Excel.');

      component.closeElementosModal();
      render();
      expect(fixture.nativeElement.querySelector('.elementos-modal')).toBeNull();
    });

    it('explains when the Excel cannot be shown and still lets it be downloaded', () => {
      const api = TestBed.inject(ApiService);
      vi.spyOn(api, 'getElementosSueltos').mockReturnValue(of({
        ...datos, nombre_archivo: 'antiguo.xls', url: '/media/elementos_sueltos/antiguo.xls', previsualizable: false,
        motivo: 'Este Excel está en formato antiguo (.xls) y no se puede ver aquí. Descárgalo para abrirlo.', hojas: [],
      }));
      component.openElementosModal(proyecto);
      render();
      const modal: HTMLElement = fixture.nativeElement.querySelector('.elementos-modal');
      expect(modal.querySelector('.elementos-aviso')?.textContent).toContain('formato antiguo (.xls)');
      expect(modal.querySelector('table')).toBeNull();
      expect(modal.querySelector('.elementos-descargar')?.getAttribute('href')).toContain('antiguo.xls');
    });

    it('keeps the download when the server cannot read the Excel, and needs a file to open', () => {
      const api = TestBed.inject(ApiService);
      const request = vi.spyOn(api, 'getElementosSueltos').mockReturnValue(throwError(() => new Error('500')));
      component.openElementosModal({ ...proyecto, elementos_sueltos_archivo: null });
      expect(request).not.toHaveBeenCalled();
      expect(component.elementosModalProyecto).toBeNull();

      component.openElementosModal(proyecto);
      render();
      const modal: HTMLElement = fixture.nativeElement.querySelector('.elementos-modal');
      expect(modal.querySelector('.elementos-aviso')?.textContent).toContain('No se ha podido cargar el Excel');
      expect(modal.querySelector('.elementos-descargar')?.getAttribute('href')).toContain('/media/elementos_sueltos/obra.xlsx');
    });
  });

  describe('two dashboards on one component', () => {
    it('shows only the statistics on the statistics view and only the mesas and projects on production', () => {
      component.loadingGruposMesas = false;
      component.loadingMesas = false;
      component.vista = 'estadisticas';
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stats-section')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.planner-section')).toBeNull();
      expect(fixture.nativeElement.querySelector('.projects-section')).toBeNull();
      expect(fixture.nativeElement.querySelector('.nav-link.active')?.textContent?.trim()).toBe('Estadísticas');

      component.vista = 'produccion';
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.stats-section')).toBeNull();
      expect(fixture.nativeElement.querySelector('.planner-section')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.projects-section')).not.toBeNull();
    });
  });

  describe('working schedule owned by the ferralla', () => {
    const jornada = (days: string[], start = '06:50', end = '15:00') =>
      days.map(day => ({day: day as any, start_time: start, end_time: end}));
    const config = (extra: Partial<FerrallaCaptureConfig> = {}): FerrallaCaptureConfig => ({
      user_id: 1, active_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start_time: '06:50', end_time: '15:00',
      horario: jornada(['MON', 'TUE', 'WED', 'THU', 'FRI']),
      interval_seconds: 20, check_times: [], capture_window: {start_time: '06:20', end_time: '15:30'}, mesas: [], ...extra,
    });

    it('describes the week by runs of days sharing the same hours, without the camera window', () => {
      component.horario = config();
      expect(component.horarioLabel()).toBe('Lun–Vie 06:50–15:00');
      component.horario = config({horario: [...jornada(['MON', 'TUE', 'WED', 'THU']), ...jornada(['FRI'], '06:50', '13:00')]});
      expect(component.horarioLabel()).toBe('Lun–Jue 06:50–15:00 · Vie 06:50–13:00');
      component.horario = config({horario: jornada(['MON', 'WED', 'FRI'])});
      expect(component.horarioLabel()).toBe('Lun 06:50–15:00 · Mié 06:50–15:00 · Vie 06:50–15:00');
      component.horario = config({horario: []});
      expect(component.horarioLabel()).toBe('Sin días de trabajo');
    });

    it('saves days and hours for the ferralla and refreshes the statistics', () => {
      const api = TestBed.inject(ApiService);
      component.gruposMesas = [{
        id: 1, nombre: 'Grupo', usuario: 42, proyecto_actual: null, proyectos_cola: [], estrategia_cola_superior: 'PLANIFICADA',
        activa: true, created_at: '', mesas: [],
      } as GrupoMesas];
      component.horario = config();
      const update = vi.spyOn(api, 'updateFerrallaCaptureConfig')
        .mockReturnValue(of(config({horario: [...jornada(['MON', 'TUE', 'WED', 'THU']), ...jornada(['FRI'], '06:50', '13:00')]})));
      vi.spyOn(component, 'loadStats').mockImplementation(() => undefined);
      vi.spyOn(component as any, 'silentRefreshProyectosAndStats').mockImplementation(() => undefined);

      component.editHorario();
      expect(component.horarioDraft.map(f => f.activo)).toEqual([true, true, true, true, true, false, false]);
      // El viernes acaba antes; el sabado se activa y hereda la jornada de referencia.
      component.horarioDraft[4].end_time = '13:00';
      component.toggleHorarioDay('SAT');
      component.horarioDraft[5].start_time = '08:00';
      component.horarioDraft[5].end_time = '12:00';
      component.saveHorario();

      expect(update).toHaveBeenCalledWith(42, {
        horario: [
          ...jornada(['MON', 'TUE', 'WED', 'THU']),
          {day: 'FRI', start_time: '06:50', end_time: '13:00'},
          {day: 'SAT', start_time: '08:00', end_time: '12:00'},
        ],
        interval_seconds: 20,
        rotations: [],
      });
      expect(component.horarioEditing).toBe(false);
      expect(component.horarioLabel()).toBe('Lun–Jue 06:50–15:00 · Vie 06:50–13:00');
      expect(component.loadStats).toHaveBeenCalled();
    });

    it('edits the schedule in a modal instead of inline', () => {
      component.loadingGruposMesas = false;
      component.loadingMesas = false;
      component.vista = 'estadisticas';
      component.horario = config();
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.horario-modal')).toBeNull();
      component.editHorario();
      fixture.detectChanges();
      const modal: HTMLElement = fixture.nativeElement.querySelector('.horario-modal');
      expect(modal).not.toBeNull();
      expect(modal.querySelectorAll('.horario-dia').length).toBe(7);
      expect(fixture.nativeElement.querySelector('.stats-header .stats-schedule-form')).toBeNull();
      component.cancelHorario();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.horario-modal')).toBeNull();
    });

    it('copies one day\'s hours to every other active day', () => {
      component.horario = config();
      component.editHorario();
      component.horarioDraft[0].start_time = '07:30';
      component.horarioDraft[0].end_time = '14:30';
      component.copiarHorarioA('MON');
      expect(component.horarioDraft.filter(f => f.activo).every(f => f.start_time === '07:30' && f.end_time === '14:30')).toBe(true);
      expect(component.horarioDraft[5].start_time).toBe('06:50');
    });

    it('refuses an end hour before the start hour without calling the API', () => {
      const api = TestBed.inject(ApiService);
      component.gruposMesas = [{
        id: 1, nombre: 'Grupo', usuario: 42, proyecto_actual: null, proyectos_cola: [], estrategia_cola_superior: 'PLANIFICADA',
        activa: true, created_at: '', mesas: [],
      } as GrupoMesas];
      component.horario = config();
      const update = vi.spyOn(api, 'updateFerrallaCaptureConfig');
      component.editHorario();
      component.horarioDraft[4].end_time = '06:00';
      expect(component.horarioDraftValido()).toBe(false);
      component.saveHorario();
      expect(update).not.toHaveBeenCalled();
      expect(component.horarioError).toBe('Vie: la hora de fin tiene que ser posterior a la de inicio.');
    });
  });

  describe('project modal bastidores', () => {
    const grupo = (
      id: number, indice: number, extra: Partial<GrupoBastidor>, modulos: Array<Partial<GrupoBastidorModulo>>,
    ): GrupoBastidor => ({
      id, proyecto: 7, indice, nombre: '', created_at: '', modulos: modulos as GrupoBastidorModulo[],
      longitud_total_cm: 0, capacidad_cm: 114, peso_total_kg: 0, capacidad_peso_kg: null, peso_desconocido: false,
      overflow_longitud: false, overflow_peso: false, overflow: false, ...extra,
    });

    beforeEach(() => {
      component.showPlanModal = true;
      component.planModalProyecto = {id: 7, nombre: 'Proyecto', modulos_count: 4} as Proyecto;
      component.planModalModulos = [
        {id: 1, nombre: 'A1', grupo_bastidor: 10, inferior_hecho: false, superior_hecho: false} as Modulo,
        {id: 2, nombre: 'A2', grupo_bastidor: 10, inferior_hecho: false, superior_hecho: false} as Modulo,
        {id: 3, nombre: 'A3', grupo_bastidor: 10, inferior_hecho: true, superior_hecho: true, estado: 'COMPLETADO'} as Modulo,
        {id: 4, nombre: 'B1', grupo_bastidor: 11, inferior_hecho: false, superior_hecho: false} as Modulo,
        {id: 5, nombre: 'Z9', grupo_bastidor: null, inferior_hecho: false, superior_hecho: false} as Modulo,
      ];
      component.planModalGrupos = [
        grupo(10, 1, {etiqueta: 'Grupo 1', dividido: false, es_division: false}, [
          {id: 1, nombre: 'A1', movible: true}, {id: 2, nombre: 'A2', movible: true}, {id: 3, nombre: 'A3', movible: false},
        ]),
        grupo(11, 2, {etiqueta: 'Grupo 2', dividido: false, es_division: false}, [{id: 4, nombre: 'B1', movible: true}]),
      ];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    });

    it('lists every bastidor in fabrication order, then the loose modules', () => {
      // Sin grupos de mesas conocidos todo cae en una unica columna.
      expect(fixture.nativeElement.querySelectorAll('.plan-mesa').length).toBe(1);
      const secciones: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.plan-grupo');
      expect(Array.from(secciones).map(s => s.querySelector('.plan-grupo-title strong')?.textContent))
        .toEqual(['Grupo 1', 'Grupo 2', 'Sin bastidor']);
      // El card del admin se fabrica de abajo arriba: A3 (hecho) sale primero.
      expect(Array.from(secciones[0].querySelectorAll('.plan-modulo-nombre')).map(e => e.textContent?.trim()))
        .toEqual(['A3', 'A2', 'A1']);
      expect(secciones[0].querySelector('[aria-label="Dividir Grupo 1 entre mesas"]')).not.toBeNull();
      expect(secciones[0].querySelector('[aria-label="Unir Grupo 1"]')).toBeNull();
      expect(secciones[2].querySelector('.plan-modulo-order')).toBeNull();
    });

    it('only lets pending modules swap with pending neighbours', () => {
      const [g1] = component.planModalGrupos;
      const [a1, a2, a3] = component.planModalModulos;
      expect(component.canMoveModulo(g1, a3, 1)).toBe(false);
      expect(component.canMoveModulo(g1, a2, -1)).toBe(false);
      expect(component.canMoveModulo(g1, a2, 1)).toBe(true);
      expect(component.canMoveModulo(g1, a1, -1)).toBe(true);
      expect(component.canMoveModulo(g1, a1, 1)).toBe(false);
    });

    it('moves a module earlier in fabrication using the card index the backend expects', () => {
      const api = TestBed.inject(ApiService);
      const move = vi.spyOn(api, 'moveModuloEntreBastidores').mockReturnValue(of(component.planModalGrupos));
      vi.spyOn(api, 'getProyectoModulos').mockReturnValue(of(component.planModalModulos));
      vi.spyOn(component, 'loadMesas').mockImplementation(() => undefined);
      vi.spyOn(component as any, 'silentRefreshProyectosAndStats').mockImplementation(() => undefined);

      const [g1] = component.planModalGrupos;
      component.moveModuloEnPlan(g1, component.planModalModulos[0], -1);

      // A1 pasa de fabricarse el ultimo a fabricarse antes que A2: en el card
      // (arriba abajo) queda entre A2 y A3, posicion 1.
      expect(move).toHaveBeenCalledWith(1, 10, 1);
      expect(component.planModalBusy).toBe(false);
    });

    it('reorders root bastidores with the arrows and shows the backend error', () => {
      const api = TestBed.inject(ApiService);
      const reorder = vi.spyOn(api, 'reorderBastidores').mockReturnValue(throwError(() => ({error: {detail: 'No hay mesas'}})));
      const [g1, g2] = component.planModalGrupos;
      expect(component.canMoveGrupo(g1, -1)).toBe(false);
      component.moveGrupoEnPlan(g2, -1);
      expect(reorder).toHaveBeenCalledWith(7, [11, 10]);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.plan-modal-error')?.textContent).toBe('No hay mesas');
    });

    it('shows one column per active inferior mesa and moves a bastidor sideways', () => {
      component.gruposMesas = [{
        id: 1, nombre: 'Grupo mesas', usuario: 1, proyecto_actual: 7, proyectos_cola: [], estrategia_cola_superior: 'PLANIFICADA',
        activa: true, created_at: '',
        mesas: [
          {id: 2, nombre: 'Mesa 2', tipo: 'INFERIOR', indice: 2, activa: true, is_linked: false},
          {id: 1, nombre: 'Mesa 1', tipo: 'INFERIOR', indice: 1, activa: true, is_linked: false},
          {id: 3, nombre: 'Mesa 3', tipo: 'SUPERIOR', indice: 3, activa: true, is_linked: false},
          {id: 4, nombre: 'Mesa 4', tipo: 'INFERIOR', indice: 4, activa: false, is_linked: false},
        ],
      } as GrupoMesas];
      component.planModalGrupos = [
        grupo(10, 1, {etiqueta: 'Grupo 1', mesa_actual: 1}, [{id: 1, nombre: 'A1', movible: true}]),
        grupo(11, 2, {etiqueta: 'Grupo 2', mesa_actual: 2}, [{id: 4, nombre: 'B1', movible: true}]),
        grupo(12, 3, {etiqueta: 'Grupo 3', mesa_actual: null}, [{id: 2, nombre: 'A2', movible: true}]),
      ];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const columnas: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.plan-mesa:not(.plan-mesa-sup)');
      expect(Array.from(columnas).map(c => c.querySelector('.plan-mesa-header strong')?.textContent)).toEqual(['Mesa 1', 'Mesa 2']);
      const titulos = (c: HTMLElement) => Array.from(c.querySelectorAll('.plan-grupo-title strong')).map(e => e.textContent);
      // Sin mesa conocida cae en la primera; los sueltos tambien.
      expect(titulos(columnas[0])).toEqual(['Grupo 1', 'Grupo 3', 'Sin bastidor']);
      expect(titulos(columnas[1])).toEqual(['Grupo 2']);
      const [g1, g2] = component.planModalGrupos;
      expect(component.canMoverBastidorAMesa(g1, -1)).toBe(false);
      expect(component.canMoverBastidorAMesa(g2, 1)).toBe(false);
      // Arriba y abajo solo entre vecinos de la misma mesa.
      expect(component.canMoveGrupo(g2, -1)).toBe(false);
      expect(component.canMoveGrupo(g1, 1)).toBe(true);

      const api = TestBed.inject(ApiService);
      const llevar = vi.spyOn(api, 'llevarBastidorAMesa').mockReturnValue(throwError(() => ({error: {detail: 'x'}})));
      component.moverBastidorAMesa(g1, 1);
      expect(llevar).toHaveBeenCalledWith(10, 2);
    });

    it('lists the superior mesa queue of the project and reorders it by hand', () => {
      const api = TestBed.inject(ApiService);
      component.gruposMesas = [{
        id: 1, nombre: 'Grupo mesas', usuario: 1, proyecto_actual: 7, proyectos_cola: [], estrategia_cola_superior: 'ADAPTATIVA',
        activa: true, created_at: '',
        mesas: [
          {id: 1, nombre: 'Mesa 1', tipo: 'INFERIOR', indice: 1, activa: true, is_linked: false},
          {id: 3, nombre: 'Mesa 3', tipo: 'SUPERIOR', indice: 3, activa: true, is_linked: false},
        ],
      } as GrupoMesas];
      const sup = (id: number, nombre: string, position: number, status: 'MOSTRANDO' | 'EN_COLA', proyecto = 7) => ({
        id, mesa: 3, modulo: id, modulo_nombre: nombre, modulo_proyecto_id: proyecto, fase: 'SUPERIOR', position, status,
        current_image_index: 2, imagenes_total: 16, grupo_bastidor_indice: 1,
      } as unknown as MesaQueueItem);
      component.mesaQueueItems.set(3, [sup(31, 'A1', 0, 'MOSTRANDO'), sup(32, 'A2', 1, 'EN_COLA'), sup(99, 'Z1', 2, 'EN_COLA', 8), sup(33, 'A3', 3, 'EN_COLA')]);
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();

      const columna: HTMLElement = fixture.nativeElement.querySelector('.plan-mesa-sup');
      expect(columna).not.toBeNull();
      expect(Array.from(columna.querySelectorAll('.plan-modulo-nombre')).map(e => e.textContent?.trim())).toEqual(['A1', 'A2', 'A3']);
      expect(columna.querySelector('.plan-sup-modo')?.textContent).toBe('Automático · adaptativo');
      expect(columna.querySelector('[aria-label="Volver al orden automático en Mesa 3"]')).toBeNull();

      const [col] = component.planModalSuperiores();
      expect(component.canMoverSupItem(col, col.items[0], 1)).toBe(false);
      expect(component.canMoverSupItem(col, col.items[1], -1)).toBe(false);
      expect(component.canMoverSupItem(col, col.items[2], -1)).toBe(true);

      const reorder = vi.spyOn(api, 'reorderMesaQueue').mockReturnValue(of({status: 'ok'}));
      vi.spyOn(component, 'loadMesaQueueItems').mockImplementation(() => undefined);
      vi.spyOn(component, 'loadGruposMesas').mockImplementation(() => undefined);
      component.moverSupItem(col, col.items[2], -1);
      // A3 pasa delante de A2; el modulo del otro proyecto conserva su sitio relativo.
      expect(reorder).toHaveBeenCalledWith([
        {id: 31, position: 0}, {id: 33, position: 1}, {id: 32, position: 2}, {id: 99, position: 3},
      ]);
    });

    it('offers the way back to the automatic order when the superior mesa is manual', () => {
      const api = TestBed.inject(ApiService);
      component.gruposMesas = [{
        id: 1, nombre: 'Grupo mesas', usuario: 1, proyecto_actual: 7, proyectos_cola: [], estrategia_cola_superior: 'MANUAL',
        estrategia_cola_superior_previa: 'ADAPTATIVA', activa: true, created_at: '',
        mesas: [{id: 3, nombre: 'Mesa 3', tipo: 'SUPERIOR', indice: 3, activa: true, is_linked: false}],
      } as GrupoMesas];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const columna: HTMLElement = fixture.nativeElement.querySelector('.plan-mesa-sup');
      expect(columna.querySelector('.plan-sup-modo')?.textContent).toBe('Orden manual');
      const update = vi.spyOn(api, 'updateGrupoMesas').mockReturnValue(of({} as GrupoMesas));
      vi.spyOn(component, 'loadMesaQueueItems').mockImplementation(() => undefined);
      vi.spyOn(component, 'loadGruposMesas').mockImplementation(() => undefined);
      component.volverSupAutomatico(component.planModalSuperiores()[0]);
      expect(update).toHaveBeenCalledWith(1, {estrategia_cola_superior: 'ADAPTATIVA'});
    });

    it('stacks finished bastidores at the top of their mesa, folded until asked', () => {
      component.planModalModulos = [
        {id: 1, nombre: 'A1', grupo_bastidor: 10, inferior_hecho: true, superior_hecho: true, estado: 'COMPLETADO'} as Modulo,
        {id: 4, nombre: 'B1', grupo_bastidor: 11, inferior_hecho: false, superior_hecho: false} as Modulo,
      ];
      component.planModalGrupos = [
        grupo(11, 1, {etiqueta: 'Grupo 1'}, [{id: 4, nombre: 'B1', movible: true}]),
        grupo(10, 2, {etiqueta: 'Grupo 2'}, [{id: 1, nombre: 'A1', movible: false}]),
      ];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const columna: HTMLElement = fixture.nativeElement.querySelector('.plan-mesa');
      expect(Array.from(columna.querySelectorAll('.plan-grupo-title strong')).map(e => e.textContent)).toEqual(['Grupo 1']);
      expect(columna.querySelector('.plan-mesa-done')?.textContent?.trim()).toBe('1 terminado');

      component.togglePlanModalDone();
      fixture.detectChanges();
      expect(Array.from(columna.querySelectorAll('.plan-grupo-title strong')).map(e => e.textContent)).toEqual(['Grupo 2', 'Grupo 1']);
      expect(columna.querySelector('.plan-grupo')?.classList.contains('is-terminado')).toBe(true);
    });

    it('keeps bastidores on hold at the bottom of their mesa with a release button', () => {
      component.planModalModulos = [
        {id: 1, nombre: 'A1', grupo_bastidor: 10, inferior_hecho: false, superior_hecho: false} as Modulo,
        {id: 4, nombre: 'B1', grupo_bastidor: 11, inferior_hecho: false, superior_hecho: false} as Modulo,
      ];
      component.planModalGrupos = [
        grupo(10, 1, {etiqueta: 'Grupo 1', en_espera: true}, [{id: 1, nombre: 'A1', movible: true}]),
        grupo(11, 2, {etiqueta: 'Grupo 2', en_espera: false}, [{id: 4, nombre: 'B1', movible: true}]),
      ];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const columna: HTMLElement = fixture.nativeElement.querySelector('.plan-mesa');
      expect(Array.from(columna.querySelectorAll('.plan-grupo-title strong')).map(e => e.textContent))
        .toEqual(['Grupo 2', 'Grupo 1']);
      const apartado = columna.querySelectorAll('.plan-grupo')[1];
      expect(apartado.classList.contains('is-espera')).toBe(true);
      expect(apartado.querySelector('.plan-grupo-tag')?.textContent).toBe('En espera');
      expect(apartado.querySelector('[aria-label="Soltar Grupo 1"]')).not.toBeNull();
      expect(columna.querySelector('[aria-label="Apartar Grupo 2"]')).not.toBeNull();

      const api = TestBed.inject(ApiService);
      const espera = vi.spyOn(api, 'esperaBastidor').mockReturnValue(throwError(() => ({error: {detail: 'x'}})));
      component.toggleEsperaEnPlan(component.planModalGrupos[0]);
      expect(espera).toHaveBeenCalledWith(10, false);
    });

    it('offers merge instead of split on a divided bastidor and its parts', () => {
      component.planModalGrupos = [
        grupo(10, 1, {etiqueta: 'Grupo 1', dividido: true, es_division: false}, [{id: 1, nombre: 'A1', movible: true}]),
        grupo(12, 1, {etiqueta: 'Grupo 1B', dividido: false, es_division: true, sufijo: 'B', dividido_de: 10}, [{id: 2, nombre: 'A2', movible: true}]),
      ];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const secciones: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.plan-grupo');
      expect(secciones[0].querySelector('[aria-label="Unir Grupo 1"]')).not.toBeNull();
      expect(secciones[0].querySelector('[aria-label="Dividir Grupo 1 entre mesas"]')).toBeNull();
      expect(secciones[1].classList.contains('is-division')).toBe(true);
      expect(secciones[1].querySelector('[aria-label="Unir Grupo 1B"]')).not.toBeNull();
      expect(secciones[1].querySelector('.plan-order-btn')).not.toBeNull();
      expect(secciones[1].querySelector('.plan-grupo-actions .plan-order-btn')).toBeNull();
    });
  });

  describe('project modal phase details', () => {
    beforeEach(() => {
      component.showPlanModal = true;
      component.planModalProyecto = {id: 7, nombre: 'Test project', modulos_count: 2} as Proyecto;
      component.planModalModulos = [
        {
          id: 1, nombre: 'A01', estado: 'EN_PROGRESO', inferior_hecho: true,
          superior_hecho: false, inferior_completado_at: '2026-09-04T10:30:00Z',
          fotos_count: 3,
        } as Modulo,
        {id: 2, nombre: 'B01', estado: 'COMPLETADO', inferior_hecho: true, superior_hecho: true} as Modulo,
      ];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    });

    it('shows each phase as a compact pill that only resets finished work', () => {
      const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.plan-modulo-row');
      expect(rows.length).toBe(2);
      const phases = rows[0].querySelectorAll('.plan-modulo-phase');
      expect(phases.length).toBe(2);
      expect(phases[0].tagName).toBe('BUTTON');
      expect(phases[0].textContent?.trim()).toBe('INF');
      expect(phases[0].getAttribute('title')).toContain('Inferior terminada · 04/09/2026');
      expect(phases[0].getAttribute('aria-label')).toBe('Reiniciar fase inferior de A01');
      // La superior de A01 esta pendiente: no hay nada que reiniciar.
      expect(phases[1].tagName).toBe('SPAN');
      expect(phases[1].getAttribute('title')).toBe('Superior pendiente');
      const doneWithoutDate = rows[1].querySelectorAll('.plan-modulo-phase');
      expect(doneWithoutDate[1].getAttribute('title')).toContain('fecha no registrada');
      expect(rows[0].querySelector('.plan-modulo-action')).not.toBeNull();
    });

    it('opens confirmation only for the selected phase and cancels without changing its counterpart', () => {
      const button: HTMLButtonElement = fixture.nativeElement.querySelector('[aria-label="Reiniciar fase inferior de A01"]');
      button.click();
      fixture.detectChanges();
      expect(component.phaseResetTarget?.phase).toBe('INFERIOR');
      expect(component.phaseResetTarget?.module.id).toBe(1);
      expect(fixture.nativeElement.querySelector('.phase-reset-modal')).not.toBeNull();
      const cancel: HTMLButtonElement = fixture.nativeElement.querySelector('.phase-reset-actions button');
      cancel.click();
      fixture.detectChanges();
      expect(component.phaseResetTarget).toBeNull();
      expect(component.planModalModulos[0].inferior_hecho).toBe(true);
      expect(component.showPlanModal).toBe(true);
    });

    it('disables every phase reset action while a reset is in progress', () => {
      component.resettingPhase = true;
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll('button.plan-modulo-phase');
      expect(buttons.length).toBe(3);
      expect(Array.from(buttons).every(button => button.disabled)).toBe(true);
    });

    it('lets a phase that is being projected be reset even before it is done', () => {
      component.planModalGrupos = [{
        id: 10, proyecto: 7, indice: 1, nombre: '', created_at: '', etiqueta: 'Grupo 1', dividido: false, es_division: false,
        modulos: [{id: 1, nombre: 'A01', movible: true, superior_en_curso: true} as GrupoBastidorModulo],
        longitud_total_cm: 0, capacidad_cm: 114, peso_total_kg: 0, capacidad_peso_kg: null, peso_desconocido: false,
        overflow_longitud: false, overflow_peso: false, overflow: false,
      }];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const pill: HTMLElement = fixture.nativeElement.querySelector('[aria-label="Reiniciar fase superior de A01"]');
      expect(pill).not.toBeNull();
      expect(pill.classList.contains('is-en-curso')).toBe(true);
      expect(pill.getAttribute('title')).toBe('Superior en curso. Clic para reiniciar');
    });
  });

  it('does not conflate an old player heartbeat with an unavailable camera', () => {
    const mesa = {
      is_linked: true,
      capture_service_online: true,
      last_seen: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    } as Mesa;

    expect(component.isMesaCameraUnavailable(mesa)).toBe(false);
  });

  it('warns only when a linked mesa explicitly reports its capture service offline', () => {
    const mesa = { is_linked: true, capture_service_online: false } as Mesa;
    const unlinkedMesa = { is_linked: false, capture_service_online: false } as Mesa;

    expect(component.isMesaCameraUnavailable(mesa)).toBe(true);
    expect(component.isMesaCameraUnavailable(unlinkedMesa)).toBe(false);
  });

});
