import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';

import { ApiService, PlanificacionResponse } from '../services/api.service';
import { PlanificacionFerralla, etiquetasCortas, fechaLarga } from './planificacion-ferralla';

function respuesta(): PlanificacionResponse {
  return {
    ferrallas: null,
    ferralla: { id: 2, nombre: 'Ferralia' },
    desde: '2026-11-02',
    hasta: '2027-02-02',
    // Lunes a jueves; el sabado 7 no se fabrica.
    dias: [
      { fecha: '2026-11-05', modulos: 1 }, { fecha: '2026-11-06', modulos: 1 },
      { fecha: '2026-11-09', modulos: 0.7 }, { fecha: '2026-11-10', modulos: 0 },
    ],
    festivos: [],
    tramos: [],
    entregas: [
      { proyecto: 1, nombre: 'RIPA_BH_P05', fecha: '2026-11-07', orientativa: false, modulos_pendientes: 8 },
      { proyecto: 2, nombre: 'RIPA_BH_P06', fecha: '2026-11-10', orientativa: true, modulos_pendientes: 4 },
    ],
    proyectos: [
      {
        id: 1, nombre: 'RIPA_BH_P05', planta_etiqueta: 'Planta 5', edificio: 4, edificio_nombre: 'Bloque H', fecha_entrega: '2026-11-07',
        entrega_orientativa: false, modulos_total: 8, modulos_completados: 3, estado: 'PLANIFICADO',
        kilos: {
          modulos: 1200, modulos_subidos: 8, fabricado: 450, desperdicio: 35, sueltos: 300,
          previstos: null, confirmado: 1500, previsto: null, total: 1500,
        },
      },
      {
        // Subidos 4 de 6: los otros 2, a la media de los suyos.
        id: 2, nombre: 'RIPA_BH_P06', planta_etiqueta: null, edificio: null, edificio_nombre: null, fecha_entrega: '2026-11-10',
        entrega_orientativa: true, modulos_total: 6, modulos_completados: 0, estado: 'PLANIFICADO',
        kilos: {
          modulos: 600, modulos_subidos: 4, fabricado: 0, desperdicio: 0, sueltos: null,
          previstos: { modulos: 2, peso_medio: 150, de: 'proyecto', kg: 300 }, confirmado: 600, previsto: 300, total: 900,
        },
      },
      {
        // Nada subido: todo previsto.
        id: 3, nombre: 'RIPA_BH_P07', planta_etiqueta: null, edificio: null, edificio_nombre: null, fecha_entrega: null,
        entrega_orientativa: false, modulos_total: 64, modulos_completados: 0, estado: 'SIN_FECHA',
        kilos: {
          modulos: null, modulos_subidos: 0, fabricado: 0, desperdicio: 0, sueltos: null,
          previstos: { modulos: 64, peso_medio: 129.1, de: 'ferralla', kg: 8262.4 }, confirmado: null, previsto: 8262.4, total: 8262.4,
        },
      },
      {
        // Previstos, pero sin ningun modulo pesado con que calcular.
        id: 4, nombre: 'OTRA_P01', planta_etiqueta: null, edificio: null, edificio_nombre: null, fecha_entrega: null,
        entrega_orientativa: false, modulos_total: 12, modulos_completados: 0, estado: 'SIN_FECHA',
        kilos: {
          modulos: null, modulos_subidos: 0, fabricado: 0, desperdicio: 0, sueltos: null,
          previstos: { modulos: 12, peso_medio: null, de: null, kg: null }, confirmado: null, previsto: null, total: null,
        },
      },
      {
        id: 5, nombre: 'OTRA_P02', planta_etiqueta: null, edificio: null, edificio_nombre: null, fecha_entrega: null,
        entrega_orientativa: false, modulos_total: 0, modulos_completados: 0, estado: 'SIN_FECHA',
        kilos: {
          modulos: null, modulos_subidos: 0, fabricado: 0, desperdicio: 0, sueltos: null,
          previstos: null, confirmado: null, previsto: null, total: null,
        },
      },
    ],
  };
}

