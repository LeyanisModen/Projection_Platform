import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { ApiService, PlanificacionModenProyecto, PlanificacionModenResponse } from '../../services/api.service';
import { PlanificacionComponent, cifra, picoEstudio, porMes } from './planificacion.component';

function proyecto(id: number, nombre: string, fecha: string | null, pendientes: number, fantasma = false, kilos: number | null = 1000): PlanificacionModenProyecto {
  return {
    id, nombre, planta_etiqueta: null, edificio: null, edificio_nombre: null, fecha_entrega: fecha,
    entrega_orientativa: fantasma, modulos_total: pendientes, modulos_completados: 0, estado: 'PLANIFICADO',
    kilos: {
      modulos: null, modulos_subidos: 0, fabricado: 0, desperdicio: 0, sueltos: null,
      previstos: null, confirmado: kilos, previsto: null, total: kilos,
    },
    fantasma, pendiente_aceptar: false, modulos_pendientes: pendientes,
  };
}

function respuesta(): PlanificacionModenResponse {
  return {
    desde: '2026-11-02',
    hasta: '2027-05-02',
    ferrallas: [
      {
        ferralla: { id: 7, nombre: 'Sanchos' },
        dias: [
          { fecha: '2026-11-02', real: 1, con_fantasmas: 1.6 },
          { fecha: '2026-11-03', real: 1, con_fantasmas: 1.6 },
          { fecha: '2026-11-04', real: 0.7, con_fantasmas: 1.6 },
        ],
        festivos: [],
        entregas: [
          { proyecto: 1, nombre: 'OBRA_P01', fecha: '2026-11-03', orientativa: false, fantasma: false, modulos_pendientes: 8 },
          { proyecto: 3, nombre: 'TORRE_P01', fecha: '2026-11-04', orientativa: true, fantasma: true, modulos_pendientes: 10 },
        ],
        proyectos: [
          proyecto(1, 'OBRA_P01', '2026-11-03', 8),
          proyecto(3, 'TORRE_P01', '2026-11-04', 10, true, 1290),
          proyecto(2, 'OBRA_P02', '2026-12-20', 4),
        ],
        resumen: {
          ritmo_real: 1, ritmo_con_fantasmas: 1.6, manda_real: 'OBRA_P01', manda_con_fantasmas: 'TORRE_P01',
          fantasmas: 1, modulos_real: 12, modulos_fantasmas: 10, kilos_real: 2000, kilos_fantasmas: 1290,
        },
      },
      {
        ferralla: { id: 8, nombre: 'Europa' },
        dias: [{ fecha: '2026-11-02', real: 0, con_fantasmas: 0 }],
        festivos: [],
        entregas: [],
        proyectos: [],
        resumen: {
          ritmo_real: null, ritmo_con_fantasmas: null, manda_real: null, manda_con_fantasmas: null,
          fantasmas: 0, modulos_real: 0, modulos_fantasmas: 0, kilos_real: 0, kilos_fantasmas: 0,
        },
      },
    ],
  };
}

