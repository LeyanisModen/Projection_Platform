import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import {
  AcopioCapacidad, AcopioExceso, ApiService, PlanificacionModenFerralla, PlanificacionModenProyecto,
  PlanificacionModenResponse, User,
} from '../../services/api.service';
import { ChartMark, LineChartSeries, StatsLineChart } from '../../dashboard/stats-line-chart';
import { etiquetasCortas, fechaCorta, fechaLarga } from '../../dashboard/planificacion-ferralla';

// Lo real en el naranja de los modulos (como la planificacion de la ferralla);
// con los fantasmas, en el azul de lo estimado.
const NARANJA = '#f0640f';
const AZUL = '#2264b8';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "24,4" / "8.261": con punto de miles tambien en las de cuatro cifras, que vayan parejas en la lista. */
export function cifra(valor: number | null | undefined, decimales = 0): string {
  if (valor === null || valor === undefined) return '—';
  const opciones = { maximumFractionDigits: decimales, minimumFractionDigits: 0, useGrouping: 'always' };
  return valor.toLocaleString('es-ES', opciones as unknown as Intl.NumberFormatOptions);
}

/** Los proyectos de un mes de entrega (o sin fecha / con la entrega ya pasada). */
export interface MesPlanificacion {
  clave: string;
  nombre: string;
  proyectos: PlanificacionModenProyecto[];
  modulos: number;
  modulosFantasma: number;
  kilos: number;
}

/** Donde mas aprietan los proyectos en estudio: su dia mas alto y hasta donde sigue igual. */
export interface PicoEstudio {
  ritmo: number;
  desde: string;
  hasta: string;
}

/** El patio de la ferralla: bastidores cada dia contra lo que cabe. */
export interface VistaAcopio {
  series: LineChartSeries[];
  capacidad: number[];
  /** "Caben 30 bastidores · desde el 15/12, 90". */
  texto: string;
  noCabeReal: string | null;
  noCabeEstudio: string | null;
}

export interface VistaFerralla {
  id: number;
  nombre: string;
  datos: PlanificacionModenFerralla;
  labels: string[];
  labelsLargas: string[];
  series: LineChartSeries[];
  marcas: ChartMark[];
  meses: MesPlanificacion[];
  /** Algo que fabricar en estos seis meses: sin nada, la grafica sobra. */
  conCarga: boolean;
  picoEstudio: PicoEstudio | null;
  /** Sin capacidad de acopio, null: el patio no limita. */
  acopio: VistaAcopio | null;
}

/** "Caben 30 bastidores · desde el 15/12, 90". */
export function textoCapacidades(capacidades: AcopioCapacidad[]): string {
  if (!capacidades.length) return 'Sin límite de acopio';
  const [primera, ...resto] = capacidades;
  return [
    `Caben ${cifra(primera.bastidores)} bastidores`,
    ...resto.map(c => `desde el ${fechaCorta(c.desde)}, ${cifra(c.bastidores)}`),
  ].join(' · ');
}

/** "No cabe entre el 18/09 y el 25/09: faltan hasta 4 bastidores de sitio". */
export function textoNoCabe(excesos: AcopioExceso[]): string | null {
  if (!excesos.length) return null;
  const faltan = Math.ceil(Math.max(...excesos.map(e => e.bastidores)) - 1e-9);
  const desde = excesos[0].fecha;
  const hasta = excesos[excesos.length - 1].fecha;
  const cuando = desde === hasta ? `el ${fechaCorta(desde)}` : `entre el ${fechaCorta(desde)} y el ${fechaCorta(hasta)}`;
  return `No cabe ${cuando}: faltan hasta ${cifra(faltan)} ${faltan === 1 ? 'bastidor' : 'bastidores'} de sitio`;
}

export function vistaAcopio(ferralla: PlanificacionModenFerralla): VistaAcopio | null {
  const acopio = ferralla.acopio;
  if (!acopio) return null;
  const conFantasmas = ferralla.resumen.fantasmas > 0;
  const real: LineChartSeries = { name: 'Real', color: NARANJA, values: acopio.dias.map(d => d.real) };
  const series = conFantasmas
    ? [{ name: 'Con proyectos en estudio', color: AZUL, values: acopio.dias.map(d => d.con_fantasmas) }, real]
    : [real];
  return {
    series,
    capacidad: acopio.dias.map(d => d.capacidad),
    texto: textoCapacidades(acopio.capacidades),
    noCabeReal: textoNoCabe(acopio.excesos_real),
    // Solo si lo que esta en estudio empeora lo real.
    noCabeEstudio: conFantasmas && JSON.stringify(acopio.excesos_con_fantasmas) !== JSON.stringify(acopio.excesos_real)
      ? textoNoCabe(acopio.excesos_con_fantasmas) : null,
  };
}