describe('PlanificacionFerralla', () => {
  let fixture: ComponentFixture<PlanificacionFerralla>;
  let api: { getPlanificacion: ReturnType<typeof vi.fn> };
  const el = (): HTMLElement => fixture.nativeElement;
  const texto = (nodo: Element | null | undefined): string => nodo?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const tarjetas = (): HTMLElement[] => Array.from(el().querySelectorAll('.pl-tarjeta'));

  beforeEach(async () => {
    api = { getPlanificacion: vi.fn().mockReturnValue(of(respuesta())) };
    await TestBed.configureTestingModule({
      imports: [PlanificacionFerralla],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanificacionFerralla);
    fixture.detectChanges();
  });

  it('shortens the delivery names to what tells them apart and reads dates in Spanish', () => {
    expect(Array.from(etiquetasCortas(['RIPA_BH_P05', 'RIPA_BH_P06']).values())).toEqual(['P05', 'P06']);
    expect(Array.from(etiquetasCortas(['OBRA_B1_P01', 'OBRA_B2_P01']).values())).toEqual(['B1_P01', 'B2_P01']);
    expect(Array.from(etiquetasCortas(['ESN27_P1', 'RIPA_BH_P05', 'RIPA_BI_P05', 'RIPA_BH_P05']).values()))
      .toEqual(['P1', 'BH_P05', 'BI_P05']);
    expect(etiquetasCortas(['OBRA_P1', 'OTRA_P1']).get('OBRA_P1')).toBe('OBRA_P1');
    expect(Array.from(etiquetasCortas(['ESN27_P1']).values())).toEqual(['P1']);
    expect(fechaLarga('2026-11-12')).toBe('jue 12 nov');
  });

  it('draws the modules a day with each delivery marked, between days when it falls on a day off', () => {
    const componente = fixture.componentInstance;
    expect(componente.labels()).toEqual(['05/11', '06/11', '09/11', '10/11']);
    expect(componente.series()[0].values).toEqual([1, 1, 0.7, 0]);
    expect(componente.series()[0].tooltips).toEqual([null, null, null, 'Sin entregas por delante']);
    expect(componente.marcas()).toEqual([
      { index: 1.5, label: 'P05', tenue: false, detalle: ['Entrega RIPA_BH_P05 · 8 mód. por fabricar'] },
      { index: 3, label: 'P06', tenue: true, detalle: ['Entrega RIPA_BH_P06 (orientativa) · 4 mód. por fabricar'] },
    ]);
    expect(texto(el().querySelector('.pl-ventana'))).toBe('Próximos tres meses: del lun 2 nov al mar 2 feb');
    expect(Array.from(el().querySelectorAll('.pl-kpi-value')).map(texto)).toEqual(['2', '12', '2,400 kg']);
    expect(texto(el().querySelector('.pl-kpi .pl-reparto'))).toBe('2,100 confirmados · 300 previstos');
    expect(Array.from(el().querySelectorAll('.lc-mark-label')).map(texto)).toEqual(['P05', 'P06']);
  });

  it('shows the kilos of each project: confirmed from what is uploaded and forecast for what is still to come', () => {
    const [primera, segunda, tercera, cuarta, quinta] = tarjetas();
    expect(texto(primera.querySelector('h5'))).toBe('RIPA_BH_P05');
    // Dentro de la columna de su edificio, solo la planta.
    expect(texto(primera.querySelector('.pl-tarjeta-cabecera .pl-tenue'))).toBe('Planta 5');
    // La fecha y los modulos, cada uno a un lado de la linea.
    expect(texto(primera.querySelector('.pl-entrega strong'))).toBe('sáb 7 nov');
    expect(texto(primera.querySelector('.pl-entrega'))).toContain('Entrega a obra');
    expect(texto(primera.querySelector('.pl-modulos'))).toBe('3 / 8 módulos');
    expect(texto(primera.querySelector('.pl-total strong'))).toBe('1,500 kg');
    const filas = (tarjeta: HTMLElement) => Array.from(tarjeta.querySelectorAll('.pl-fila'))
      .map(fila => [texto(fila.querySelector('dt')), texto(fila.querySelector('dd'))]);
    expect(filas(primera)).toEqual([
      ['8 módulos confirmados', '1,200 kg'], ['Fabricado · desperdicio', '450 kg · 35 kg'], ['Elementos sueltos', '300 kg'],
    ]);
    // Todo confirmado: sin reparto.
    expect(primera.querySelector('.pl-reparto')).toBeNull();
    expect(primera.querySelector('form')).toBeNull();

    expect(texto(segunda.querySelector('.pl-entrega'))).toContain('orientativa');
    expect(segunda.querySelector('.pl-entrega strong')?.classList.contains('pl-orientativa')).toBe(true);
    expect(texto(segunda.querySelector('.pl-total strong'))).toBe('900 kg');
    expect(texto(segunda.querySelector('.pl-reparto'))).toBe('600 kg confirmados · 300 kg previstos');
    expect(filas(segunda)).toEqual([
      ['4 módulos confirmados', '600 kg'], ['Fabricado · desperdicio', '0 kg · 0 kg'],
      ['2 módulos previstos', '300 kg'], ['A 150 kg/módulo, media de sus módulos subidos', ''],
      ['Elementos sueltos', 'pendiente'],
    ]);

    // Nada subido: el total es todo previsto, en cursiva.
    expect(texto(tercera.querySelector('.pl-entrega'))).toContain('Sin fecha de entrega');
    expect(texto(tercera.querySelector('.pl-total strong'))).toBe('8,262 kg');
    expect(tercera.querySelector('.pl-total strong')?.classList.contains('pl-previsto')).toBe(true);
    expect(tercera.querySelector('.pl-reparto')).toBeNull();
    expect(filas(tercera)).toEqual([
      ['64 módulos previstos', '8,262 kg'], ['A 129 kg/módulo, media de los módulos de la ferralla', ''],
      ['Elementos sueltos', 'pendiente'],
    ]);

    expect(filas(cuarta)).toEqual([['12 módulos previstos', 'sin peso medio'], ['Elementos sueltos', 'pendiente']]);
    expect(texto(cuarta.querySelector('.pl-total strong'))).toBe('—');
    expect(filas(quinta)).toEqual([['Módulos', 'pendiente'], ['Elementos sueltos', 'pendiente']]);
  });

  it('puts each building in a column with the kilos of its slabs added up, confirmed and forecast', () => {
    const columnas = Array.from(el().querySelectorAll('.pl-columna')) as HTMLElement[];
    const cabeceras = columnas.map(c => c.querySelector('.pl-columna-cabecera') as HTMLElement);
    expect(cabeceras.map(c => texto(c.querySelector('h4')))).toEqual(['Bloque H', 'Sin edificio']);
    expect(columnas.map(c => c.querySelectorAll('.pl-tarjeta').length)).toEqual([1, 4]);
    expect(cabeceras.map(c => texto(c.querySelector('.pl-total strong')))).toEqual(['1,500 kg', '9,162 kg']);
    expect(cabeceras.map(c => texto(c.querySelector('.pl-reparto')))).toEqual(['', '600 kg confirmados · 8,562 kg previstos']);
    // Lo que aun no tiene kilos no suma y se dice.
    expect(cabeceras.map(c => texto(c.querySelector(':scope > .pl-tenue')))).toEqual(['1 forjado', '4 forjados · 2 sin kilos']);
  });

  it('offers a retry when it cannot load', () => {
    api.getPlanificacion.mockReturnValue(throwError(() => new Error('caida')));
    fixture.componentInstance.cargar();
    fixture.detectChanges();
    expect(texto(el().querySelector('[role="alert"]'))).toContain('No se pudo cargar la planificación.');
    api.getPlanificacion.mockReturnValue(of(respuesta()));
    (el().querySelector('.pl-estado .pl-boton') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.getPlanificacion).toHaveBeenLastCalledWith(2);
    expect(tarjetas().length).toBe(5);
  });
});
