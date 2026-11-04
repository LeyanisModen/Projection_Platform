import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';

import { ApiService, PlanoModulo, PlanoProyectoDatos } from '../services/api.service';
import { PlanoProyecto, tamanoTexto } from './plano-proyecto';

const modulo = (nombre: string, x: number, estado: PlanoModulo['estado'], bastidor: number | null, extra: Partial<PlanoModulo> = {}): PlanoModulo => ({
  nombre, x, y: 1, ancho: 4.8, alto: 1.8, estado, sd_de: null, inferior_hecho: false, superior_hecho: false, bastidor, ...extra,
});

function respuesta(): PlanoProyectoDatos {
  return {
    ancho: 20, alto: 10, canto_losa_cm: 23,
    contorno: [[0.5, 0.5], [19.5, 0.5], [19.5, 9.5], [0.5, 9.5]],
    huecos: [[[8, 5], [9, 5], [9, 6], [8, 6]]],
    huecos_circulares: [{ x: 2, y: 8, r: 0.17 }],
    pilares: [{ nombre: 'G02', puntos: [[10, 5], [10.4, 5], [10.4, 5.4]] }],
    modulos: [
      modulo('A01', 0.5, 'terminado', 1),
      modulo('A02', 5.3, 'terminado', 1),
      modulo('B01', 10.1, 'en_curso', 2, { inferior_hecho: true }),
      modulo('B02', 14.9, 'pendiente', 2),
      modulo('SDB01', 14.9, 'terminado', 2, { sd_de: 'B01', ancho: 1.2 }),
      modulo('X99', 14.9, null, null),
    ],
    bastidores: [
      { id: 1, indice: 1, etiqueta: 'Bastidor 1', modulos: 2, terminados: 2, terminado: true },
      { id: 2, indice: 2, etiqueta: 'Bastidor 2', modulos: 2, terminados: 0, terminado: false },
    ],
  };
}

describe('PlanoProyecto', () => {
  let fixture: ComponentFixture<PlanoProyecto>;
  let api: { getPlanoProyecto: ReturnType<typeof vi.fn> };
  const el = (): HTMLElement => fixture.nativeElement;
  const texto = (nodo: Element | null | undefined): string => nodo?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const modulos = (): SVGGElement[] => Array.from(el().querySelectorAll('g.pp-modulo'));
  const nombreDe = (g: Element): string => texto(g.querySelector('title')).split(' · ')[0];
  const porNombre = (nombre: string): SVGGElement => modulos().find(g => nombreDe(g) === nombre)!;

  async function crear(datos = of(respuesta())) {
    api = { getPlanoProyecto: vi.fn().mockReturnValue(datos) };
    await TestBed.configureTestingModule({
      imports: [PlanoProyecto],
      providers: [{ provide: ApiService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanoProyecto);
    fixture.componentRef.setInput('proyectoId', 7);
    fixture.componentRef.setInput('nombre', 'OBRA_P03');
    fixture.detectChanges();
  }

  it('pinta cada modulo por su estado y entero el bastidor terminado', async () => {
    await crear();
    expect(api.getPlanoProyecto).toHaveBeenCalledWith(7);
    expect(Array.from(el().querySelectorAll('.pp-kpi')).map(kpi => [texto(kpi.children[0]), texto(kpi.children[1])])).toEqual([
      ['Bastidores terminados', '1 / 2'], ['Módulos terminados', '2 / 4'],
    ]);
    expect(el().querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 20 10');
    expect(el().querySelector('svg')!.getAttribute('aria-label')).toBe('Plano de OBRA_P03');
    expect(el().querySelectorAll('.pp-hueco').length).toBe(2);
    expect(el().querySelectorAll('.pp-pilar').length).toBe(1);

    const clase = (nombre: string) => Array.from(porNombre(nombre).classList).find(c => c !== 'pp-modulo');
    expect(['A01', 'B01', 'B02', 'SDB01', 'X99'].map(clase)).toEqual([
      'pp-bastidor-terminado', 'pp-en-curso', 'pp-pendiente', 'pp-terminado', 'pp-ajeno',
    ]);
    expect(texto(porNombre('B01').querySelector('title'))).toBe('B01 · Bastidor 2 · Inferior hecho');
    expect(texto(porNombre('SDB01').querySelector('title'))).toBe('SDB01 · segundo superior de B01 · Bastidor 2 · Terminado');
    expect(texto(porNombre('A01').querySelector('title'))).toBe('A01 · Bastidor 1 terminado · Terminado');
    expect(texto(porNombre('X99').querySelector('title'))).toBe('X99 · no es un módulo del proyecto');
    expect(Array.from(el().querySelectorAll('.pp-bastidores button')).map(texto)).toEqual(['Bastidor 1 2/2', 'Bastidor 2 0/2']);
    expect(el().querySelector('.pp-bastidores .pp-hecho .fa-check')).not.toBeNull();
    // Los nombres van encima de huecos y pilares, con el color de su modulo.
    const etiqueta = Array.from(el().querySelectorAll('text.pp-etiqueta')).find(t => texto(t) === 'A01')!;
    expect(etiqueta.classList.contains('pp-bastidor-terminado')).toBe(true);
    expect(etiqueta.previousElementSibling?.tagName.toLowerCase()).not.toBe('rect');
  });

  it('al pasar por un bastidor señala sus modulos y con un clic se queda fijado', async () => {
    await crear();
    const svg = () => el().querySelector('svg')!;
    const activos = () => modulos().filter(g => g.classList.contains('pp-activo')).map(nombreDe);
    const segundo = el().querySelectorAll('.pp-bastidores button')[1] as HTMLButtonElement;

    segundo.dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    expect(svg().classList.contains('con-resaltado')).toBe(true);
    expect(activos()).toEqual(['B01', 'B02', 'SDB01']);

    segundo.dispatchEvent(new Event('mouseleave'));
    fixture.detectChanges();
    expect(svg().classList.contains('con-resaltado')).toBe(false);

    segundo.click();
    fixture.detectChanges();
    expect(segundo.getAttribute('aria-pressed')).toBe('true');
    expect(activos()).toEqual(['B01', 'B02', 'SDB01']);
    // Pasar por un modulo de otro bastidor lo señala mientras tanto.
    porNombre('A01').dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    expect(activos()).toEqual(['A01', 'A02']);
    porNombre('A01').dispatchEvent(new Event('mouseleave'));
    segundo.click();
    fixture.detectChanges();
    expect(svg().classList.contains('con-resaltado')).toBe(false);
  });

  it('avisa si la base tecnica no trae el plano', async () => {
    await crear(throwError(() => ({ error: { detail: 'La base técnica de este proyecto no trae el plano.' } })));
    expect(texto(el().querySelector('.pp-error'))).toBe('La base técnica de este proyecto no trae el plano.');
    expect(el().querySelector('svg')).toBeNull();
  });

  it('ajusta el nombre a su rectangulo', () => {
    expect(tamanoTexto({ nombre: 'A01', ancho: 4.8, alto: 1.8 })).toBe(0.5);
    expect(tamanoTexto({ nombre: 'SDB05', ancho: 1.2, alto: 1.8 })).toBeCloseTo(1.2 / (5 * 0.62));
    expect(tamanoTexto({ nombre: 'A01', ancho: 4.8, alto: 0.6 })).toBeCloseTo(0.216);
  });
});