describe('PlanificacionComponent', () => {
  let fixture: ComponentFixture<PlanificacionComponent>;
  let api: { getPlanificacionModen: ReturnType<typeof vi.fn>; getUsers: ReturnType<typeof vi.fn>; createProyecto: ReturnType<typeof vi.fn> };
  const el = (): HTMLElement => fixture.nativeElement;
  const texto = (nodo: Element | null | undefined): string => nodo?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  beforeEach(async () => {
    api = {
      getPlanificacionModen: vi.fn().mockReturnValue(of(respuesta())),
      getUsers: vi.fn().mockReturnValue(of([{ id: 7, url: '/api/users/7/', username: 'sanchos', first_name: 'Sanchos' }])),
      createProyecto: vi.fn().mockReturnValue(of({ id: 9 })),
    };
    await TestBed.configureTestingModule({
      imports: [PlanificacionComponent],
      providers: [{ provide: ApiService, useValue: api }, provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanificacionComponent);
    fixture.detectChanges();
  });

  it('shows each factory with the pace it needs, with and without its ghosts', () => {
    const secciones = Array.from(el().querySelectorAll('.pm-ferralla'));
    expect(secciones.map(s => texto(s.querySelector('.pm-nombre')))).toEqual(['Sanchos', 'Europa']);
    const casillas = (s: Element) => Array.from(s.querySelectorAll('.pm-kpi')).map(k => [texto(k.querySelector('.pm-kpi-label')), texto(k.querySelector('.pm-kpi-value'))]);
    expect(casillas(secciones[0])).toEqual([
      // Primero lo real; despues lo que suman los proyectos en estudio.
      ['Para llegar', '1 mód./día'], ['Módulos por fabricar', '12'], ['Kilos a obra', '2.000 kg'],
      ['Con proyectos en estudio', '1,6 mód./día'], ['Módulos en estudio', '10'], ['Kilos en estudio', '1.290 kg'],
    ]);
    // Lo azul dice cuando: su dia mas alto y hasta donde sigue igual.
    expect(texto(secciones[0].querySelector('.pm-kpi-nota'))).toBe('del 02/11 al 04/11');
    // Sin fantasmas, solo lo real.
    expect(casillas(secciones[1]).map(c => c[0])).toEqual(['Para llegar', 'Módulos por fabricar', 'Kilos a obra']);

    const [sanchos, europa] = fixture.componentInstance.vistas();
    expect(sanchos.series.map(s => [s.name, s.values])).toEqual([['Con proyectos en estudio', [1.6, 1.6, 1.6]], ['Real', [1, 1, 0.7]]]);
    expect(europa.series.map(s => s.name)).toEqual(['Real']);
    // Sin nada que fabricar, sin grafica.
    expect(secciones.map(s => !!s.querySelector('app-stats-line-chart'))).toEqual([true, false]);
    expect(sanchos.marcas.map(m => [m.label, m.tenue])).toEqual([['OBRA_P01', false], ['TORRE_P01', true]]);
    expect(sanchos.marcas[1].detalle).toEqual(['Entrega TORRE_P01 (en estudio) · 10 mód. por fabricar']);
  });

  it('lists the deliveries by month with the ghosts tagged, each one opening its project', () => {
    const seccion = el().querySelector('.pm-ferralla')!;
    expect(Array.from(seccion.querySelectorAll('.pm-mes')).map(texto)).toEqual([
      'noviembre 2026 8 mód. · 10 en estudio · 2.290 kg', 'diciembre 2026 4 mód. · 1.000 kg',
    ]);
    const filas = Array.from(seccion.querySelectorAll('a.pm-fila'));
    expect(filas.map(f => texto(f.querySelector('.pm-proyecto')))).toEqual(['OBRA_P01', 'TORRE_P01 En estudio', 'OBRA_P02']);
    expect(filas[1].getAttribute('href')).toBe('/admin-dashboard/proyectos/3');
    // Lo que esta en estudio lleva el nombre en azul.
    expect(filas.map(f => f.classList.contains('pm-es-fantasma'))).toEqual([false, true, false]);
    // La fecha de un fantasma siempre es la de Moden: no se dice orientativa.
    expect(Array.from(filas[1].querySelectorAll('.pm-datos > span')).map(texto)).toEqual(['Entrega 04/11', '10 mód. por fabricar', '1.290 kg']);
  });

  it('finds the highest day the projects under study change, which is where to focus', () => {
    const dia = (fecha: string, real: number, con_fantasmas: number) => ({ fecha, real, con_fantasmas });
    expect(picoEstudio([
      // Hoy manda lo real (igual con y sin ellos): no cuenta aunque sea mas alto.
      dia('2026-11-09', 64, 64), dia('2026-11-10', 36, 36),
      dia('2026-11-19', 21.3, 26.7), dia('2026-11-20', 21.3, 26.7), dia('2026-11-23', 20, 24), dia('2026-11-24', 20, 26.7),
    ])).toEqual({ ritmo: 26.7, desde: '2026-11-19', hasta: '2026-11-20' });
    expect(picoEstudio([dia('2026-11-09', 5, 5), dia('2026-11-10', 3, 3)])).toBeNull();
  });

  it('puts what was due before and what has no date around the months', () => {
    const meses = porMes([
      proyecto(1, 'SIN', null, 3), proyecto(2, 'TARDE', '2026-10-30', 2), proyecto(3, 'ENERO', '2027-01-12', 1),
    ], '2026-11-02');
    expect(meses.map(m => m.nombre)).toEqual(['Entrega pasada', 'enero 2027', 'Sin fecha de entrega']);
    expect(cifra(null)).toBe('—');
    expect(cifra(24.44, 1)).toBe('24,4');
  });

  it('creates a ghost in a factory and reloads the planning', () => {
    const componente = fixture.componentInstance;
    componente.abrirNuevo(componente.vistas()[0]);
    componente.nuevo = { nombre: ' TORRE_P02 ', fecha_montaje: '2027-01-15', modulos_previstos: 40 };
    componente.crearFantasma();
    expect(api.createProyecto).toHaveBeenCalledWith({
      nombre: 'TORRE_P02', usuario: '/api/users/7/', fantasma: true, fecha_montaje: '2027-01-15', modulos_previstos: 40,
    });
    expect(componente.nuevoEn()).toBeNull();
    expect(api.getPlanificacionModen).toHaveBeenCalledTimes(2);
  });
});
