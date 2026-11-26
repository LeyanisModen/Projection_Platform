import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { ApiService, CamionesForjado, PlanificacionModenProyecto, PlanificacionModenResponse } from '../../services/api.service';
import { CamionesProyectoComponent } from '../../shared/camiones-proyecto.component';
import {
  FerrallaPlanificacion, PlanificacionComponent, bandasPatio, cifra, columnaDe, obrasDe, picoEstudio, porMes, textoCapacidades, textoNoCabe,
  textoNoLlegan, textoSobrecargas,
} from './planificacion.component';

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

/** Los camiones de una obra en la ventana: de 4 en 4 (el ultimo, lo que quede), 4 al dia en ``dias``. */
function camionesObra(id: number, nombre: string, montaje: string, dias: string[], bastidores: number, fantasma = false, porDefecto = true): CamionesForjado {
  const camiones = Math.ceil(bastidores / 4);
  return {
    id, nombre, fantasma, bastidores, bastidores_estimados: false, montaje, salida: dias[dias.length - 1], por_defecto: porDefecto, sobran: 0,
    camiones_por_dia: 4,
    envio: { camiones, bastidores, desde: dias[0], hasta: dias[dias.length - 1], dias: dias.length, dias_elegidos: null, dias_minimos: dias.length },
    camiones: Array.from({ length: camiones }, (_v, i) => ({
      orden: i + 1, fecha: dias[Math.floor(i / 4)], fecha_fija: !porDefecto, bastidores: Math.min(4, bastidores - 4 * i),
      enviado: false, por_defecto: porDefecto,
    })),
  };
}

