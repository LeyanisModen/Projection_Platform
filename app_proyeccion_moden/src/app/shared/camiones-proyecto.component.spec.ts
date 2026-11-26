import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { CamionesProyecto } from '../services/api.service';
import {
  CamionesProyectoComponent, DiaCamiones, ajustar, camionesPara, cargas, diaCorto, laborableAntes, textoEnvio,
} from './camiones-proyecto.component';

/** Arkaiate: 46 bastidores, 12 camiones, 4 al dia los tres dias antes del montaje del lunes 30. */
const porDefecto = (): CamionesProyecto => ({
  bastidores: 46, bastidores_estimados: false, montaje: '2026-11-30', salida: '2026-11-27', por_defecto: true, sobran: 0,
  camiones_por_dia: 4,
  envio: { camiones: 12, bastidores: 46, desde: '2026-11-25', hasta: '2026-11-27', dias: 3, dias_elegidos: null, dias_minimos: 3 },
  camiones: Array.from({ length: 12 }, (_v, i) => ({
    orden: i + 1, fecha: ['2026-11-25', '2026-11-26', '2026-11-27'][Math.floor(i / 4)], fecha_fija: false,
    bastidores: i === 11 ? 2 : 4, enviado: false, por_defecto: true,
  })),
});

const dia = (fecha: string | null, camiones: number, enviado = false): DiaCamiones => ({ fecha, camiones, enviado, fija: true });