/** El dia mas alto de los que cambian por los proyectos en estudio: ahi es donde hay que centrarse. */
export function picoEstudio(dias: PlanificacionModenFerralla['dias']): PicoEstudio | null {
  const influye = (i: number) => dias[i].con_fantasmas > dias[i].real;
  let mayor = -1;
  dias.forEach((dia, i) => {
    if (influye(i) && (mayor < 0 || dia.con_fantasmas > dias[mayor].con_fantasmas)) mayor = i;
  });
  if (mayor < 0) return null;
  let fin = mayor;
  while (fin + 1 < dias.length && influye(fin + 1) && dias[fin + 1].con_fantasmas === dias[mayor].con_fantasmas) fin++;
  return { ritmo: dias[mayor].con_fantasmas, desde: dias[mayor].fecha, hasta: dias[fin].fecha };
}

/** Por mes de entrega; antes lo que ya tenia que estar y al final lo que aun no tiene fecha. */
export function porMes(proyectos: PlanificacionModenProyecto[], desde: string): MesPlanificacion[] {
  const meses = new Map<string, MesPlanificacion>();
  for (const proyecto of proyectos) {
    const fecha = proyecto.fecha_entrega;
    const clave = !fecha ? 'sin-fecha' : fecha < desde ? 'pasada' : fecha.slice(0, 7);
    let mes = meses.get(clave);
    if (!mes) {
      const nombre = clave === 'sin-fecha' ? 'Sin fecha de entrega'
        : clave === 'pasada' ? 'Entrega pasada'
        : `${MESES[Number(clave.slice(5, 7)) - 1]} ${clave.slice(0, 4)}`;
      mes = { clave, nombre, proyectos: [], modulos: 0, modulosFantasma: 0, kilos: 0 };
      meses.set(clave, mes);
    }
    mes.proyectos.push(proyecto);
    if (proyecto.fantasma) mes.modulosFantasma += proyecto.modulos_pendientes;
    else mes.modulos += proyecto.modulos_pendientes;
    mes.kilos += proyecto.kilos.total ?? 0;
  }
  const orden = (clave: string) => clave === 'pasada' ? '0' : clave === 'sin-fecha' ? '9' : clave;
  return Array.from(meses.values()).sort((a, b) => orden(a.clave).localeCompare(orden(b.clave)));
}

export function vistaDe(ferralla: PlanificacionModenFerralla, desde: string): VistaFerralla {
  const dias = ferralla.dias;
  const conFantasmas = ferralla.resumen.fantasmas > 0;
  const real: LineChartSeries = { name: 'Real', color: NARANJA, values: dias.map(d => d.real) };
  // Lo real por encima: con fantasmas nunca pide menos.
  const series = conFantasmas
    ? [{ name: 'Con proyectos en estudio', color: AZUL, values: dias.map(d => d.con_fantasmas) }, real]
    : [real];

  // Una marca por dia de entrega; si cae en un dia sin fabricacion, entre el de antes y el de despues.
  const cortas = etiquetasCortas(ferralla.entregas.map(e => e.nombre));
  const porFecha = new Map<string, typeof ferralla.entregas>();
  for (const entrega of ferralla.entregas) porFecha.set(entrega.fecha, [...(porFecha.get(entrega.fecha) ?? []), entrega]);
  const marcas = Array.from(porFecha, ([dia, delDia]) => {
    const despues = dias.findIndex(d => d.fecha >= dia);
    const index = despues < 0 ? dias.length - 0.5 : dias[despues].fecha === dia ? despues : despues - 0.5;
    return {
      index,
      label: delDia.map(e => cortas.get(e.nombre)).join(' · '),
      // Tenue: solo entregan fantasmas ese dia; si se juntan con reales, cada nombre con su color.
      tenue: delDia.every(e => e.fantasma),
      partes: delDia.some(e => e.fantasma) && delDia.some(e => !e.fantasma)
        ? delDia.map(e => ({ texto: cortas.get(e.nombre) ?? e.nombre, tenue: e.fantasma }))
        : undefined,
      detalle: delDia.map(e => `Entrega ${e.nombre}${e.fantasma ? ' (en estudio)' : e.orientativa ? ' (orientativa)' : ''} · ${e.modulos_pendientes} mód. por fabricar`),
    };
  });

  return {
    id: ferralla.ferralla.id,
    nombre: ferralla.ferralla.nombre,
    datos: ferralla,
    labels: dias.map(d => fechaCorta(d.fecha)),
    labelsLargas: dias.map(d => fechaLarga(d.fecha)),
    series,
    marcas,
    meses: porMes(ferralla.proyectos, desde),
    conCarga: dias.some(d => d.real || d.con_fantasmas),
    picoEstudio: conFantasmas ? picoEstudio(dias) : null,
    acopio: vistaAcopio(ferralla),
  };
}

/**
 * Planificacion de Moden: cada ferralla a seis meses, con cuantos modulos al dia
 * tendria que fabricar para llegar a sus entregas, con lo real y sumando los
 * proyectos fantasma (los que Moden simula y la ferralla no ve).
 */