function respuesta(): PlanificacionModenResponse {
  return {
    desde: '2026-11-02',
    hasta: '2027-05-02',
    opciones: [{ id: 8, nombre: 'Europa' }, { id: 7, nombre: 'Sanchos' }],
    elegida: 7,
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
          {
            ...proyecto(1, 'OBRA_P01', '2026-11-03', 8), fabricacion_inicio: '2026-11-02', fabricacion_fin: '2026-11-02',
            envio: {
              camiones: 2, bastidores: 6, desde: '2026-11-02', hasta: '2026-11-02', dias: 1, dias_elegidos: null, dias_minimos: 1,
              salidas: [{ fecha: '2026-11-02', camiones: 2 }],
            },
          },
          {
            ...proyecto(3, 'TORRE_P01', '2026-11-04', 10, true, 1290), fabricacion_inicio: '2026-11-02', fabricacion_fin: '2026-11-03',
            envio: {
              camiones: 1, bastidores: 2, desde: '2026-11-03', hasta: '2026-11-03', dias: 1, dias_elegidos: null, dias_minimos: 1,
              salidas: [{ fecha: '2026-11-03', camiones: 1 }],
            },
          },
          {
            ...proyecto(2, 'OBRA_P02', '2026-12-20', 4), fabricacion_inicio: '2026-11-04', fabricacion_fin: '2026-11-30',
            envio: {
              camiones: 3, bastidores: 10, desde: '2026-12-17', hasta: '2026-12-18', dias: 2, dias_elegidos: 2, dias_minimos: 1,
              salidas: [{ fecha: '2026-12-17', camiones: 2 }, { fecha: '2026-12-18', camiones: 1 }],
            },
          },
        ],
        camiones: { por_dia: 3, sobrecargas_real: [], sobrecargas_con_fantasmas: [] },
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
  let api: {
    getPlanificacionModen: ReturnType<typeof vi.fn>; getUsers: ReturnType<typeof vi.fn>; createProyecto: ReturnType<typeof vi.fn>;
    guardarAcopio: ReturnType<typeof vi.fn>; guardarCamionesFerralla: ReturnType<typeof vi.fn>;
    getCamionesFerralla: ReturnType<typeof vi.fn>; guardarCamiones: ReturnType<typeof vi.fn>; camionesPorDefecto: ReturnType<typeof vi.fn>;
  };
  const el = (): HTMLElement => fixture.nativeElement;
  const texto = (nodo: Element | null | undefined): string => nodo?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  beforeEach(async () => {
    api = {
      getPlanificacionModen: vi.fn().mockReturnValue(of(respuesta())),
      getUsers: vi.fn().mockReturnValue(of([{ id: 7, url: '/api/users/7/', username: 'sanchos', first_name: 'Sanchos' }])),
      createProyecto: vi.fn().mockReturnValue(of({ id: 9 })),
      guardarAcopio: vi.fn().mockReturnValue(of([])),
      guardarCamionesFerralla: vi.fn().mockReturnValue(of({ camiones_por_dia: 2, proyectos: [] })),
      // Arkaiate: 46 bastidores, 12 camiones, 4 al dia los tres dias antes del montaje; la torre, en estudio y movida a mano.
      getCamionesFerralla: vi.fn().mockReturnValue(of({
        camiones_por_dia: 4,
        proyectos: [
          camionesObra(1, 'ARKAIATE_P03', '2027-03-01', ['2027-02-24', '2027-02-25', '2027-02-26'], 46),
          camionesObra(2, 'TORRE_P01', '2027-03-02', ['2027-03-01'], 6, true, false),
        ],
      })),
      guardarCamiones: vi.fn().mockReturnValue(of(camionesObra(1, 'ARKAIATE_P03', '2027-03-01', ['2027-02-24'], 4))),
      camionesPorDefecto: vi.fn().mockReturnValue(of(camionesObra(2, 'TORRE_P01', '2027-03-02', ['2027-03-01'], 6, true))),
    };
    await TestBed.configureTestingModule({
      imports: [PlanificacionComponent],
      providers: [{ provide: ApiService, useValue: api }, provideRouter([])],
    }).compileComponents();
    // Casi todo es de la pestana 2 (con el patio y los camiones); la 1, al final.
    TestBed.inject(ActivatedRoute).snapshot.data = { vista: 2 };
    fixture = TestBed.createComponent(PlanificacionComponent);
    fixture.detectChanges();
  });

  it('shows each factory with the pace it needs, with and without its ghosts', () => {
    // Sin elegir, la que decide el servidor.
    expect(api.getPlanificacionModen).toHaveBeenCalledWith(2, null);
    expect(texto(el().querySelector('h1'))).toBe('Planificación 2');
    const secciones = Array.from(el().querySelectorAll('.pm-ferralla'));
    expect(texto(secciones[0].querySelector('.pm-cabecera .meta'))).toBe('Del lun 2 nov al dom 2 may');
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

    // Debajo, cuando se fabrica cada obra en las mismas columnas, con su nombre.
    expect(secciones.map(s => !!s.querySelector('app-fabricacion-obras'))).toEqual([true, false]);
    expect(sanchos.obras.map(o => [o.nombre, o.desde, o.hasta, o.montaje, o.salidas.map(x => [x.columna, x.camiones]), o.estudio])).toEqual([
      ['OBRA_P01', 0, 0, 1, [[0, 2]], false],
      ['TORRE_P01', 0, 1, 2, [[1, 1]], true],
      // Se monta despues de la vista: la fabricacion sigue hasta el borde y sus camiones no se ven.
      ['OBRA_P02', 2, 2, null, [], false],
    ]);
    expect(sanchos.obras[1].detalle)
      .toBe('TORRE_P01 (en estudio) · fabricación del 02/11 al 03/11 (10 mód.) · 1 camión el 03/11 · montaje 04/11');
    expect(Array.from(secciones[0].querySelectorAll('.fo-nombre')).map(texto)).toEqual(['OBRA_P01', 'TORRE_P01', 'OBRA_P02']);
    // Pinchar una obra abre su ficha.
    const router = TestBed.inject(Router);
    const navegar = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    (secciones[0].querySelectorAll('.fo-obra')[1] as SVGGElement).dispatchEvent(new MouseEvent('click'));
    expect(navegar).toHaveBeenCalledWith(['/admin-dashboard/proyectos', 3]);
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

  it('places each date on the chart columns and draws a finished slab only waiting for its mounting', () => {
    const dias = [{ fecha: '2026-11-06' }, { fecha: '2026-11-09' }];
    expect(columnaDe(dias, '2026-11-06')).toBe(0);
    // Un sabado, entre el viernes y el lunes; antes de la vista, delante; despues, fuera.
    expect(columnaDe(dias, '2026-11-07')).toBe(0.5);
    expect(columnaDe(dias, '2026-11-05')).toBe(-0.5);
    expect(columnaDe(dias, '2026-11-10')).toBeNull();
    const ferralla = respuesta().ferrallas[0];
    ferralla.proyectos = [{ ...proyecto(5, 'HECHO', '2026-11-04', 0), estado: 'COMPLETADO' }, proyecto(6, 'SIN_PLAN', '2026-11-04', 5)];
    expect(obrasDe(ferralla, '2026-11-02').map(o => [o.nombre, o.desde, o.hasta, o.montaje, o.detalle]))
      .toEqual([['HECHO', null, null, 2, 'HECHO · fabricado · montaje 04/11']]);
  });

  it('shows each work with its truck days, four a day, and saves the ones touched and the trucks a day', () => {
    const componente = fixture.componentInstance;
    componente.abrirCamiones(componente.vistas()[0]);
    expect(api.getCamionesFerralla).toHaveBeenCalledWith(7);
    expect(componente.camionesPorDia).toBe(4);
    fixture.detectChanges();
    const obras = Array.from(el().querySelectorAll('.pm-camiones-obra-fila'));
    expect(obras.map(o => [texto(o.querySelector('.pm-camiones-obra')), texto(o.querySelector('.pm-camiones-obra-datos .meta'))])).toEqual([
      ['ARKAIATE_P03', 'Montaje lun 01/03'], ['TORRE_P01En estudio', 'Montaje mar 02/03'],
    ]);
    // Una fila por dia; entre todas, los 12 camiones de la obra.
    const dias = (obra: Element) => Array.from(obra.querySelectorAll('li.cam-dia')).length;
    expect(obras.map(dias)).toEqual([3, 1]);
    expect(texto(obras[0].querySelector('.cam-resumen'))).toBe('46 bastidores · 12 camiones · el último lleva 2');
    // En la ventana no van el texto de envio ni lo que lleva el primero.
    expect(el().querySelector('.pm-camiones-modal .cam-envio')).toBeNull();
    expect(el().querySelector('.pm-camiones-modal .cam-primero')).toBeNull();

    const [arkaiate, torre] = fixture.debugElement.queryAll(By.directive(CamionesProyectoComponent))
      .map(d => d.componentInstance as CamionesProyectoComponent);
    // Bajar un dia a 3: otro dia con 1, el laborable antes del primero.
    arkaiate.cambiarCamiones(0, 3);
    fixture.detectChanges();
    expect(arkaiate.dias.map(d => [d.fecha, d.camiones])).toEqual([
      ['2027-02-24', 3], ['2027-02-25', 4], ['2027-02-26', 4], ['2027-02-23', 1],
    ]);
    // Despues del montaje no se guarda nada.
    arkaiate.cambiarFecha(1, '2027-03-02');
    componente.guardarCamiones();
    expect(componente.errorCamiones()).toBe('ARKAIATE_P03: Ningún camión puede salir después del montaje (lun 01/03).');
    expect(api.guardarCamiones).not.toHaveBeenCalled();
    arkaiate.cambiarFecha(1, '2027-02-25');
    // La torre, movida a mano, vuelve a los dias justos al guardar.
    (obras[1].querySelector('.cam-acciones button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(texto(obras[1].querySelector('.cam-a-defecto'))).toBe('Por defecto al guardar');

    componente.camionesPorDia = 3;
    componente.guardarCamiones();
    expect(api.guardarCamionesFerralla).toHaveBeenCalledWith(7, { camiones_por_dia: 3, proyectos: [] });
    const [id, camiones] = api.guardarCamiones.mock.calls[0] as [number, Array<{ fecha: string; fecha_fija: boolean; bastidores: number }>];
    const porDia: Record<string, number> = {};
    for (const c of camiones) porDia[c.fecha] = (porDia[c.fecha] ?? 0) + 1;
    expect([id, porDia]).toEqual([1, { '2027-02-23': 1, '2027-02-24': 3, '2027-02-25': 4, '2027-02-26': 4 }]);
    expect(camiones.every(c => c.fecha_fija)).toBe(true);
    expect(api.camionesPorDefecto).toHaveBeenCalledWith(2);
    expect(componente.camionesEn()).toBeNull();
    expect(api.getPlanificacionModen).toHaveBeenCalledTimes(2);
    fixture.detectChanges();
    expect(el().querySelector('.pm-camiones-dialogo')).toBeNull();

    // Sin tocar nada, se cierra sin guardar.
    componente.abrirCamiones(componente.vistas()[0]);
    fixture.detectChanges();
    componente.guardarCamiones();
    expect(api.guardarCamiones).toHaveBeenCalledTimes(1);
    expect(api.guardarCamionesFerralla).toHaveBeenCalledTimes(1);
    expect(componente.camionesEn()).toBeNull();
    expect(textoSobrecargas([{ fecha: '2026-12-04', camiones: 6 }, { fecha: '2026-12-07', camiones: 4.5 }], 4))
      .toBe('Salen más de 4 camiones al día: 6 el vie 04/12, 4,5 el lun 07/12');
    // Con muchos dias: cuantos, entre cuando y el peor.
    const muchos = ['2027-02-15', '2027-02-16', '2027-02-17', '2027-02-18'].map((fecha, i) => ({ fecha, camiones: 5 + i }));
    expect(textoSobrecargas(muchos, 4)).toBe('Salen más de 4 camiones al día en 4 días, del lun 15/02 al jue 18/02; hasta 8 el jue 18/02');
  });

  it('marks the days the yard is full, the trucks that do not fit and what does not reach its mounting', () => {
    const ferralla = respuesta().ferrallas[0];
    ferralla.acopio = {
      capacidades: [{ desde: '2026-11-02', bastidores: 4 }], excesos_real: [], excesos_con_fantasmas: [],
      llenos_real: ['2026-11-03'], llenos_con_fantasmas: ['2026-11-03', '2026-11-04'],
      dias: ferralla.dias.map(d => ({ fecha: d.fecha, real: 2, con_fantasmas: 3, capacidad: 4 })),
    };
    // Lo real llena el patio el martes; con lo que esta en estudio, tambien el miercoles.
    expect(bandasPatio(ferralla).map(b => [b.label, b.days])).toEqual([
      ['Patio lleno: solo se fabrica lo que sale', [false, true, false]],
      ['Patio lleno con lo que está en estudio', [false, false, true]],
    ]);
    ferralla.camiones = { por_dia: 3, sobrecargas_real: [], sobrecargas_con_fantasmas: [{ fecha: '2026-11-03', camiones: 5 }] };
    ferralla.modulos_dia_max = 6;
    const torre = { proyecto: 3, nombre: 'TORRE_P01', fantasma: true, montaje: '2026-11-04', fecha: '2026-11-03', faltan: 4 };
    ferralla.no_llegan_real = [];
    ferralla.no_llegan_con_fantasmas = [torre];
    const obras = obrasDe(ferralla, '2026-11-02');
    expect(obras[1].salidas).toEqual([{ columna: 1, camiones: 1, demas: true }]);
    expect(obras[1].noLlega).toBe('no llega: faltan 4 mód. el 03/11');
    expect(obras[1].detalle).toContain('entre todas, más de 3 camiones al día el 03/11');
    expect(textoNoLlegan([torre], 6))
      .toBe('No llegan a su montaje, fabricando como mucho 6 mód. al día: TORRE_P01 (montaje 04/11), faltan 4 mód. el mar 03/11');
    expect(textoNoLlegan([], 6)).toBeNull();

    api.getPlanificacionModen.mockReturnValue(of({ ...respuesta(), ferrallas: [ferralla] }));
    fixture.componentInstance.cargar();
    fixture.detectChanges();
    const avisos = Array.from(el().querySelectorAll('.pm-no-llegan')).map(texto);
    expect(avisos).toEqual(['Con los proyectos en estudio, además: no llegan a su montaje, fabricando como mucho 6 mód. al día: '
      + 'TORRE_P01 (montaje 04/11), faltan 4 mód. el mar 03/11']);
    // De los camiones, solo el dia que anade lo que esta en estudio.
    expect(Array.from(el().querySelectorAll('.pm-acopio-aviso')).map(texto))
      .toContain('Con los proyectos en estudio, además: salen más de 3 camiones al día: 5 el mar 03/11');
    // En el diagrama, el nombre de la que no llega va en rojo y los dias de patio lleno, sombreados.
    const nombres = Array.from(el().querySelectorAll('.fo-nombre')) as SVGTextElement[];
    expect(nombres.map(n => n.classList.contains('fo-no-llega'))).toEqual([false, true, false]);
    expect(el().querySelectorAll('app-fabricacion-obras rect.fo-banda').length).toBeGreaterThan(0);
    expect(Array.from(el().querySelectorAll('.fo-legend li')).map(texto)).toContain('Nombre en rojo: no llega');

    // En la ventana del acopio se dice lo que fabrican al dia como mucho.
    const componente = fixture.componentInstance;
    componente.abrirAcopio(componente.vistas()[0]);
    expect(componente.modulosDiaMax).toBe(6);
    componente.modulosDiaMax = 30;
    componente.guardarAcopio();
    expect(api.guardarAcopio).toHaveBeenCalledWith(7, [{ desde: '2026-11-02', bastidores: 4 }], 30);
  });

  it('puts what was due before and what has no date around the months', () => {
    const meses = porMes([
      proyecto(1, 'SIN', null, 3), proyecto(2, 'TARDE', '2026-10-30', 2), proyecto(3, 'ENERO', '2027-01-12', 1),
    ], '2026-11-02');
    expect(meses.map(m => m.nombre)).toEqual(['Entrega pasada', 'enero 2027', 'Sin fecha de entrega']);
    expect(cifra(null)).toBe('—');
    expect(cifra(24.44, 1)).toBe('24,4');
  });

  it('without a yard capacity there is no yard chart; with one, the yard against what fits and what does not fit', () => {
    expect(el().querySelector('.pm-acopio')).toBeNull();
    const datos = respuesta();
    datos.ferrallas[0].acopio = {
      capacidades: [{ desde: '2026-11-02', bastidores: 30 }, { desde: '2026-12-15', bastidores: 90 }],
      excesos_real: [],
      excesos_con_fantasmas: [{ fecha: '2026-11-03', bastidores: 2.4 }, { fecha: '2026-11-04', bastidores: 0.5 }],
      dias: [
        { fecha: '2026-11-02', real: 10, con_fantasmas: 12, capacidad: 30 },
        { fecha: '2026-11-03', real: 28, con_fantasmas: 32.4, capacidad: 30 },
        { fecha: '2026-11-04', real: 4, con_fantasmas: 30.5, capacidad: 30 },
      ],
    };
    datos.ferrallas[0].resumen.acopio_frena_real = '2026-11-04';
    api.getPlanificacionModen.mockReturnValue(of(datos));
    fixture.componentInstance.cargar();
    fixture.detectChanges();

    const seccion = el().querySelector('.pm-ferralla')!;
    expect(texto(seccion.querySelector('.pm-acopio-texto'))).toBe('Caben 30 bastidores · desde el 15/12, 90');
    // Lo real cabe; lo que esta en estudio no, y se dice en azul.
    expect(Array.from(seccion.querySelectorAll('.pm-acopio-aviso')).map(texto))
      .toEqual(['Con los proyectos en estudio: No cabe entre el 03/11 y el 04/11: faltan hasta 3 bastidores de sitio']);
    expect(texto(seccion.querySelector('.pm-kpi-nota'))).toBe('con el patio lleno hasta el 04/11');
    const acopio = fixture.componentInstance.vistas()[0].acopio!;
    expect(acopio.series.map(s => [s.name, s.values])).toEqual([['Con proyectos en estudio', [12, 32.4, 30.5]], ['Real', [10, 28, 4]]]);
    expect(acopio.capacidad).toEqual([30, 30, 30]);
    expect(seccion.querySelectorAll('app-stats-line-chart').length).toBe(2);
    expect(textoCapacidades([])).toBe('Sin límite de acopio');
    expect(textoNoCabe([{ fecha: '2026-11-03', bastidores: 1 }])).toBe('No cabe el 03/11: faltan hasta 1 bastidor de sitio');
  });

  it('saves the yard capacity of a factory by dates and reloads the planning', () => {
    const componente = fixture.componentInstance;
    componente.abrirAcopio(componente.vistas()[0]);
    // Sin capacidad, empieza con una fila desde hoy.
    expect(componente.filasAcopio).toEqual([{ desde: '2026-11-02', bastidores: 0 }]);
    componente.filasAcopio[0].bastidores = 30;
    componente.anadirFilaAcopio();
    expect(componente.acopioValido).toBe(false);
    componente.filasAcopio[1] = { desde: '2026-12-15', bastidores: '90' as unknown as number };
    expect(componente.acopioValido).toBe(true);
    componente.guardarAcopio();
    // Sin decir lo que fabrican al dia, va vacio.
    expect(api.guardarAcopio).toHaveBeenCalledWith(7, [{ desde: '2026-11-02', bastidores: 30 }, { desde: '2026-12-15', bastidores: 90 }], null);
    expect(componente.acopioEn()).toBeNull();
    expect(api.getPlanificacionModen).toHaveBeenCalledTimes(2);
  });

  it('tab 1: the minimum, what piles up in the yard if each job leaves whole the day before mounting, and when each one is made', () => {
    const datos = respuesta();
    const [sanchos, europa] = datos.ferrallas;
    // La pestana 1 no trae camiones ni acopio: el patio si todo sale el dia antes del montaje.
    for (const p of sanchos.proyectos) delete p.envio;
    delete sanchos.camiones;
    sanchos.patio = {
      capacidades: [{ desde: '2026-11-02', bastidores: 4 }],
      dias: [
        { fecha: '2026-11-02', real: 1.6, con_fantasmas: 3.6, capacidad: 4 },
        { fecha: '2026-11-03', real: 0, con_fantasmas: 5, capacidad: 4 },
        { fecha: '2026-11-04', real: 0.8, con_fantasmas: 0.8, capacidad: 4 },
      ],
    };
    europa.patio = { capacidades: [], dias: [{ fecha: '2026-11-02', real: 0, con_fantasmas: 0, capacidad: null }] };
    api.getPlanificacionModen.mockReturnValue(of({ ...datos, vista: 1 }));
    TestBed.inject(ActivatedRoute).snapshot.data = { vista: 1 };
    fixture = TestBed.createComponent(PlanificacionComponent);
    fixture.detectChanges();

    expect(api.getPlanificacionModen).toHaveBeenLastCalledWith(1, null);
    expect(texto(el().querySelector('h1'))).toBe('Planificación 1');
    // Nada de acopio ni camiones que tocar: solo el proyecto en estudio.
    expect(el().querySelector('.pm-acopio-btn')).toBeNull();
    expect(el().querySelector('.pm-camiones-btn')).toBeNull();
    const [vista, sinNada] = fixture.componentInstance.vistas();
    expect(vista.patio!.series.map(s => [s.name, s.values])).toEqual([['Con proyectos en estudio', [3.6, 5, 0.8]], ['Real', [1.6, 0, 0.8]]]);
    // Lo que cabe, solo como linea.
    expect(vista.patio!.capacidad).toEqual([4, 4, 4]);
    expect(sinNada.patio).toBeNull();
    const seccion = el().querySelector('.pm-ferralla')!;
    // Los modulos al dia, el patio y cuando se fabrica cada obra; sin avisos.
    expect(seccion.querySelectorAll('app-stats-line-chart').length).toBe(2);
    expect(seccion.querySelector('app-stats-line-chart.pm-patio')).not.toBeNull();
    expect(seccion.querySelectorAll('.pm-acopio-aviso').length).toBe(0);
    // En el diagrama no hay camiones: la barra, la espera en el patio y el montaje.
    expect(vista.obras.every(o => !o.salidas.length)).toBe(true);
    const leyenda = Array.from(seccion.querySelectorAll('.fo-legend li')).map(texto);
    expect(leyenda).not.toContain('Salen camiones');
    expect(leyenda).toContain('En el patio');
    expect(vista.obras[1].detalle).toBe('TORRE_P01 (en estudio) · fabricación del 02/11 al 03/11 (10 mód.) · montaje 04/11');
  });

  it('shows one factory at a time, chosen at the top, and keeps the choice in the other tab', () => {
    const select = el().querySelector('select.pm-elegir') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.textContent?.trim())).toEqual(['Europa', 'Sanchos']);
    fixture.detectChanges();
    expect(fixture.componentInstance.elegida()).toBe(7);

    const europa = respuesta();
    europa.elegida = 8;
    europa.ferrallas = [europa.ferrallas[1]];
    api.getPlanificacionModen.mockReturnValue(of(europa));
    fixture.componentInstance.elegirFerralla(8);
    fixture.detectChanges();
    expect(api.getPlanificacionModen).toHaveBeenLastCalledWith(2, 8);
    expect(fixture.componentInstance.vistas().map(v => v.nombre)).toEqual(['Europa']);
    expect(TestBed.inject(FerrallaPlanificacion).elegida()).toBe(8);

    // La otra pestana abre con la misma.
    TestBed.inject(ActivatedRoute).snapshot.data = { vista: 1 };
    const otra = TestBed.createComponent(PlanificacionComponent);
    otra.detectChanges();
    expect(api.getPlanificacionModen).toHaveBeenLastCalledWith(1, 8);
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