describe('Camiones de un forjado', () => {
  let fixture: ComponentFixture<CamionesProyectoComponent>;
  let http: HttpTestingController;
  const url = '/api/proyectos/7/camiones/';
  const texto = (selector: string) => Array.from(fixture.nativeElement.querySelectorAll(selector))
    .map(el => (el as HTMLElement).textContent!.replace(/\s+/g, ' ').trim());

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 18, 10));
    await TestBed.configureTestingModule({
      imports: [CamionesProyectoComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CamionesProyectoComponent);
    fixture.componentRef.setInput('proyectoId', 7);
    fixture.detectChanges();
    http.expectOne(url).flush(porDefecto());
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('counts trucks and the load of each one', () => {
    expect(diaCorto('2026-11-27')).toBe('vie 27/11');
    expect(laborableAntes('2026-11-23')).toBe('2026-11-20');
    expect(camionesPara(46, 4)).toBe(12);
    // Si el primero va con 2 de la planta de antes, lleva 2 de esta.
    expect(camionesPara(46, 2)).toBe(12);
    expect(cargas(10, 2)).toEqual([2, 4, 4]);
    expect(camionesPara(3, 4)).toBe(1);
  });

  it('moves what a day no longer takes to a new day before the first, and takes what a day gets from the earliest', () => {
    const hoy = '2026-11-18';
    const dias = [dia('2026-11-25', 4), dia('2026-11-26', 4), dia('2026-11-27', 4)];
    // Uno de menos el 26: una cuarta fila con uno, el laborable antes del primero.
    dias[1] = dia('2026-11-26', 3);
    expect(ajustar(dias, 12, 1, hoy)).toEqual([dia('2026-11-25', 4), dia('2026-11-26', 3), dia('2026-11-27', 4), dia('2026-11-24', 1)]);
    // Seis el 27: salen dos del dia mas temprano.
    const mas = [dia('2026-11-25', 4), dia('2026-11-26', 4), dia('2026-11-27', 6)];
    expect(ajustar(mas, 12, 2, hoy)).toEqual([dia('2026-11-25', 2), dia('2026-11-26', 4), dia('2026-11-27', 6)]);
    // Lo enviado no se toca, y un dia que se queda sin camiones desaparece.
    const enviados = [dia('2026-11-17', 2, true), dia('2026-11-25', 2), dia('2026-11-26', 4)];
    enviados[2] = dia('2026-11-26', 6);
    expect(ajustar(enviados, 8, 2, hoy)).toEqual([dia('2026-11-17', 2, true), dia('2026-11-26', 6)]);
    // Sin un laborable antes que no haya pasado, la fila nueva va sin dia.
    expect(ajustar([dia('2026-11-18', 3)], 4, 0, hoy)).toEqual([dia('2026-11-18', 3), dia(null, 1)]);
  });

  it('shows one row per day, four trucks each, before the montaje', () => {
    expect(texto('.cam-resumen')).toEqual(['46 bastidores · 12 camiones · el último lleva 2']);
    expect(texto('p.cam-envio')).toEqual(['Salen del mié 25/11 al vie 27/11, como mucho 4 al día']);
    expect(textoEnvio({ ...porDefecto(), envio: { ...porDefecto().envio, dias: 5, dias_elegidos: 5, desde: '2026-11-23' } }))
      .toBe('Salen del lun 23/11 al vie 27/11; el reparto, en 5 días elegidos en Planificación 2');
    const filas = fixture.componentInstance.dias;
    expect(filas.map(d => [d.fecha, d.camiones])).toEqual([['2026-11-25', 4], ['2026-11-26', 4], ['2026-11-27', 4]]);
    expect(fixture.nativeElement.querySelectorAll('li.cam-defecto').length).toBe(3);
    // Nunca despues del montaje.
    const fechas = Array.from(fixture.nativeElement.querySelectorAll('li input[type=date]')) as HTMLInputElement[];
    expect(fechas.map(f => f.getAttribute('max'))).toEqual(['2026-11-30', '2026-11-30', '2026-11-30']);
    expect(fixture.nativeElement.querySelector('.btn-primary')).toBeNull();
  });

  it('lowers a day to three, adds a day with one, warns of a day with too many and saves them all by hand', () => {
    const componente = fixture.componentInstance;
    componente.cambiarCamiones(0, 3);
    fixture.detectChanges();
    expect(componente.dias.map(d => [d.fecha, d.camiones])).toEqual([
      ['2026-11-25', 3], ['2026-11-26', 4], ['2026-11-27', 4], ['2026-11-24', 1],
    ]);
    componente.cambiarCamiones(2, 5);
    fixture.detectChanges();
    expect(texto('.cam-aviso')).toEqual(['El vie 27/11 salen 5: la ferralla saca 4 al día.']);
    // Despues del montaje no se guarda.
    componente.cambiarFecha(1, '2026-12-01');
    (fixture.nativeElement.querySelector('.btn-primary') as HTMLButtonElement).click();
    expect(componente.error).toBe('Ningún camión puede salir después del montaje (lun 30/11).');
    componente.cambiarFecha(1, '2026-11-26');
    (fixture.nativeElement.querySelector('.btn-primary') as HTMLButtonElement).click();
    const guardar = http.expectOne(r => r.url === url && r.method === 'PUT');
    const enviados = guardar.request.body.camiones as Array<{ fecha: string; fecha_fija: boolean; bastidores: number }>;
    // El 24 ya no tiene: el que le quedaba se fue al dia de 5.
    const porDia: Record<string, number> = {};
    for (const c of enviados) porDia[c.fecha] = (porDia[c.fecha] ?? 0) + 1;
    expect(porDia).toEqual({ '2026-11-25': 3, '2026-11-26': 4, '2026-11-27': 5 });
    expect(enviados.every(c => c.fecha_fija)).toBe(true);
    expect(enviados.map(c => c.bastidores)).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 2]);
    guardar.flush(porDefecto());
    fixture.detectChanges();
    expect(componente.cambiado).toBe(false);
  });

  it('lets the first truck carry fewer when it goes with the previous floor, and goes back to the default', () => {
    const componente = fixture.componentInstance;
    componente.cambiarPrimero(2);
    fixture.detectChanges();
    // 2 + 11·4 = 46: los mismos 12 camiones, y el ultimo va lleno.
    expect(texto('.cam-resumen')).toEqual(['46 bastidores · 12 camiones']);
    const botones = Array.from(fixture.nativeElement.querySelectorAll('.cam-acciones button')) as HTMLButtonElement[];
    botones.find(b => b.textContent!.includes('Por defecto'))!.click();
    http.expectOne(r => r.url === url && r.method === 'DELETE').flush(porDefecto());
    fixture.detectChanges();
    expect(componente.primero).toBe(4);
    expect(componente.cambiado).toBe(false);
  });
});