@Component({
  selector: 'app-planificacion-moden',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, StatsLineChart],
  templateUrl: './planificacion.component.html',
  styleUrls: ['../admin-theme.css', './planificacion.component.css'],
})
export class PlanificacionComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly datos = signal<PlanificacionModenResponse | null>(null);
  readonly cargando = signal(true);
  readonly error = signal(false);
  private usuarios: User[] = [];

  readonly cifra = cifra;
  readonly azul = AZUL;
  readonly fechaLarga = fechaLarga;
  readonly fechaCorta = fechaCorta;

  readonly vistas = computed(() => {
    const datos = this.datos();
    return datos ? datos.ferrallas.map(f => vistaDe(f, datos.desde)) : [];
  });

  // Alta de un fantasma en una ferralla.
  readonly nuevoEn = signal<VistaFerralla | null>(null);
  readonly guardando = signal(false);
  readonly errorNuevo = signal('');
  nuevo = { nombre: '', fecha_montaje: '', modulos_previstos: null as number | null };

  // Capacidad de acopio de una ferralla: bastidores que caben a partir de cada fecha.
  readonly acopioEn = signal<VistaFerralla | null>(null);
  readonly guardandoAcopio = signal(false);
  readonly errorAcopio = signal('');
  filasAcopio: AcopioCapacidad[] = [];

  ngOnInit(): void {
    this.cargar();
  }

  abrirAcopio(vista: VistaFerralla): void {
    const actuales = vista.datos.acopio?.capacidades ?? [];
    const hoy = this.datos()?.desde ?? '';
    this.filasAcopio = actuales.length ? actuales.map(c => ({ ...c })) : [{ desde: hoy, bastidores: 0 }];
    this.errorAcopio.set('');
    this.acopioEn.set(vista);
  }

  cerrarAcopio(): void {
    if (!this.guardandoAcopio()) this.acopioEn.set(null);
  }

  anadirFilaAcopio(): void {
    const ultima = this.filasAcopio[this.filasAcopio.length - 1];
    this.filasAcopio = [...this.filasAcopio, { desde: '', bastidores: ultima?.bastidores ?? 0 }];
  }

  quitarFilaAcopio(indice: number): void {
    this.filasAcopio = this.filasAcopio.filter((_f, i) => i !== indice);
  }

  get acopioValido(): boolean {
    const fechas = this.filasAcopio.map(f => f.desde);
    return this.filasAcopio.every(f => !!f.desde && Number.isInteger(Number(f.bastidores)) && Number(f.bastidores) >= 0)
      && new Set(fechas).size === fechas.length;
  }

  /** Guarda las capacidades (sin filas: sin limite) y recarga el plan con ellas. */
  guardarAcopio(): void {
    const vista = this.acopioEn();
    if (!vista || !this.acopioValido || this.guardandoAcopio()) return;
    this.guardandoAcopio.set(true);
    this.errorAcopio.set('');
    const capacidades = this.filasAcopio.map(f => ({ desde: f.desde, bastidores: Number(f.bastidores) }));
    this.api.guardarAcopio(vista.id, capacidades).subscribe({
      next: () => {
        this.guardandoAcopio.set(false);
        this.acopioEn.set(null);
        this.cargar();
      },
      error: err => {
        this.errorAcopio.set(err?.error?.detail || 'No se pudo guardar el acopio.');
        this.guardandoAcopio.set(false);
      },
    });
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(false);
    forkJoin({ plan: this.api.getPlanificacionModen(), usuarios: this.api.getUsers() }).subscribe({
      next: ({ plan, usuarios }) => {
        this.usuarios = usuarios;
        this.datos.set(plan);
        this.cargando.set(false);
      },
      error: () => {
        this.error.set(true);
        this.cargando.set(false);
      },
    });
  }

  abrirNuevo(vista: VistaFerralla): void {
    this.nuevo = { nombre: '', fecha_montaje: '', modulos_previstos: null };
    this.errorNuevo.set('');
    this.nuevoEn.set(vista);
  }

  cerrarNuevo(): void {
    if (!this.guardando()) this.nuevoEn.set(null);
  }

  get nuevoValido(): boolean {
    return !!this.nuevo.nombre.trim() && !!this.nuevo.fecha_montaje && (this.nuevo.modulos_previstos ?? 0) > 0;
  }

  crearFantasma(): void {
    const vista = this.nuevoEn();
    const usuario = this.usuarios.find(u => u.id === vista?.id);
    if (!vista || !usuario || !this.nuevoValido || this.guardando()) return;
    this.guardando.set(true);
    this.errorNuevo.set('');
    this.api.createProyecto({
      nombre: this.nuevo.nombre.trim(),
      usuario: usuario.url,
      fantasma: true,
      fecha_montaje: this.nuevo.fecha_montaje,
      modulos_previstos: this.nuevo.modulos_previstos,
    }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.nuevoEn.set(null);
        this.cargar();
      },
      error: err => {
        const datos = err?.error;
        const primero = datos && typeof datos === 'object' ? Object.values(datos)[0] : null;
        this.errorNuevo.set((Array.isArray(primero) ? primero[0] : primero) || 'No se pudo crear el proyecto.');
        this.guardando.set(false);
      },
    });
  }
}
