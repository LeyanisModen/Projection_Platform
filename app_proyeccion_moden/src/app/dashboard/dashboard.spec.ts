import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Dashboard } from './dashboard';
import { ApiService, Mesa, Modulo, Proyecto, ProductionStatsBucket, ProductionStatsResponse } from '../services/api.service';
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

    it('shows all six zero-valued KPIs and the period target before production starts', () => {
      render();
      expect(fixture.nativeElement.querySelectorAll('.stats-kpi').length).toBe(6);
      expect(text('.stats-kpi-value')).toBe('0 / 9');
      expect(text('.stats-kpi')).toBe('Módulos 0 / 9');
      expect(text('.stats-empty')).toContain('No hay producción registrada');
      expect(fixture.nativeElement.querySelector('.stats-table')).toBeNull();
      expect(fixture.nativeElement.querySelector('.weekly-charts-row')).toBeNull();
      expect(fixture.nativeElement.querySelector('.deadline-summary')).toBeNull();
      expect(fixture.nativeElement.querySelector('#estadisticas-section .stats-module-target')).not.toBeNull();
    });

    it('compares historical production with the target for that period, not daily demand', () => {
      stats.totals.modulos_completados = 53;
      stats.totals.fases_completadas = 106;
      stats.esperado.modulos_esperados = 64;
      render();
      expect(text('.stats-kpi-value')).toBe('53 / 64');
      expect(text('.stats-kpi')).toBe('Módulos 53 / 64');
      expect(fixture.nativeElement.querySelector('.stats-table')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.weekly-charts-row')).not.toBeNull();
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
      expect(text('.stats-kpi-value')).toBe('0 / 9');
    });

    it('advances actual production without subtracting it from the period target', () => {
      stats.totals.modulos_completados = 3;
      render();
      expect(text('.stats-kpi-value')).toBe('3 / 9');
      stats.totals.modulos_completados = 11;
      render();
      expect(text('.stats-kpi-value')).toBe('11 / 9');
    });

    it('keeps a historical target even when current deadlines have elapsed', () => {
      stats.planificacion!.modulos_por_dia = 0;
      stats.planificacion!.urgentes = 1;
      render();
      expect(text('.stats-kpi-value')).toBe('0 / 9');
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
      expect(text('.stats-kpi-value')).toBe('0 / ?');
      expect(text('.stats-kpi')).toBe('Módulos 0 / ?');
      expect(text('.stats-planning-warning')).toContain('2 proyecto(s)');
    });

    it('keeps the calculable demand visible alongside planning warnings', () => {
      stats.planificacion!.sin_planificar = 1;
      stats.esperado.proyectos_sin_objetivo = 1;
      render();
      expect(text('.stats-kpi-value')).toBe('0 / 9');
      expect(text('.stats-planning-warning')).toContain('1 proyecto(s)');
    });

    it('shows zero demand when no projects need more production', () => {
      stats.planificacion!.modulos_por_dia = 0;
      stats.esperado.modulos_esperados = 0;
      render();
      expect(text('.stats-kpi-value')).toBe('0 / 0');
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
      expect(text('.stats-kpi-value')).toBe('0 / 9');
    });

    it('labels retained statistics as stale after a failed silent refresh', () => {
      vi.spyOn(TestBed.inject(ApiService), 'getProductionStats')
        .mockReturnValue(throwError(() => new Error('unavailable')));
      component.loadStats(true);
      render();
      expect(component.statsData).toBe(stats);
      expect(text('.stats-error')).toContain('últimos datos disponibles');
      expect(fixture.nativeElement.querySelectorAll('.stats-kpi').length).toBe(6);
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

  it('uses inherited factory weekdays for today and the coming week', () => {
    const project = {
      modulos_count: 10, modulos_completados: 0, fecha_montaje: '2026-09-08',
      planificacion: {modulos_por_dia: 3, fecha_calculo: '2026-09-04', dias_produccion: ['SAT', 'SUN']},
    } as Proyecto;
    expect(component.getProyectoHoy(project)).toBe(0);
    expect(component.getProyectoSemana(project)).toBe(6);
    project.planificacion!.fecha_calculo = '2026-09-05';
    expect(component.getProyectoHoy(project)).toBe(3);
    expect(component.getProyectoSemana(project)).toBe(3);
    project.planificacion!.dias_produccion = [];
    expect(component.getProyectoHoy(project)).toBe(0);
    expect(component.getProyectoSemana(project)).toBe(0);
  });

  it('shows only real production hours, including completions before 08h', () => {
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

    expect(buckets.map(bucket => bucket.key)).toEqual(['07', '09']);
    expect(buckets.map(bucket => bucket.label)).toEqual(['07h', '09h']);
    expect(buckets.every(bucket => bucket.meta_modulos === 0)).toBe(true);
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

  it('orders project modules naturally by name by default', () => {
    component.planModalModulos = [
      { id: 10, nombre: 'A10', completado_at: null } as Modulo,
      { id: 2, nombre: 'A2', completado_at: null } as Modulo,
      { id: 1, nombre: 'A01', completado_at: null } as Modulo,
    ];

    expect(component.planModalSortedModulos().map(modulo => modulo.nombre))
      .toEqual(['A01', 'A2', 'A10']);
  });

  it('orders active modules first, then recent completions and pending modules', () => {
    component.planModalSort = 'completed';
    component.planModalModulos = [
      { id: 3, nombre: 'A03', estado: 'PENDIENTE', estado_operativo: 'PENDIENTE', completado_at: null } as Modulo,
      { id: 1, nombre: 'A01', estado: 'COMPLETADO', estado_operativo: 'COMPLETADO', completado_at: '2026-08-18T08:30:00Z' } as Modulo,
      { id: 5, nombre: 'A05', estado: 'PENDIENTE', estado_operativo: 'EN_PROGRESO', completado_at: null } as Modulo,
      { id: 4, nombre: 'A04', estado: 'PENDIENTE', estado_operativo: 'PENDIENTE', completado_at: 'invalid-date' } as Modulo,
      { id: 2, nombre: 'A02', estado: 'COMPLETADO', estado_operativo: 'COMPLETADO', completado_at: '2026-08-19T07:15:00Z' } as Modulo,
    ];

    expect(component.planModalSortedModulos().map(modulo => modulo.nombre))
      .toEqual(['A05', 'A02', 'A01', 'A03', 'A04']);
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

    it('keeps each phase, completion date and reset action together', () => {
      const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.plan-modulo-row');
      expect(rows.length).toBe(2);
      const phases = rows[0].querySelectorAll('.plan-phase-row');
      expect(phases.length).toBe(2);
      expect(phases[0].querySelector('.plan-phase-details strong')?.textContent).toBe('Inferior');
      expect(phases[0].querySelector('time')?.getAttribute('datetime')).toBe('2026-09-04T10:30:00Z');
      expect(phases[1].querySelector('.plan-phase-details strong')?.textContent).toBe('Superior');
      expect(phases[1].querySelector('time')).toBeNull();
      expect(rows[1].querySelector('.plan-phase-details small')?.textContent).toBe('Fecha no registrada');
      expect(phases[1].querySelector('button')?.getAttribute('aria-label')).toBe('Reiniciar fase superior de A01');
      expect(rows[0].querySelector('.plan-modulo-action')).not.toBeNull();
    });

    it('opens confirmation only for the selected phase and cancels without changing its counterpart', () => {
      const button: HTMLButtonElement = fixture.nativeElement.querySelector('[aria-label="Reiniciar fase superior de A01"]');
      button.click();
      fixture.detectChanges();
      expect(component.phaseResetTarget?.phase).toBe('SUPERIOR');
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
      const buttons: NodeListOf<HTMLButtonElement> = fixture.nativeElement.querySelectorAll('.plan-phase-row button');
      expect(buttons.length).toBe(4);
      expect(Array.from(buttons).every(button => button.disabled)).toBe(true);
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
