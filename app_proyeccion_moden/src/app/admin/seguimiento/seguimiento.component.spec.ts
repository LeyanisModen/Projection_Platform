import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { ApiService, ProductionStatsModulo, ProductionStatsResponse, SeguimientoResponse } from '../../services/api.service';
import {
  SeguimientoComponent, cuando, estadoAhora, etiquetaPeriodo, graficaDe, isoLocal, moverReferencia, porProyecto, rangoDe,
} from './seguimiento.component';

const LISTA: SeguimientoResponse = {
  ferrallas: [{ id: 7, nombre: 'Sanchos' }, { id: 8, nombre: 'Europa' }],
  ferralla: null,
};

function ahora(campos: Partial<SeguimientoResponse> = {}): SeguimientoResponse {
  return {
    ...LISTA,
    ferralla: { id: 7, nombre: 'Sanchos' },
    ahora: '2026-11-10T10:00:00+01:00',
    mesas: 3,
    mesas_trabajando: 0,
    mesas_en_pausa: 0,
    ultima_senal: '2026-11-10T09:38:00+01:00',
    turno: { nombre: 'Mañana', inicio: '2026-11-10T06:00:00+01:00', fin: '2026-11-10T16:00:00+01:00' },
    siguiente_turno: { nombre: 'Mañana', inicio: '2026-11-11T06:00:00+01:00', fin: '2026-11-11T16:00:00+01:00' },
    en_mesa: [],
    ...campos,
  };
}

function modulo(proyecto: number, nombre: string, kilos: number): ProductionStatsModulo {
  return { id: Math.random(), nombre: 'M', proyecto_id: proyecto, proyecto_nombre: nombre, peso_kg: kilos } as unknown as ProductionStatsModulo;
}

function stats(from: string, to: string, campos: Partial<ProductionStatsResponse> = {}): ProductionStatsResponse {
  return {
    range: { from, to, working_days: 1, horas: ['06', '07', '08', '09', '10', '11'], dias: [] },
    totals: { modulos_completados: 3, peso_total_kg: 1830.4, horas_trabajo: 3.4, horas_muertas: 0.6 },
    por_mesa: [],
    por_dia: [],
    por_hora: [{ hora: '07', modulos_completados: 1 }, { hora: '09', modulos_completados: 2 }],
    esperado: { modulos_esperados: 24 },
    modulos: [modulo(1, 'OBRA_P01', 600), modulo(2, 'OBRA_P02', 630.4), modulo(1, 'OBRA_P01', 600)],
    ...campos,
  } as unknown as ProductionStatsResponse;
}

