import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Dashboard } from './dashboard';
import {
  ApiService, FerrallaCaptureConfig, GrupoBastidor, GrupoBastidorModulo, GrupoMesas, Mesa, MesaQueueItem, Modulo, Proyecto,
  ProductionStatsBucket, ProductionStatsDay, ProductionStatsModuloFase, ProductionStatsResponse, ElementosSueltos,
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
        esperado: {ritmo_necesario: 9, modulos_esperados: 9, proyectos_sin_objetivo: 0},
        planificacion: {modulos_por_dia: 9, modulos_hoy: 9, sin_planificar: 0, urgentes: 0, proyectos: []},
      };
      component.statsData = stats;
      component.statsFrom = stats.range.from;
      component.statsTo = stats.range.to;
    });

    it('shows the kilos per man-hour from the people of each shift, or a dash without people', () => {
      stats.totals.horas_hombre = 48;
      stats.totals.kg_por_hora_hombre = 12.34;
      render();
      // Las horas-hombre ya no son una casilla: van en la explicacion de los kilos por hora-hombre.
      expect(fixture.nativeElement.querySelector('.stats-kpi-kg-hombre').getAttribute('title')).toContain('48 horas-hombre en el período');
      expect(text('.stats-kpi[title^="Kilos fabricados por cada hora de cada persona"] .stats-kpi-value')).toBe('12.3 kg/h·persona');
      stats.totals.horas_hombre = 0;
      stats.totals.kg_por_hora_hombre = null;
      render();
      expect(text('.stats-kpi[title^="Kilos fabricados por cada hora de cada persona"] .stats-kpi-value')).toBe('— kg/h·persona');
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

    it('shows the hours as work plus dead time, in yellow, and the rates over the worked hours', () => {
      stats.totals.modulos_completados = 1;
      stats.totals.horas_productivas = 132;
      stats.totals.horas_trabajo = 48;
      stats.totals.horas_muertas = 84;
      stats.totals.horas_fuera_turno = 2.5;
      stats.totals.modulos_por_hora = 0.83;
      stats.totals.modulos_por_hora_trabajo = 2.3;
      stats.totals.kg_por_hora = 100;
      stats.totals.kg_por_hora_trabajo = 275;
      stats.muerto_por_causa = {sin_registro: 30, empezo_tarde: 20.5, acabo_pronto: 0, paradas: 33.5};
      stats.criterio = {version: 'v1', umbral_min: 20, umbral_fotos_min: 45, sin_pulsar_min: 90};
      render();
      expect(text('.stats-kpi-horas .stats-kpi-value')).toBe('48 h + 84 h muertas');
      expect(text('.stats-kpi-horas .stats-muerto')).toBe('+ 84 h muertas');
      expect(fixture.nativeElement.querySelector('.stats-kpi-horas').getAttribute('title'))
        .toContain('Incluye 2.5 h trabajadas fuera de turno');
      // Solo el dato por hora de trabajo; el de turno se ve eligiendo el turno.
      expect(text('.stats-kpi-ritmo-modulos .stats-kpi-value')).toBe('2.3 mód./h');
      expect(text('.stats-kpi-ritmo-peso .stats-kpi-value')).toBe('275 kg/h');
      // En que se fue el tiempo muerto no se detalla.
      expect(fixture.nativeElement.querySelector('.stats-muerto-causas')).toBeNull();
      // Modulos con dificultad (1), peso y desperdicio (1), turno trabajado y tiempo por panel (2).
      expect(fixture.nativeElement.querySelectorAll('app-stats-line-chart').length).toBe(4);
      expect(fixture.nativeElement.querySelector('app-stats-line-chart.stats-chart-turno')).not.toBeNull();
      expect(text('.stats-criterio')).toContain('van a menos de 20 min');
      expect(text('.stats-criterio')).toContain('hueco de hasta 90 min');
      // Sin trabajo detectado no hay ritmo "por hora de trabajo" que enseñar.
      stats.totals.horas_trabajo = 0;
      stats.totals.modulos_por_hora_trabajo = 0;
      render();
      expect(text('.stats-kpi-ritmo-modulos .stats-kpi-value')).toBe('0.83 mód./h');
      // Un servidor sin actividad: las horas de jornada y los ritmos de siempre, sin columnas ni gráfica vacías.
      delete stats.totals.horas_trabajo;
      delete stats.totals.modulos_por_hora_trabajo;
      delete stats.totals.kg_por_hora_trabajo;
      delete stats.muerto_por_causa;
      render();
      expect(text('.stats-kpi-horas')).toBe('Horas de jornada 132 h');
      expect(text('.stats-kpi-ritmo-modulos .stats-kpi-value')).toBe('0.83 mód./h');
      expect(text('.stats-kpi-ritmo-peso .stats-kpi-value')).toBe('100 kg/h');
      expect(fixture.nativeElement.querySelector('.stats-muerto-causas')).toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-fila-trabajo')).toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-mesa-muerto')).toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-criterio')).toBeNull();
      expect(fixture.nativeElement.querySelectorAll('app-stats-line-chart').length).toBe(3);
      expect(fixture.nativeElement.querySelector('app-stats-line-chart.stats-chart-turno')).toBeNull();
    });

    it('keeps the work and dead time tables when the shift has run but nothing was finished yet', () => {
      stats.totals.horas_productivas = 2;
      stats.totals.horas_trabajo = 1.8;
      stats.totals.horas_muertas = 0.2;
      stats.criterio = {version: 'v1', umbral_min: 20, umbral_fotos_min: 45};
      render();
      expect(fixture.nativeElement.querySelector('.stats-empty')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-table-periodos')).not.toBeNull();
      expect(text('.stats-criterio')).toContain('Criterio v1');
      // Sin actividad del servidor, ni tablas ni nota del criterio.
      delete stats.totals.horas_trabajo;
      render();
      expect(fixture.nativeElement.querySelector('.stats-table-periodos')).toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-criterio')).toBeNull();
    });

    it('shows the hours of a single day per hour in minutes and a week without any signal as sin registro', () => {
      const vacio = () => ({
        fases_completadas: 0, peso_total_kg: 0, peso_malla_inicial_kg: 0, peso_malla_final_kg: 0, desperdicio_kg: 0,
        cantidad_cortes: 0, cantidad_refuerzos: 0, cantidad_zunchos: 0, cantidad_separadores: 0, cantidad_punzos: 0,
        dificultad_total: 0,
      });
      stats.totals.modulos_completados = 1;
      stats.totals.horas_trabajo = 0.5;
      stats.range = {from: '2026-09-14', to: '2026-09-14', working_days: 1, horas: ['07', '08']};
      stats.por_hora = [
        {...vacio(), hora: '07', modulos_completados: 1, minutos_turno: 60, minutos_trabajo: 2, minutos_muertos: 58},
        {...vacio(), hora: '08', modulos_completados: 0, minutos_turno: 60, minutos_trabajo: 45, minutos_muertos: 15},
      ];
      component.statsFrom = '2026-09-14';
      component.statsTo = '2026-09-14';
      let vista = component.statsVista()!;
      expect([vista.horasUnidad, vista.conSenales]).toEqual(['min', false]);
      // Del turno de cada hora, la parte trabajada.
      expect(vista.horas[0].values.map(v => Math.round(v!))).toEqual([3, 75]);
      expect(vista.horas[0].tooltips![1]).toBe('75 % · 45 min de trabajo + 15 min muertas');
      render();
      let filas = Array.from(fixture.nativeElement.querySelectorAll('.stats-table-periodos tbody tr')) as HTMLElement[];
      const celda = (fila: HTMLElement, selector: string) => fila.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
      expect(celda(filas[0], '.stats-fila-trabajo')).toBe('2 min');
      expect(celda(filas[0], '.stats-fila-muerto')).toBe('58 min');
      expect(filas[0].querySelector('.stats-fila-muerto')?.getAttribute('title')).toBe('Turno de 60 min: 2 min de trabajo + 58 min muertas');
      expect(filas[0].querySelector('.stats-fila-senales')).toBeNull();

      // Dos meses: por semana. La primera, toda sin señal; la segunda, solo un dia.
      const dia = (fecha: string, extra: Partial<ProductionStatsDay>): ProductionStatsDay => ({
        ...vacio(), fecha, modulos_completados: 0, horas_turno: 10, horas_trabajo: 0, horas_muertas: 10, sin_registro: true,
        causas: {sin_registro: 10, empezo_tarde: 0, acabo_pronto: 0, paradas: 0}, ...extra,
      });
      stats.range = {from: '2026-08-03', to: '2026-10-02', working_days: 45};
      stats.por_hora = undefined;
      stats.por_dia = [
        dia('2026-08-03', {}), dia('2026-08-04', {}),
        dia('2026-08-10', {}), dia('2026-08-11', {
          modulos_completados: 1, horas_trabajo: 6, horas_muertas: 4, sin_registro: false,
          causas: {sin_registro: 0, empezo_tarde: 1, acabo_pronto: 0, paradas: 3},
        }),
      ];
      component.statsFrom = '2026-08-03';
      component.statsTo = '2026-10-02';
      vista = component.statsVista()!;
      expect(vista.filas[0].sin_registro).toBe(true);
      expect(vista.filas[1].sin_registro).toBe(false);
      expect(vista.filas[2].horas_trabajo).toBeNull();
      render();
      filas = Array.from(fixture.nativeElement.querySelectorAll('.stats-table-periodos tbody tr')) as HTMLElement[];
      expect(celda(filas[0], '.stats-fila-muerto')).toBe('20 sin registro');
      expect(celda(filas[1], '.stats-fila-trabajo')).toBe('6');
      expect(filas[1].querySelector('.stats-fila-muerto')?.getAttribute('title'))
        .toBe('Turno de 20 h: 6 h de trabajo + 14 h muertas');
      expect(celda(filas[2], '.stats-fila-muerto')).toBe('—');
    });

    it('puts the work and dead hours of each day in the chart and the table, flagging the days without any record', () => {
      const dia = (fecha: string, extra: Partial<ProductionStatsDay>): ProductionStatsDay => ({
        fecha, modulos_completados: 0, fases_completadas: 0, peso_total_kg: 0, peso_malla_inicial_kg: 0, peso_malla_final_kg: 0,
        desperdicio_kg: 0, cantidad_cortes: 0, cantidad_refuerzos: 0, cantidad_zunchos: 0, cantidad_separadores: 0,
        cantidad_punzos: 0, dificultad_total: 0, ...extra,
      });
      stats.range = {from: '2026-09-14', to: '2026-09-15', working_days: 2};
      stats.totals.modulos_completados = 2;
      stats.totals.horas_trabajo = 6.2;
      stats.por_dia = [
        dia('2026-09-14', {
          modulos_completados: 2, horas_turno: 10, horas_trabajo: 6.2, horas_muertas: 3.8, horas_fuera_turno: 1, estimado: true,
          abre: '2026-09-14T06:12:00+02:00', cierra: '2026-09-14T15:48:00+02:00',
          causas: {sin_registro: 0, empezo_tarde: 0.2, acabo_pronto: 0.2, paradas: 3.4},
        }),
        dia('2026-09-15', {
          horas_turno: 10, horas_trabajo: 0, horas_muertas: 10, sin_registro: true,
          causas: {sin_registro: 10, empezo_tarde: 0, acabo_pronto: 0, paradas: 0},
        }),
      ];
      component.statsFrom = '2026-09-14';
      component.statsTo = '2026-09-15';

      const vista = component.statsVista()!;
      expect(vista.horas.map(s => s.name)).toEqual(['Trabajado']);
      expect(vista.horas[0].values.map(v => Math.round(v!))).toEqual([62, 0]);
      expect(vista.horas[0].tooltips![0]).toBe('62 % · 6.2 h de trabajo + 3.8 h muertas');

      render();
      const filas = Array.from(fixture.nativeElement.querySelectorAll('.stats-table-periodos tbody tr')) as HTMLElement[];
      const celda = (fila: HTMLElement, selector: string) => fila.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
      expect(celda(filas[0], '.stats-fila-trabajo')).toBe('6.2 est.');
      expect(celda(filas[0], '.stats-fila-muerto')).toBe('3.8');
      expect(celda(filas[0], '.stats-fila-senales')).toBe('06:12 – 15:48');
      expect(filas[0].querySelector('.stats-fila-muerto')?.getAttribute('title')).toBe(
        'Turno de 10 h: 5.2 h de trabajo + 3.8 h muertas · 1 h trabajadas fuera de turno'
        + ' · estimado: sin registro de eventos, solo fotos y fases hechas',
      );
      expect(celda(filas[1], '.stats-fila-trabajo')).toBe('0');
      expect(celda(filas[1], '.stats-fila-muerto')).toBe('10 sin registro');
      expect(celda(filas[1], '.stats-fila-senales')).toBe('—');
    });

    it('shows a measured phase as its work minutes plus what it stood still on the table', () => {
      const fase = (extra: Partial<ProductionStatsModuloFase>): ProductionStatsModuloFase => ({
        mesa_nombre: 'Mesa 1', done_at: '2026-09-14T15:55:00+02:00', minutos: 55, medido: true, peso_kg: 100, malla_kg: 80,
        desperdicio_kg: 5, cortes: 2, refuerzos: 1, dificultad: 100, ...extra,
      });
      stats.totals.modulos_completados = 1;
      stats.modulos = [{
        id: 1, nombre: 'M-01', proyecto_id: 1, proyecto_nombre: 'Obra', grupo: null, completado_at: '2026-09-15T08:00:00+02:00',
        inferior: fase({sin_pulsar_min: 30, parado_min: 905, parado_turno_min: 65, parado_fuera_min: 840, pernocto: true}),
        superior: fase({minutos: 40, parado_min: 0, parado_turno_min: 0, parado_fuera_min: 0, pernocto: false}),
        minutos: 95, peso_kg: 200, desperdicio_kg: 10, dificultad: 200,
      }];
      render();
      const fila = fixture.nativeElement.querySelector('.stats-table-modulos tbody tr') as HTMLElement;
      const celdas = Array.from(fila.querySelectorAll('.stats-fase-min')) as HTMLElement[];
      expect(celdas.map(c => c.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['55 + 905', '40']);
      expect(celdas[0].getAttribute('title')).toBe(
        '55 min de trabajo medidos en la mesa (30 sin pasar diapositiva) · 905 min parada (840 fuera de turno) · pernoctó en la mesa',
      );
      expect(celdas[1].getAttribute('title')).toBe('40 min de trabajo medidos en la mesa');
      expect(text('.stats-modulo-min')).toBe('95 + 905');
    });

    it('gives the mean and the best hour instead of the day when a single day is shown', () => {
      const vacio = () => ({
        fases_completadas: 0, peso_total_kg: 0, peso_malla_inicial_kg: 0, peso_malla_final_kg: 0, desperdicio_kg: 0,
        cantidad_cortes: 0, cantidad_refuerzos: 0, cantidad_zunchos: 0, cantidad_separadores: 0, cantidad_punzos: 0,
        dificultad_total: 0,
      });
      stats.range = {from: '2026-09-14', to: '2026-09-14', working_days: 1};
      stats.totals.modulos_completados = 5;
      stats.por_hora = [
        {...vacio(), hora: '07', modulos_completados: 1},
        {...vacio(), hora: '08', modulos_completados: 0},
        {...vacio(), hora: '09', modulos_completados: 4},
      ];
      component.statsFrom = '2026-09-14';
      component.statsTo = '2026-09-14';
      const resumen = component.statsResumen()!;
      expect([resumen.porHora, resumen.media, resumen.mejor]).toEqual([true, 2.5, {modulos: 4, label: '09h'}]);
      render();
      expect([text('.stats-kpi-media .stats-kpi-label'), text('.stats-kpi-media .stats-kpi-value')]).toEqual(['Media por hora', '2.5 mód./hora']);
      expect([text('.stats-kpi-mejor .stats-kpi-label'), text('.stats-kpi-mejor .stats-kpi-value')]).toEqual(['Mejor hora', '4 mód. · 09h']);
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
      // La dificultad por modulo, en la misma grafica y a la escala de los modulos: su media
      // cae en la media de modulos (7/3). El martes hizo pocos pero mas dificiles.
      const decima = (valores: Array<number | null>) => valores.map(v => v === null ? null : Math.round(v * 10) / 10);
      expect(vista.modulos.map(s => s.name)).toEqual(['Módulos', 'Dificultad por módulo']);
      expect(decima(vista.modulos[1].values)).toEqual([1.8, 5.4, null, 1.8, null]);
      expect(Math.round(vista.modulos[1].prev! * 10) / 10).toBe(1.4);
      // La lectura dice los puntos reales, sin porcentajes.
      expect(vista.modulos[1].tooltips![1]).toBe('50 puntos');
      // Peso y desperdicio en la misma grafica, los dos en kilos.
      expect(vista.peso.map(s => s.name)).toEqual(['Peso producido', 'Desperdicio']);
      expect(vista.peso[1].values).toEqual([10, 10, 0, 10, 0]);
      expect(Math.round(vista.peso[1].prev!)).toBe(10);
      expect(component.desperdicioPct({desperdicio_kg: 184.9, peso_total_kg: 10458, peso_malla_final_kg: 7089})).toBeCloseTo(1.77, 2);
      expect(component.desperdicioPct({desperdicio_kg: 5, peso_total_kg: 0})).toBeNull();
      // El peso de las graficas y tablas es el total del modulo, no solo el mallazo.
      expect(vista.peso[0].values).toEqual([130, 130, 0, 130, 0]);
      expect(vista.peso[0].prev).toBe(130);
      expect(component.statsResumen()).toEqual({
        porHora: false, media: 7 / 3,
        mejor: {modulos: 3, label: 'Lun 14'}, kgPorModulo: 0, dificultadMedia: 0, pesoTotal: 0,
      });

      render();
      const filas = Array.from(fixture.nativeElement.querySelectorAll('.stats-table-periodos tbody tr')) as HTMLElement[];
      expect(filas.length).toBe(5);
      expect(Array.from(filas[0].querySelectorAll('td')).slice(0, 4).map(td => td.textContent?.trim()))
        .toEqual(['Lun 14', '3', '2', '+1']);
      // Paneles, peso total y mallazo, en ese orden (sin actividad del servidor no hay mas columnas).
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
      // Peso producido (lo fabricado) y peso total (lo que se gasta: producido + desperdicio);
      // el mallazo queda en las tablas.
      expect(text('.stats-kpi-peso .stats-kpi-value')).toBe('140 kg');
      expect(text('.stats-kpi-peso-total .stats-kpi-value')).toBe('147 kg');
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
      // Es un periodo como Hoy o Este mes, no otro proyecto.
      expect(fixture.nativeElement.querySelector('.stats-period-presets .period-chip[title^="Desde el primer"]')?.textContent?.trim()).toBe('Desde el inicio');

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
      // Modulos (5), kilos (4) y productividad (horas y los dos ritmos).
      expect(Array.from(fixture.nativeElement.querySelectorAll('.stats-bloque .stats-subtitle')).map(h => (h as HTMLElement).textContent?.trim()))
        .toEqual(['Módulos', 'Kilos', 'Productividad']);
      expect(fixture.nativeElement.querySelectorAll('.stats-bloque-modulos .stats-kpi').length).toBe(5);
      expect(fixture.nativeElement.querySelectorAll('.stats-bloque-kilos .stats-kpi').length).toBe(4);
      expect(fixture.nativeElement.querySelectorAll('.stats-bloque-productividad .stats-kpi').length).toBe(3);
      expect(text('.stats-kpi-value')).toBe('0 / 9 objetivo');
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
      expect(text('.stats-kpi-modulos .stats-kpi-value')).toBe('53 / 64 objetivo');
      expect(fixture.nativeElement.querySelector('.stats-table')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.stats-charts')).not.toBeNull();
      expect(fixture.nativeElement.querySelectorAll('app-stats-line-chart').length).toBe(3);  // sin actividad del servidor no hay grafica del turno
      expect(fixture.nativeElement.querySelector('.stats-empty')).toBeNull();
    });

    it('uses factory-wide demand even with no projects in table queues or the project list', () => {
      component.proyectos = [];
      component.gruposMesas = [];
      component.selectedProyecto = {id: 1, planificacion: {modulos_por_dia: 3}} as Proyecto;
      stats.esperado.ritmo_necesario = 12;
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

    it('never stacks a background refresh on a stats request still running, nor refreshes what is not on screen', () => {
      const pendiente = new Subject<ProductionStatsResponse>();
      const peticion = vi.spyOn(TestBed.inject(ApiService), 'getProductionStats').mockReturnValue(pendiente);
      vi.spyOn(TestBed.inject(ApiService), 'getProyectos').mockReturnValue(of([]));
      const hoy = new Date();
      const hoyIso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
      component.statsFrom = hoyIso;
      component.statsTo = hoyIso;
      component.silentRefreshProyectosAndStats();
      expect(peticion).toHaveBeenCalledTimes(1);
      // La primera no ha vuelto: los refrescos siguientes no mandan otra.
      component.silentRefreshProyectosAndStats();
      component.silentRefreshProyectosAndStats();
      expect(peticion).toHaveBeenCalledTimes(1);
      pendiente.next(stats);
      pendiente.complete();
      peticion.mockReturnValue(of(stats));
      component.silentRefreshProyectosAndStats();
      expect(peticion).toHaveBeenCalledTimes(2);
      // Un periodo ya pasado no cambia, y en Produccion no se ven.
      component.statsFrom = '2026-09-01';
      component.statsTo = '2026-09-14';
      component.silentRefreshProyectosAndStats();
      component.statsTo = hoyIso;
      component.vista = 'produccion';
      component.silentRefreshProyectosAndStats();
      expect(peticion).toHaveBeenCalledTimes(2);
    });

    it('labels retained statistics as stale after a failed silent refresh', () => {
      vi.spyOn(TestBed.inject(ApiService), 'getProductionStats')
        .mockReturnValue(throwError(() => new Error('unavailable')));
      component.loadStats(true);
      render();
      expect(component.statsData).toBe(stats);
      expect(text('.stats-error')).toContain('últimos datos disponibles');
      // Módulos (5), kilos (4) y productividad (horas y los dos ritmos).
      expect(fixture.nativeElement.querySelectorAll('.stats-kpi').length).toBe(12);
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
      esperado: { ritmo_necesario: 12, modulos_esperados: 12 },
    } satisfies ProductionStatsResponse;

    const buckets = component.statsBuckets();

    expect(buckets.map(bucket => bucket.key)).toEqual(['07', '08', '09']);
    expect(buckets.map(bucket => bucket.label)).toEqual(['07h', '08h', '09h']);
    expect(buckets.map(bucket => bucket.modulos_completados)).toEqual([1, 0, 1]);
    // 12 modulos de objetivo en el dia, repartidos en una jornada de 8 horas.
    expect(buckets.every(bucket => bucket.meta_modulos === 1.5)).toBe(true);
  });

  it('moves to the previous or next day, week or month, never past today', () => {
    vi.spyOn(component, 'loadStats').mockImplementation(() => undefined);
    const ir = (preset: typeof component.statsPreset, from: string, to: string, delta: -1 | 1) => {
      component.statsPreset = preset;
      component.statsFrom = from;
      component.statsTo = to;
      component.moverPeriodo(delta);
      return [component.statsFrom, component.statsTo];
    };
    expect(ir('day', '2026-09-28', '2026-09-28', -1)).toEqual(['2026-09-27', '2026-09-27']);
    expect(ir('week', '2026-09-28', '2026-10-04', -1)).toEqual(['2026-09-21', '2026-09-27']);
    expect(ir('month', '2026-09-01', '2026-09-30', -1)).toEqual(['2026-08-01', '2026-08-31']);
    // Con fechas a mano, tantos dias como el rango.
    expect(ir('custom', '2026-09-10', '2026-09-12', 1)).toEqual(['2026-09-13', '2026-09-15']);
    // Hoy no tiene siguiente y "desde el inicio" no se mueve.
    const hoy = new Date();
    const hoyIso = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
    component.statsPreset = 'day';
    component.statsFrom = hoyIso;
    component.statsTo = hoyIso;
    expect(component.puedeMoverPeriodo(1)).toBe(false);
    expect(component.puedeMoverPeriodo(-1)).toBe(true);
    component.statsPreset = 'proyecto';
    expect(component.puedeMoverPeriodo(-1)).toBe(false);
  });

  describe('shifts in the statistics', () => {
    const vacio = () => ({
      fases_completadas: 0, peso_total_kg: 0, peso_malla_inicial_kg: 0, peso_malla_final_kg: 0, desperdicio_kg: 0,
      cantidad_cortes: 0, cantidad_refuerzos: 0, cantidad_zunchos: 0, cantidad_separadores: 0, cantidad_punzos: 0,
      dificultad_total: 0,
    });
    const respuesta = (range: ProductionStatsResponse['range'], extra: Partial<ProductionStatsResponse> = {}): ProductionStatsResponse => ({
      range,
      totals: { ...vacio(), modulos_completados: 0, horas_productivas: 0, modulos_por_hora: 0, kg_por_hora: 0 },
      por_mesa: [], por_dia: [], por_hora: null,
      esperado: { ritmo_necesario: 0, modulos_esperados: 50 },
      ...extra,
    });

    it('shares the period target among the days by their shifts, weekends included', () => {
      component.statsFrom = '2026-09-27';
      component.statsTo = '2026-09-29';
      component.statsData = respuesta({
        from: '2026-09-27', to: '2026-09-29', working_days: 3,
        dias: [
          { fecha: '2026-09-27', turnos: 1, horas: 10 },
          { fecha: '2026-09-28', turnos: 2, horas: 20 },
          { fecha: '2026-09-29', turnos: 2, horas: 20 },
        ],
      });
      const buckets = component.statsBuckets();
      // El domingo solo tiene el turno de noche: la mitad que los demas.
      expect(buckets.map(b => [b.key, b.meta_modulos])).toEqual([
        ['2026-09-27', 10], ['2026-09-28', 20], ['2026-09-29', 20],
      ]);
    });

    it('shows a calendar day hour by hour, with target only in shift hours', () => {
      const horas = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 23].map(h => String(h).padStart(2, '0'));
      component.statsFrom = '2026-09-28';
      component.statsTo = '2026-09-28';
      component.statsData = respuesta(
        { from: '2026-09-28', to: '2026-09-28', working_days: 1, dias: [{ fecha: '2026-09-28', turnos: 2, horas: 20 }], horas },
        {
          por_hora: [
            { ...vacio(), hora: '02', modulos_completados: 1 },
            { ...vacio(), hora: '10', modulos_completados: 1 },
          ],
          esperado: { ritmo_necesario: 0, modulos_esperados: 20 },
        },
      );
      const buckets = component.statsBuckets();
      // De 00h a 23h en orden: la madrugada es de este dia.
      expect(buckets.map(b => b.key)).toEqual(Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')));
      expect(buckets.find(b => b.key === '02')!.modulos_completados).toBe(1);
      // 20 de objetivo en 20 horas de turno; entre turnos no hay objetivo.
      expect(buckets.find(b => b.key === '10')!.meta_modulos).toBe(1);
      expect(buckets.find(b => b.key === '17')!.meta_modulos).toBe(0);
    });

    it('shows the whole chosen shift in the one-day view, from the evening before', () => {
      const horas = ['19', '20', '21', '22', '23', '00', '01', '02', '03', '04'];
      const eje = ['18', ...horas, '05'].map((hora, i) => ({
        hora, inicio: new Date(2026, 8, 28, 18 + i, 0, 0).toISOString(),
      }));
      component.statsFrom = '2026-09-29';
      component.statsTo = '2026-09-29';
      component.statsData = respuesta(
        { from: '2026-09-29', to: '2026-09-29', working_days: 1, dias: [{ fecha: '2026-09-29', turnos: 1, horas: 10 }], horas, eje },
        {
          por_hora: [
            { ...vacio(), hora: '18', modulos_completados: 1 },
            { ...vacio(), hora: '02', modulos_completados: 2 },
          ],
          esperado: { ritmo_necesario: 0, modulos_esperados: 10 },
          turno: 1,
        },
      );
      const buckets = component.statsBuckets();
      expect(buckets.map(b => b.key)).toEqual(['18', ...horas, '05']);
      expect(buckets.map(b => b.modulos_completados).filter(n => n > 0)).toEqual([1, 2]);
      // Objetivo solo en las horas del turno: 10 en 10 horas.
      expect(buckets.find(b => b.key === '18')!.meta_modulos).toBe(0);
      expect(buckets.find(b => b.key === '02')!.meta_modulos).toBe(1);
      expect(buckets.every(b => !b.futuro)).toBe(true);
    });

    it('asks for one shift when it is chosen and offers the shifts of the ferralla', () => {
      const turnos = [{ indice: 0, nombre: 'Mañana' }, { indice: 1, nombre: 'Noche' }];
      const request = vi.spyOn(TestBed.inject(ApiService), 'getProductionStats')
        .mockReturnValue(of(respuesta({ from: '2026-09-28', to: '2026-09-28', working_days: 1 }, { turnos })));
      component.statsFrom = '2026-09-28';
      component.statsTo = '2026-09-28';
      component.selectStatsTurno('1');
      expect(request.mock.lastCall![0]!.turno).toBe(1);
      expect(component.statsTurnos).toEqual(turnos);
      component.selectStatsTurno('');
      expect(request.mock.lastCall![0]!.turno).toBeUndefined();
    });
  });

  it('lists the waiting projects by montaje date and says why the blocked ones cannot go up', () => {
    component.proyectos = [
      { id: 1, nombre: 'Libre', modulos_count: 4, modulos_completados: 0, produccion_bloqueada: false, fecha_montaje_obra: '2026-11-20' } as Proyecto,
      { id: 2, nombre: 'Bloqueado', modulos_count: 4, modulos_completados: 0, produccion_bloqueada: true, fecha_montaje_obra: '2026-11-10' } as Proyecto,
      { id: 3, nombre: 'Terminado', modulos_count: 4, modulos_completados: 4, produccion_bloqueada: true, fecha_montaje_obra: '2026-11-20' } as Proyecto,
      { id: 4, nombre: 'Sin fecha de obra', modulos_count: 4, modulos_completados: 0, produccion_bloqueada: false, fecha_montaje_obra: null } as Proyecto,
    ];

    // Los terminados no esperan; los que no tienen fecha, al final.
    expect(component.proyectosEnEspera(null).map(p => p.nombre)).toEqual(['Bloqueado', 'Libre', 'Sin fecha de obra']);
    expect(component.proyectosEnEspera(null).map(p => component.motivoNoSubeAMesa(p))).toEqual([
      'Faltan validaciones de Moden antes de fabricarlo', '', 'Ponle fecha de montaje en obra para subirlo a mesa',
    ]);
    expect(component.montajeColaLabel(1)).toBe('monta 20/11');
    expect(component.montajeColaLabel(4)).toBe('');
  });

  it('shows the queue as "en mesa" and "en espera": the cross sends it down, the arrow sends it up', () => {
    const api = TestBed.inject(ApiService);
    const grupo = {
      id: 1, nombre: 'Grupo mesas 1', usuario: 1, proyecto_actual: 1, estrategia_cola_superior: 'PLANIFICADA',
      activa: true, created_at: '', mesas: [],
      proyectos_cola: [
        { id: 11, proyecto: 1, proyecto_nombre: 'P03', orden: 0 },
        { id: 12, proyecto: 2, proyecto_nombre: 'P04', orden: 1 },
      ],
    } as unknown as GrupoMesas;
    component.proyectos = [
      { id: 1, nombre: 'P03', modulos_count: 4, modulos_completados: 1, fecha_montaje_obra: '2026-11-05' } as Proyecto,
      { id: 2, nombre: 'P04', modulos_count: 4, modulos_completados: 0, fecha_montaje_obra: '2026-11-12' } as Proyecto,
      { id: 3, nombre: 'P06', modulos_count: 4, modulos_completados: 0, fecha_montaje_obra: '2026-12-01' } as Proyecto,
      { id: 4, nombre: 'P05', modulos_count: 4, modulos_completados: 0, fecha_montaje_obra: '2026-11-20' } as Proyecto,
    ];
    component.gruposMesas = [grupo];
    component.openColaModal(grupo);
    fixture.detectChanges();
    const modal: HTMLElement = fixture.nativeElement.querySelector('.gestionar-modal');
    const nombres = (selector: string) => Array.from(modal.querySelectorAll(`${selector} .cola-nombre`)).map(e => e.textContent?.trim());
    expect(Array.from(modal.querySelectorAll('.cola-seccion h4')).map(h => h.textContent)).toEqual(['En mesa', 'En espera']);
    expect(nombres('.cola-en-mesa')).toEqual(['P03', 'P04']);
    expect(modal.querySelector('.cola-en-mesa .cola-badge-head')?.textContent?.trim()).toBe('En fabricación');
    expect(nombres('.cola-en-espera')).toEqual(['P05', 'P06']);
    expect(modal.querySelector('.cola-en-espera .cola-montaje')?.textContent).toBe('monta 20/11');

    const subir = vi.spyOn(api, 'colaGrupoMesasAdd').mockReturnValue(of(grupo));
    const bajar = vi.spyOn(api, 'colaGrupoMesasRemove').mockReturnValue(of(grupo));
    vi.spyOn(component, 'loadMesas').mockImplementation(() => undefined);
    (modal.querySelector('[aria-label="Subir P06 a mesa"]') as HTMLButtonElement).click();
    expect(subir).toHaveBeenCalledWith(1, 3);
    (modal.querySelector('[aria-label="Pasar P04 a espera"]') as HTMLButtonElement).click();
    expect(bajar).toHaveBeenCalledWith(1, 2);
  });

  it('keeps new projects behind the notifications bell until the ferralla accepts them', () => {
    const api = TestBed.inject(ApiService);
    const aceptado = { id: 1, nombre: 'Aceptado', aceptado_por_ferralla_at: '2026-10-21T08:00:00Z' } as Proyecto;
    const nuevo = { id: 2, nombre: 'Nuevo', modulos_count: 12, aceptado_por_ferralla_at: null } as Proyecto;
    const lista = vi.spyOn(api, 'getProyectos').mockReturnValue(of([aceptado, nuevo]));
    vi.spyOn(component, 'selectProyecto').mockImplementation(() => undefined);
    component.loadProyectos();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(component.proyectos.map(p => p.nombre)).toEqual(['Aceptado']);
    expect(component.proyectosPendientes.map(p => p.nombre)).toEqual(['Nuevo']);
    const campana: HTMLButtonElement = fixture.nativeElement.querySelector('.btn-notificaciones');
    expect(campana.querySelector('.notificaciones-badge')?.textContent?.trim()).toBe('1');

    campana.click();
    fixture.detectChanges();
    const modal: HTMLElement = fixture.nativeElement.querySelector('.notificaciones-modal');
    expect(modal.textContent).toContain('Nuevo');
    const aceptadoNuevo = { ...nuevo, aceptado_por_ferralla_at: '2026-10-21T09:00:00Z' } as Proyecto;
    const aceptar = vi.spyOn(api, 'aceptarProyecto').mockReturnValue(of(aceptadoNuevo));
    lista.mockReturnValue(of([aceptado, aceptadoNuevo]));
    (modal.querySelector('.notificacion-row .btn-add-cola') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(aceptar).toHaveBeenCalledWith(2);
    expect(component.proyectosPendientes).toEqual([]);
    expect(component.proyectos.map(p => p.nombre)).toEqual(['Aceptado', 'Nuevo']);
    expect(fixture.nativeElement.querySelector('.notificaciones-modal')).toBeNull();
    expect(fixture.nativeElement.querySelector('.notificaciones-badge')).toBeNull();
  });

  it('lets the ferralla set its own site date on the card and warns while it is missing', () => {
    const api = TestBed.inject(ApiService);
    component.proyectos = [
      { id: 7, nombre: 'Torre Norte', modulos_count: 4, modulos_completados: 0, fecha_montaje: null, fecha_montaje_obra: null } as unknown as Proyecto,
    ];
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const card: HTMLElement = fixture.nativeElement.querySelector('.project-inline-card');
    expect(card.querySelector('.project-montaje-aviso')?.textContent).toContain('no puede entrar en mesa');

    const update = vi.spyOn(api, 'updateProyecto').mockReturnValue(of({ id: 7, fecha_montaje_obra: '2026-11-20' } as Proyecto));
    const input = card.querySelector('.project-montaje-obra input') as HTMLInputElement;
    input.value = '2026-11-20';
    input.dispatchEvent(new Event('change'));
    expect(update).toHaveBeenCalledWith(7, { fecha_montaje_obra: '2026-11-20' });
    fixture.detectChanges();
    expect(component.proyectos[0].fecha_montaje_obra).toBe('2026-11-20');
    expect(card.querySelector('.project-montaje-aviso')).toBeNull();
  });

  it('marks the engineering date in grey until the ferralla confirms it with one click or picks its own', () => {
    const api = TestBed.inject(ApiService);
    component.proyectos = [
      { id: 7, nombre: 'Torre Norte', modulos_count: 4, modulos_completados: 0, fecha_montaje: '2026-11-12', fecha_montaje_obra: null } as Proyecto,
    ];
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const card: HTMLElement = fixture.nativeElement.querySelector('.project-inline-card');
    const input = card.querySelector('.project-montaje-obra input') as HTMLInputElement;
    // La orientativa sale ya marcada, en gris, y sin confirmar no entra en mesa ni lleva donut.
    expect(input.value).toBe('2026-11-12');
    expect(card.querySelector('.project-progress-donut')).toBeNull();
    expect(input.classList.contains('orientativa')).toBe(true);
    expect(card.querySelector('.project-montaje-aviso')?.textContent?.replace(/\s+/g, ' ').trim())
      .toBe('Fecha orientativa hablada al confirmar el proyecto: confírmala o cámbiala para que quede aceptado y entre en el cálculo de objetivos.');
    // El boton va pegado a la fecha.
    expect(card.querySelector('.project-montaje-campo .project-montaje-confirmar')).not.toBeNull();
    expect(component.motivoNoSubeAMesa(component.proyectos[0])).toContain('Confirma su fecha de montaje en obra');
    expect(component.montajeColaLabel(7)).toBe('orientativa 12/11');

    const update = vi.spyOn(api, 'updateProyecto').mockReturnValue(of({ id: 7, fecha_montaje_obra: '2026-11-12' } as Proyecto));
    (card.querySelector('.project-montaje-confirmar') as HTMLButtonElement).click();
    expect(update).toHaveBeenCalledWith(7, { fecha_montaje_obra: '2026-11-12' });
    fixture.detectChanges();
    expect(input.classList.contains('orientativa')).toBe(false);
    expect(card.querySelector('.project-montaje-confirmar')).toBeNull();
    expect(card.querySelector('.project-montaje-aviso')).toBeNull();
    expect(card.querySelector('.project-progress-donut')).not.toBeNull();
    expect(component.montajeColaLabel(7)).toBe('monta 12/11');

    // Con la suya puesta, aunque sea otra, ya no se ensena la orientativa.
    component.proyectos[0].fecha_montaje_obra = '2026-11-20';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(card.textContent).not.toContain('orientativa');
    expect(card.querySelector('.project-montaje-aviso')).toBeNull();
  });

  it('lets the ferralla pick the superior order on the SUP card and reorder it by hand when manual', () => {
    const api = TestBed.inject(ApiService);
    const grupo = {
      id: 1, nombre: 'Grupo mesas', usuario: 1, proyecto_actual: 7, proyectos_cola: [], estrategia_cola_superior: 'MANUAL',
      activa: true, created_at: '', mesas: [],
    } as unknown as GrupoMesas;
    component.gruposMesas = [grupo];
    component.mesas = [
      { id: 1, nombre: 'Mesa 1', tipo: 'INFERIOR', indice: 1, activa: true, grupo: 1, is_linked: false },
      { id: 3, nombre: 'Mesa 3', tipo: 'SUPERIOR', indice: 3, activa: true, grupo: 1, is_linked: false },
    ] as unknown as Mesa[];
    const sup = (id: number, nombre: string, position: number, status: 'MOSTRANDO' | 'EN_COLA', proyecto = 7) => ({
      id, mesa: 3, modulo: id, modulo_nombre: nombre, modulo_proyecto_id: proyecto, fase: 'SUPERIOR', position, status,
      current_image_index: 0, imagenes_total: 16,
    } as unknown as MesaQueueItem);
    component.mesaQueueItems.set(3, [sup(31, 'A1', 0, 'MOSTRANDO'), sup(99, 'Z1', 1, 'EN_COLA', 8), sup(32, 'A2', 2, 'EN_COLA')]);
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const cards: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('.mesa-card'));
    expect(cards.length).toBe(2);
    // La inferior no elige orden; la superior si, con tres iconos en su cabecera
    // (sin fila aparte), y en manual ensena las flechas.
    expect(cards[0].querySelector('.mesa-orden-iconos')).toBeNull();
    const sup3 = cards[1];
    const iconos = Array.from(sup3.querySelectorAll('.mesa-header .mesa-orden-btn')) as HTMLButtonElement[];
    expect(iconos.map(b => b.getAttribute('aria-label'))).toEqual(['Orden planificado', 'Orden adaptativo', 'Orden manual']);
    expect(iconos.every(b => !!b.title)).toBe(true);
    expect(sup3.querySelector('.mesa-orden-btn.active')?.getAttribute('aria-label')).toBe('Orden manual');
    expect(sup3.querySelectorAll('.queue-item-order').length).toBe(3);

    const reorder = vi.spyOn(api, 'reorderMesaQueue').mockReturnValue(of({ status: 'ok' }));
    vi.spyOn(component, 'loadMesaQueueItems').mockImplementation(() => undefined);
    vi.spyOn(component, 'loadGruposMesas').mockImplementation(() => undefined);
    (sup3.querySelector('[aria-label="Fabricar antes A2"]') as HTMLButtonElement).click();
    // A2 pasa delante del modulo del otro proyecto; las posiciones son de toda la mesa.
    expect(reorder).toHaveBeenCalledWith([{ id: 31, position: 0 }, { id: 32, position: 1 }, { id: 99, position: 2 }]);
    expect(component.mesaReorderBusyId).toBeNull();

    // Al volver a automatico las flechas desaparecen.
    const update = vi.spyOn(api, 'updateGrupoMesas')
      .mockReturnValue(of({ ...grupo, estrategia_cola_superior: 'ADAPTATIVA' } as GrupoMesas));
    vi.spyOn(component, 'loadMesas').mockImplementation(() => undefined);
    (sup3.querySelector('[aria-label="Orden adaptativo"]') as HTMLButtonElement).click();
    expect(update).toHaveBeenCalledWith(1, { estrategia_cola_superior: 'ADAPTATIVA' });
    fixture.detectChanges();
    expect(sup3.querySelector('.mesa-orden-btn.active')?.getAttribute('aria-label')).toBe('Orden adaptativo');
    expect(sup3.querySelectorAll('.queue-item-order').length).toBe(0);
  });

  it('splits the group controls: tables in "Gestionar mesas", projects in "Cola de proyectos"', () => {
    const grupo = {
      id: 1, nombre: 'Grupo mesas', usuario: 1, proyecto_actual: null, proyectos_cola: [], estrategia_cola_superior: 'PLANIFICADA',
      activa: true, created_at: '', mesas: [],
    } as unknown as GrupoMesas;
    component.gruposMesas = [grupo];
    component.mesas = [{ id: 1, nombre: 'Mesa 1', tipo: 'INFERIOR', indice: 1, activa: true, grupo: 1, is_linked: false }] as unknown as Mesa[];
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const botones = Array.from(fixture.nativeElement.querySelectorAll('.grupo-operativo-actions .btn-gestionar')) as HTMLButtonElement[];
    expect(botones.map(b => b.textContent?.trim())).toEqual(['Cola de proyectos', 'Gestionar mesas']);

    botones[1].click();
    fixture.detectChanges();
    let modal: HTMLElement = fixture.nativeElement.querySelector('.gestionar-modal');
    expect(modal.querySelector('h3')?.textContent).toBe('Gestionar mesas · Grupo mesas');
    expect(Array.from(modal.querySelectorAll('.gestionar-section h4')).map(h => h.textContent)).toEqual(['Nombre del grupo', 'Mesas']);
    expect(modal.querySelector('.cola-en-espera')).toBeNull();
    component.closeGestionarModal();
    fixture.detectChanges();

    botones[0].click();
    fixture.detectChanges();
    modal = fixture.nativeElement.querySelector('.gestionar-modal');
    expect(modal.querySelector('h3')?.textContent).toBe('Cola de proyectos · Grupo mesas');
    expect(modal.querySelector('.cola-en-espera')).not.toBeNull();
    expect(modal.querySelector('.mesa-estado-switch')).toBeNull();
  });

  describe('loose elements from the despiece Excel', () => {
    const proyecto = {
      id: 7, nombre: 'Torre Norte', despiece_archivo: '/media/despieces/obra.xlsx', elementos_sueltos_disponible: true,
    } as Proyecto;
    const render = () => {
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
    };
    const datos: ElementosSueltos = {
      nombre_archivo: 'ESN27_P1_componentes_resumen.xlsx',
      url: '/media/despieces/ESN27_P1_componentes_resumen.xlsx',
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

    it('sits between the plan and the despiece in each project card', () => {
      component.vista = 'produccion';
      component.proyectos = [{ ...proyecto, modulos_count: 0 } as Proyecto];
      render();
      const etiquetas = Array.from(fixture.nativeElement.querySelectorAll('.project-actions button'))
        .map(boton => (boton as HTMLElement).getAttribute('aria-label'));
      expect(etiquetas.slice(-3)).toEqual(['Abrir plano PDF', 'Ver elementos sueltos', 'Descargar despiece']);
    });

    it('shows each block of the Excel with its title, header, rows and total, and offers the despiece', () => {
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
      expect(descarga.getAttribute('href')).toContain('/media/despieces/ESN27_P1_componentes_resumen.xlsx');
      expect(descarga.getAttribute('download')).toBe('ESN27_P1_componentes_resumen.xlsx');

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
        ...datos, nombre_archivo: 'antiguo.xls', url: '/media/despieces/antiguo.xls', previsualizable: false,
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
      // Sin despiece en Excel (o con el ZIP de documentacion de antes) no hay nada que abrir.
      component.openElementosModal({ ...proyecto, despiece_archivo: '/media/documentos/obra.zip', elementos_sueltos_disponible: false });
      expect(request).not.toHaveBeenCalled();
      expect(component.elementosModalProyecto).toBeNull();

      component.openElementosModal(proyecto);
      render();
      const modal: HTMLElement = fixture.nativeElement.querySelector('.elementos-modal');
      expect(modal.querySelector('.elementos-aviso')?.textContent).toContain('No se ha podido cargar el Excel');
      expect(modal.querySelector('.elementos-descargar')?.getAttribute('href')).toContain('/media/despieces/obra.xlsx');
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

  describe('working shifts owned by the ferralla', () => {
    const jornada = (days: string[], start = '06:50', end = '15:00') =>
      days.map(day => ({day: day as any, start_time: start, end_time: end}));
    const config = (extra: Partial<FerrallaCaptureConfig> = {}): FerrallaCaptureConfig => ({
      user_id: 1, active_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start_time: '06:50', end_time: '15:00',
      horario: jornada(['MON', 'TUE', 'WED', 'THU', 'FRI']),
      turnos: [{nombre: 'Mañana', activo: true, horario: jornada(['MON', 'TUE', 'WED', 'THU', 'FRI'])}],
      interval_seconds: 20, check_times: [], capture_window: {start_time: '06:20', end_time: '15:30'}, mesas: [], ...extra,
    });
    const grupo = () => [{
      id: 1, nombre: 'Grupo', usuario: 42, proyecto_actual: null, proyectos_cola: [], estrategia_cola_superior: 'PLANIFICADA',
      activa: true, created_at: '', mesas: [],
    } as GrupoMesas];

    it('describes each active shift by runs of days sharing the same hours', () => {
      component.horario = config();
      expect(component.horarioLabel()).toBe('Lun–Vie 06:50–15:00');
      component.horario = config({turnos: [{nombre: 'Mañana', activo: true,
        horario: [...jornada(['MON', 'TUE', 'WED', 'THU']), ...jornada(['FRI'], '06:50', '13:00')]}]});
      expect(component.horarioLabel()).toBe('Lun–Jue 06:50–15:00 · Vie 06:50–13:00');
      component.horario = config({turnos: [{nombre: 'Mañana', activo: true, horario: jornada(['MON', 'WED', 'FRI'])}]});
      expect(component.horarioLabel()).toBe('Lun, Mié, Vie 06:50–15:00');
      const noche = {nombre: 'Noche', activo: true, horario: jornada(['MON', 'TUE', 'WED', 'THU', 'SUN'], '19:00', '05:00')};
      component.horario = config({turnos: [{nombre: 'Mañana', activo: true, horario: jornada(['MON', 'TUE', 'WED', 'THU', 'FRI'], '06:00', '16:00')}, noche]});
      expect(component.horarioLabel()).toBe('Mañana Lun–Vie 06:00–16:00 · Noche Lun–Jue, Dom 19:00–05:00');
      // Un turno apagado (a demanda) no sale.
      component.horario = config({turnos: [...config().turnos, {...noche, activo: false}]});
      expect(component.horarioLabel()).toBe('Lun–Vie 06:50–15:00');
      component.horario = config({turnos: []});
      expect(component.horarioLabel()).toBe('Sin turnos de trabajo');
    });

    it('saves the shifts for the ferralla and refreshes the statistics', () => {
      const api = TestBed.inject(ApiService);
      component.gruposMesas = grupo();
      component.horario = config();
      const guardado = config({turnos: [
        {nombre: 'Mañana', activo: true, horario: [...jornada(['MON', 'TUE', 'WED', 'THU']), ...jornada(['FRI'], '06:50', '13:00')]},
        {nombre: 'Noche', activo: true, horario: jornada(['SUN'], '19:00', '05:00')},
      ]});
      const update = vi.spyOn(api, 'updateFerrallaCaptureConfig').mockReturnValue(of(guardado));
      vi.spyOn(component, 'loadStats').mockImplementation(() => undefined);
      vi.spyOn(component as any, 'silentRefreshProyectosAndStats').mockImplementation(() => undefined);

      component.editHorario();
      // Se edita una copia: lo que se ve no cambia hasta guardar.
      component.turnosDraft[0].horario[4].end_time = '13:00';
      expect(component.horario!.turnos[0].horario[4].end_time).toBe('15:00');
      // Un turno de noche acaba al dia siguiente.
      component.turnosDraft.push({nombre: 'Noche', activo: true, horario: jornada(['SUN'], '19:00', '05:00')});
      component.saveHorario();

      expect(update).toHaveBeenCalledWith(42, {
        turnos: [
          {nombre: 'Mañana', activo: true, horario: [...jornada(['MON', 'TUE', 'WED', 'THU']), {day: 'FRI', start_time: '06:50', end_time: '13:00'}]},
          {nombre: 'Noche', activo: true, horario: [{day: 'SUN', start_time: '19:00', end_time: '05:00'}]},
        ],
        interval_seconds: 20,
        rotations: [],
      });
      expect(component.horarioEditing).toBe(false);
      expect(component.horarioLabel()).toBe('Mañana Lun–Jue 06:50–15:00 · Vie 06:50–13:00 · Noche Dom 19:00–05:00');
      expect(component.loadStats).toHaveBeenCalled();
    });

    it('edits the shifts in a modal instead of inline', () => {
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
      expect(modal.querySelectorAll('app-turnos-editor .turno').length).toBe(1);
      expect(modal.querySelectorAll('app-turnos-editor .turno-dia').length).toBe(7);
      expect(fixture.nativeElement.querySelector('.stats-header .stats-schedule-form')).toBeNull();
      component.cancelHorario();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.horario-modal')).toBeNull();
    });

    it('refuses a shift that starts and ends at the same hour without calling the API', () => {
      const api = TestBed.inject(ApiService);
      component.gruposMesas = grupo();
      component.horario = config();
      const update = vi.spyOn(api, 'updateFerrallaCaptureConfig');
      component.editHorario();
      component.turnosDraft[0].horario[4].end_time = '06:50';
      component.saveHorario();
      expect(update).not.toHaveBeenCalled();
      expect(component.horarioError).toBe('Mañana, viernes: pon horas distintas de inicio y fin.');
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

    it('orders bastidores but no longer the modules inside them', () => {
      expect(fixture.nativeElement.querySelector('.plan-modulo-order')).toBeNull();
      expect(fixture.nativeElement.querySelector('[aria-label="Fabricar antes Grupo 1"]')).not.toBeNull();
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
      const columnas: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.plan-mesa');
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

    it('has no superior mesa in the project plan: its order lives in the mesa card', () => {
      component.gruposMesas = [{
        id: 1, nombre: 'Grupo mesas', usuario: 1, proyecto_actual: 7, proyectos_cola: [], estrategia_cola_superior: 'MANUAL',
        activa: true, created_at: '',
        mesas: [
          {id: 1, nombre: 'Mesa 1', tipo: 'INFERIOR', indice: 1, activa: true, is_linked: false},
          {id: 3, nombre: 'Mesa 3', tipo: 'SUPERIOR', indice: 3, activa: true, is_linked: false},
        ],
      } as GrupoMesas];
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const columnas: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.plan-mesa');
      expect(Array.from(columnas).map(c => c.querySelector('.plan-mesa-header strong')?.textContent)).toEqual(['Mesa 1']);
    });

    it('reorders the superior mesa from its card, asking before moving the one already started', () => {
      const api = TestBed.inject(ApiService);
      const sup = (id: number, nombre: string, position: number, status: 'MOSTRANDO' | 'EN_COLA', proyecto = 7) => ({
        id, mesa: 3, modulo: id, modulo_nombre: nombre, modulo_proyecto_id: proyecto, fase: 'SUPERIOR', position, status,
        current_image_index: 2, imagenes_total: 16, grupo_bastidor_indice: 1,
      } as unknown as MesaQueueItem);
      const mesa = {id: 3, nombre: 'Mesa 3', tipo: 'SUPERIOR', indice: 3, activa: true} as unknown as Mesa;
      const items = [sup(31, 'A1', 0, 'MOSTRANDO'), sup(32, 'A2', 1, 'EN_COLA'), sup(99, 'Z1', 2, 'EN_COLA', 8), sup(33, 'A3', 3, 'EN_COLA')];
      component.mesaQueueItems.set(3, items);
      // La cola de la mesa entera, de todos los proyectos.
      expect(component.canMoverSupEnMesa(mesa, items[0], -1)).toBe(false);
      expect(component.canMoverSupEnMesa(mesa, items[3], 1)).toBe(false);
      expect(component.canMoverSupEnMesa(mesa, items[2], -1)).toBe(true);

      const reorder = vi.spyOn(api, 'reorderMesaQueue').mockReturnValue(of({status: 'ok'}));
      vi.spyOn(component, 'loadMesaQueueItems').mockImplementation(() => undefined);
      vi.spyOn(component, 'loadGruposMesas').mockImplementation(() => undefined);
      component.moverSupEnMesa(mesa, items[3], -1);
      expect(reorder).toHaveBeenCalledWith([
        {id: 31, position: 0}, {id: 32, position: 1}, {id: 33, position: 2}, {id: 99, position: 3},
      ]);

      // La que esta en mesa ya empezada (paso 3): se pregunta antes de apartarla.
      const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
      reorder.mockClear();
      component.moverSupEnMesa(mesa, items[1], -1);
      expect(confirmar.mock.calls[0][0]).toContain('A1 va por el paso 3 en Mesa 3');
      expect(reorder).not.toHaveBeenCalled();
      confirmar.mockReturnValue(true);
      component.moverSupEnMesa(mesa, items[0], 1);
      expect(reorder).toHaveBeenCalledWith([
        {id: 32, position: 0}, {id: 31, position: 1}, {id: 99, position: 2}, {id: 33, position: 3},
      ]);
      // En el primer paso no pregunta.
      confirmar.mockClear();
      items[0].current_image_index = 0;
      component.moverSupEnMesa(mesa, items[0], 1);
      expect(confirmar).not.toHaveBeenCalled();
      confirmar.mockRestore();
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

    it('says the project photos are being prepared while the ZIP is built', () => {
      const api = TestBed.inject(ApiService);
      const zip = new Subject<Blob>();
      const descarga = vi.spyOn(api, 'downloadFotosZip').mockReturnValue(zip);
      vi.spyOn(component, 'planModalFotosTotal').mockReturnValue(12);
      component.showPlanModal = true;
      component.planModalProyecto = {id: 7, nombre: 'Obra', modulos_count: 4, modulos_completados: 1} as Proyecto;
      fixture.changeDetectorRef.markForCheck();
      fixture.detectChanges();
      const boton = () => Array.from(fixture.nativeElement.querySelectorAll('.plan-modal-header .plan-modal-download'))
        .find(b => (b as HTMLElement).textContent?.includes('Fotos de fabricación') || (b as HTMLElement).textContent?.includes('Preparando')) as HTMLButtonElement;
      expect(boton().textContent?.trim()).toBe('Fotos de fabricación');
      boton().click();
      fixture.detectChanges();
      expect(descarga).toHaveBeenCalledWith({proyecto: 7});
      expect(boton().textContent?.trim()).toBe('Preparando…');
      expect(boton().disabled).toBe(true);
      expect(fixture.nativeElement.querySelector('.plan-modal-aviso')?.textContent).toBe('Preparando las fotos de fabricación: puede tardar unos segundos.');
      vi.spyOn(component as any, 'triggerZipDownload').mockImplementation(() => undefined);
      zip.next(new Blob());
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.plan-modal-aviso')).toBeNull();
    });

    it('opens a finished project with its finished bastidores already shown', () => {
      const api = TestBed.inject(ApiService);
      const terminado = {id: 1, nombre: 'A1', grupo_bastidor: 10, inferior_hecho: true, superior_hecho: true, estado: 'COMPLETADO'} as Modulo;
      const pendiente = {id: 4, nombre: 'B1', grupo_bastidor: 11, inferior_hecho: false, superior_hecho: false} as Modulo;
      const modulos = vi.spyOn(api, 'getProyectoModulos').mockReturnValue(of([terminado]));
      vi.spyOn(api, 'getGruposBastidor').mockReturnValue(of([]));
      // Por el recuento del proyecto, nada mas abrir.
      component.openPlanModal({id: 7, nombre: 'Obra', modulos_count: 1, modulos_completados: 1} as Proyecto);
      expect(component.planModalShowDone).toBe(true);
      component.closePlanModal();
      expect(component.planModalShowDone).toBe(false);
      // Por sus modulos, si el recuento no lo decia.
      component.openPlanModal({id: 7, nombre: 'Obra'} as Proyecto);
      expect(component.planModalShowDone).toBe(true);
      component.closePlanModal();
      // Uno a medias: plegados como siempre.
      modulos.mockReturnValue(of([terminado, pendiente]));
      component.openPlanModal({id: 7, nombre: 'Obra', modulos_count: 2, modulos_completados: 1} as Proyecto);
      expect(component.planModalShowDone).toBe(false);
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
      // Una parte no se mueve: ni ella ni sus modulos tienen flechas.
      expect(secciones[1].querySelector('.plan-order-btn')).toBeNull();
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
