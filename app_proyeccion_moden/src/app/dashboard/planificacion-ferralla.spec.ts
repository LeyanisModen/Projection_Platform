import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
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
        kilos: { modulos: 1200, fabricado: 450, desperdicio: 35, sueltos: 300, otros: [{ id: 9, concepto: 'Esperas', kg: 80 }], total: 1580 },
      },
      {
        id: 2, nombre: 'RIPA_BH_P06', planta_etiqueta: null, edificio: null, edificio_nombre: null, fecha_entrega: '2026-11-10',
        entrega_orientativa: true, modulos_total: 4, modulos_completados: 0, estado: 'PLANIFICADO',
        kilos: { modulos: 600, fabricado: 0, desperdicio: 0, sueltos: null, otros: [], total: 600 },
      },
      {
        id: 3, nombre: 'RIPA_BH_P07', planta_etiqueta: null, edificio: null, edificio_nombre: null, fecha_entrega: null,
        entrega_orientativa: false, modulos_total: 64, modulos_completados: 0, estado: 'SIN_FECHA',
        kilos: { modulos: null, fabricado: 0, desperdicio: 0, sueltos: null, otros: [], total: null },
      },
    ],
  };
}

describe('PlanificacionFerralla', () => {
  let fixture: ComponentFixture<PlanificacionFerralla>;
  let api: { getPlanificacion: ReturnType<typeof vi.fn>; addKilosOtros: ReturnType<typeof vi.fn>; deleteKilosOtros: ReturnType<typeof vi.fn> };
  const el = (): HTMLElement => fixture.nativeElement;
  const texto = (nodo: Element | null | undefined): string => nodo?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const tarjetas = (): HTMLElement[] => Array.from(el().querySelectorAll('.pl-tarjeta'));

  beforeEach(async () => {
    api = {
      getPlanificacion: vi.fn().mockReturnValue(of(respuesta())),
      addKilosOtros: vi.fn(),
      deleteKilosOtros: vi.fn(),
    };
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
    expect(Array.from(el().querySelectorAll('.pl-kpi-value')).map(texto)).toEqual(['2', '12', '2,180 kg']);
    expect(Array.from(el().querySelectorAll('.lc-mark-label')).map(texto)).toEqual(['P05', 'P06']);
  });

  it('shows the kilos of each project: modules, loose elements (or pending) and its own lines', () => {
    const [primera, segunda] = tarjetas();
    expect(texto(primera.querySelector('h5'))).toBe('RIPA_BH_P05');
    // Dentro de la columna de su edificio, solo la planta.
    expect(texto(primera.querySelector('.pl-tarjeta-cabecera .pl-tenue'))).toBe('Planta 5');
    // La fecha y los modulos, cada uno a un lado de la linea.
    expect(texto(primera.querySelector('.pl-entrega strong'))).toBe('sáb 7 nov');
    expect(texto(primera.querySelector('.pl-entrega'))).toContain('Entrega a obra');
    expect(texto(primera.querySelector('.pl-modulos'))).toBe('3 / 8 módulos');
    expect(texto(primera.querySelector('.pl-total strong'))).toBe('1,580 kg');
    const filas = (tarjeta: HTMLElement) => Array.from(tarjeta.querySelectorAll('.pl-fila'))
      .map(fila => [texto(fila.querySelector('dt')), texto(fila.querySelector('dd'))]);
    expect(filas(primera)).toEqual([
      ['Módulos', '1,200 kg'], ['Fabricado · desperdicio', '450 kg · 35 kg'], ['Elementos sueltos', '300 kg'], ['Esperas', '80 kg'],
    ]);
    expect(texto(segunda.querySelector('.pl-entrega'))).toContain('orientativa');
    expect(segunda.querySelector('.pl-entrega strong')?.classList.contains('pl-orientativa')).toBe(true);
    expect(filas(segunda)[2]).toEqual(['Elementos sueltos', 'pendiente']);
    // Sin modulos subidos: sus kilos, pendientes, y sin total.
    const tercera = tarjetas()[2];
    expect(texto(tercera.querySelector('.pl-entrega'))).toContain('Sin fecha de entrega');
    expect(filas(tercera)).toEqual([['Módulos', 'pendiente'], ['Elementos sueltos', 'pendiente']]);
    expect(texto(tercera.querySelector('.pl-total strong'))).toBe('—');
  });

  it('puts each building in a column with the kilos of its slabs added up', () => {
    const columnas = Array.from(el().querySelectorAll('.pl-columna')) as HTMLElement[];
    const cabeceras = columnas.map(c => c.querySelector('.pl-columna-cabecera') as HTMLElement);
    expect(cabeceras.map(c => texto(c.querySelector('h4')))).toEqual(['Bloque H', 'Sin edificio']);
    expect(columnas.map(c => c.querySelectorAll('.pl-tarjeta').length)).toEqual([1, 2]);
    expect(cabeceras.map(c => texto(c.querySelector('.pl-total strong')))).toEqual(['1,580 kg', '600 kg']);
    // Lo que aun no tiene kilos no suma y se dice.
    expect(cabeceras.map(c => texto(c.querySelector(':scope > .pl-tenue')))).toEqual(['1 forjado', '2 forjados · 1 sin kilos de módulos']);
  });

  it('adds a line of other kilos and the total follows', () => {
    api.addKilosOtros.mockReturnValue(of([{ id: 10, concepto: 'Mallas de reparto', kg: 125.5 }]));
    const segunda = () => tarjetas()[1];
    const [concepto, kg] = Array.from(segunda().querySelectorAll('input')) as HTMLInputElement[];
    concepto.value = 'Mallas de reparto';
    concepto.dispatchEvent(new Event('input'));
    kg.value = '125,5';
    kg.dispatchEvent(new Event('input'));
    segunda().querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(api.addKilosOtros).toHaveBeenCalledWith(2, { concepto: 'Mallas de reparto', kg: '125,5' });
    expect(texto(segunda().querySelector('.pl-total strong'))).toBe('726 kg');
    expect(texto(segunda().querySelector('.pl-otro dt'))).toBe('Mallas de reparto');
    expect(texto(segunda().querySelector('.pl-otro dd'))).toBe('125.5 kg');
    expect(fixture.componentInstance.nuevoConcepto[2]).toBe('');
    // Y el de su columna.
    const cabecera = el().querySelectorAll('.pl-columna-cabecera')[1];
    expect(texto(cabecera.querySelector('.pl-total strong'))).toBe('726 kg');
  });

  it('says why a line was not saved and removes one', () => {
    const primera = () => tarjetas()[0];
    primera().querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(texto(primera().querySelector('.pl-error'))).toBe('Pon el concepto y los kilos.');
    expect(api.addKilosOtros).not.toHaveBeenCalled();

    fixture.componentInstance.nuevoConcepto[1] = 'Algo';
    fixture.componentInstance.nuevoKg[1] = '0';
    api.addKilosOtros.mockReturnValue(throwError(() => new HttpErrorResponse({
      status: 400, error: { kg: ['Los kilos tienen que ser mayores que cero.'] },
    })));
    primera().querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    expect(texto(primera().querySelector('.pl-error'))).toBe('Los kilos tienen que ser mayores que cero.');

    api.deleteKilosOtros.mockReturnValue(of([]));
    (primera().querySelector('.pl-quitar') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(api.deleteKilosOtros).toHaveBeenCalledWith(1, 9);
    expect(primera().querySelector('.pl-otro')).toBeNull();
    expect(texto(primera().querySelector('.pl-total strong'))).toBe('1,500 kg');
    expect(primera().querySelector('.pl-error')).toBeNull();
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
    expect(tarjetas().length).toBe(3);
  });
});