describe('periodos del seguimiento', () => {
  it('la semana va de lunes y el periodo en curso llega hasta hoy', () => {
    expect(rangoDe('dia', '2026-11-10', '2026-11-10')).toEqual({ from: '2026-11-10', to: '2026-11-10' });
    expect(rangoDe('semana', '2026-11-10', '2026-11-10')).toEqual({ from: '2026-11-09', to: '2026-11-10' });
    expect(rangoDe('semana', '2026-11-08', '2026-11-10')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(rangoDe('mes', '2026-11-10', '2026-11-10')).toEqual({ from: '2026-11-01', to: '2026-11-10' });
    expect(rangoDe('mes', '2026-10-01', '2026-11-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('se mueve de dia, de semana o de mes', () => {
    expect(moverReferencia('dia', '2026-11-01', -1)).toBe('2026-10-31');
    expect(moverReferencia('semana', '2026-11-10', -1)).toBe('2026-11-03');
    expect(moverReferencia('mes', '2026-03-31', -1)).toBe('2026-02-01');
    expect(etiquetaPeriodo('semana', { from: '2026-11-09', to: '2026-11-10' })).toBe('del 09/11 al 10/11');
    expect(etiquetaPeriodo('mes', { from: '2026-10-01', to: '2026-10-31' })).toBe('octubre 2026');
  });

  it('dice cuando fue con hoy, ayer o la fecha', () => {
    expect(cuando('2026-11-10T09:38:00+01:00', '2026-11-10')).toBe('hoy a las 09:38');
    expect(cuando('2026-11-09T22:10:00+01:00', '2026-11-10')).toBe('ayer a las 22:10');
    expect(cuando('2026-11-11T06:00:00+01:00', '2026-11-10')).toBe('mañana a las 06:00');
    expect(cuando('2026-11-06T15:58:00+01:00', '2026-11-10')).toMatch(/^el .+ 6 nov a las 15:58$/);
  });
});

describe('estadoAhora', () => {
  const hoy = '2026-11-10';

  it('trabajando, con cuantas mesas y hasta cuando es el turno', () => {
    expect(estadoAhora(ahora({ mesas_trabajando: 2, ultima_senal: '2026-11-10T09:58:00+01:00' }), hoy)).toEqual({
      texto: 'Trabajando', tono: 'ok', detalle: ['2 de 3 mesas', 'Mañana hasta las 16:00'],
    });
    expect(estadoAhora(ahora({ mesas_trabajando: 1, turno: null }), hoy)?.detalle).toEqual([
      '1 de 3 mesas', 'fuera de turno', 'entra mañana a las 06:00',
    ]);
  });

  it('parados en turno desde la ultima marca, o sin empezar si no han marcado en el turno', () => {
    expect(estadoAhora(ahora(), hoy)).toEqual({ texto: 'Parados', tono: 'warn', detalle: ['desde las 09:38', 'Mañana hasta las 16:00'] });
    expect(estadoAhora(ahora({ ultima_senal: '2026-11-09T15:50:00+01:00' }), hoy)).toEqual({
      texto: 'Sin empezar', tono: 'warn', detalle: ['Mañana desde las 06:00'],
    });
    expect(estadoAhora(ahora({ ultima_senal: null }), hoy)?.texto).toBe('Sin empezar');
  });

  it('fuera de turno, con la ultima marca y cuando entran', () => {
    expect(estadoAhora(ahora({ turno: null, ultima_senal: '2026-11-10T15:58:00+01:00' }), hoy)).toEqual({
      texto: 'Fuera de turno', tono: 'muted', detalle: ['última marca hoy a las 15:58', 'entra mañana a las 06:00'],
    });
  });

  it('en pausa, sin mesas o sin datos', () => {
    expect(estadoAhora(ahora({ mesas_en_pausa: 3 }), hoy)?.texto).toBe('En pausa');
    expect(estadoAhora(ahora({ mesas_trabajando: 1, mesas_en_pausa: 1 }), hoy)?.detalle).toEqual([
      '1 de 3 mesas', '1 en pausa', 'Mañana hasta las 16:00',
    ]);
    expect(estadoAhora(ahora({ mesas: 0 }), hoy)).toEqual({ texto: 'Sin mesas', tono: 'muted', detalle: [] });
    expect(estadoAhora(LISTA, hoy)).toBeNull();
    expect(estadoAhora(null, hoy)).toBeNull();
  });
});

describe('lo terminado y su grafica', () => {
  it('por proyecto, el que mas modulos primero', () => {
    expect(porProyecto(stats('2026-11-10', '2026-11-10').modulos ?? [])).toEqual([
      { id: 1, nombre: 'OBRA_P01', modulos: 2, kilos: 1200 },
      { id: 2, nombre: 'OBRA_P02', modulos: 1, kilos: 630.4 },
    ]);
  });

  it('un dia va por horas y lo que aun no ha llegado no se pinta', () => {
    const grafica = graficaDe(stats('2026-11-10', '2026-11-10'), '2026-11-10', 9);
    expect(grafica?.labels).toEqual(['06h', '07h', '08h', '09h', '10h', '11h']);
    expect(grafica?.series[0].values).toEqual([0, 1, 0, 2, null, null]);
    expect(grafica?.pending).toEqual([false, false, false, true, false, false]);
    expect(grafica?.target).toBeNull();
    // Un dia pasado, entero.
    expect(graficaDe(stats('2026-11-09', '2026-11-09'), '2026-11-10', 9)?.series[0].values).toEqual([0, 1, 0, 2, 0, 0]);
  });

  it('una semana va por dias con el minimo de cada uno', () => {
    const semana = stats('2026-11-09', '2026-11-10', {
      range: {
        from: '2026-11-09', to: '2026-11-10', working_days: 2,
        dias: [{ fecha: '2026-11-09', turnos: 1, horas: 10, objetivo: 24 }, { fecha: '2026-11-10', turnos: 1, horas: 10, objetivo: 24 }],
      },
      por_dia: [{ fecha: '2026-11-09', modulos_completados: 19 }] as ProductionStatsResponse['por_dia'],
    });
    const grafica = graficaDe(semana, '2026-11-10', 9);
    expect(grafica?.labels).toEqual(['09/11', '10/11']);
    expect(grafica?.series[0].values).toEqual([19, 0]);
    expect(grafica?.target).toEqual([24, 24]);
    expect(grafica?.pending).toEqual([false, true]);
  });
});

describe('SeguimientoComponent', () => {
  let fixture: ComponentFixture<SeguimientoComponent>;
  let api: { getSeguimiento: ReturnType<typeof vi.fn>; getProductionStats: ReturnType<typeof vi.fn> };
  const el = (): HTMLElement => fixture.nativeElement;
  const hoy = isoLocal(new Date());

  beforeEach(async () => {
    try { localStorage.removeItem('seguimiento.ferralla'); } catch { /* sin almacenamiento */ }
    api = {
      getSeguimiento: vi.fn((usuario?: number) => of(usuario == null ? LISTA : ahora({
        mesas_trabajando: 2,
        en_mesa: [{ id: 1, nombre: 'OBRA_P01', modulos: 52, terminados: 34, fecha_montaje: '2026-11-30' }],
      }))),
      getProductionStats: vi.fn(() => of(stats(hoy, hoy))),
    };
    await TestBed.configureTestingModule({
      imports: [SeguimientoComponent],
      providers: [{ provide: ApiService, useValue: api }, provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(SeguimientoComponent);
    fixture.detectChanges();
  });

  it('elige la primera ferralla y ensena como esta, lo que hay en las mesas y lo de hoy', () => {
    expect(api.getSeguimiento).toHaveBeenCalledWith(7);
    expect(api.getProductionStats).toHaveBeenCalledWith({ from: hoy, to: hoy, usuario: 7 });
    const texto = el().textContent ?? '';
    expect(el().querySelector('.sg-estado-texto')?.textContent?.trim()).toBe('Trabajando');
    expect(el().querySelector('.sg-estado-texto')?.classList.contains('is-ok')).toBe(true);
    expect(texto).toContain('2 de 3 mesas');
    expect(texto).toContain('34 de 52 módulos');
    const kpis = Array.from(el().querySelectorAll('.sg-kpi')).map(k =>
      Array.from(k.children).map(c => c.textContent?.replace(/\s+/g, ' ').trim()).join(' | '));
    expect(kpis).toEqual(['Módulos | 3 / 24 mínimo', 'Kilos | 1.830 kg', 'Trabajo + muertas | 3,4 h + 0,6 h']);
    const terminados = Array.from(el().querySelectorAll('.sg-lista')[1].querySelectorAll('.sg-proyecto')).map(p => p.textContent);
    expect(terminados).toEqual(['OBRA_P01', 'OBRA_P02']);
    // Hoy no tiene siguiente.
    const siguiente = el().querySelector<HTMLButtonElement>('[aria-label="Periodo siguiente"]');
    expect(siguiente?.disabled).toBe(true);
  });

  it('otra ferralla u otro periodo vuelven a pedir con esa ferralla', () => {
    fixture.componentInstance.elegir(8);
    expect(api.getSeguimiento).toHaveBeenLastCalledWith(8);
    expect(api.getProductionStats).toHaveBeenLastCalledWith({ from: hoy, to: hoy, usuario: 8 });
    fixture.componentInstance.mover(-1);
    const ayer = moverReferencia('dia', hoy, -1);
    expect(api.getProductionStats).toHaveBeenLastCalledWith({ from: ayer, to: ayer, usuario: 8 });
    fixture.componentInstance.elegirPeriodo('mes');
    expect(api.getProductionStats).toHaveBeenLastCalledWith({ ...rangoDe('mes', hoy, hoy), usuario: 8 });
  });
});
