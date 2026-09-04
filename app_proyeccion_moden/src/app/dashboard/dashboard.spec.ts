import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Dashboard } from './dashboard';
import { Mesa, Modulo, Proyecto, ProductionStatsBucket, ProductionStatsResponse } from '../services/api.service';

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
