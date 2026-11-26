import { ChangeDetectionStrategy, Component, Injectable, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import {
  AcopioCapacidad, AcopioExceso, ApiService, NoLlega, PlanificacionModenFerralla, PlanificacionModenProyecto,
  PlanificacionModenResponse, SobrecargaCamiones, User,
} from '../../services/api.service';
import { ChartBand, LineChartSeries, StatsLineChart } from '../../dashboard/stats-line-chart';
import { fechaCorta, fechaLarga } from '../../dashboard/planificacion-ferralla';
import { diaCorto } from '../../shared/camiones-proyecto.component';
import { FabricacionObras, ObraGantt, SalidaGantt } from './fabricacion-obras.component';

// Lo real en el naranja de los modulos (como la planificacion de la ferralla);
// con los fantasmas, en el azul de lo estimado.
const NARANJA = '#f0640f';
const AZUL = '#2264b8';
const ROJO = '#c0392b';
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

/** Las dos pestanas: 1, el minimo de siempre; 2, con el patio y los camiones. */
export type PestanaPlanificacion = 1 | 2;

/** Pestana 1: lo que habria en el patio si cada obra sale entera el dia antes de su montaje. */
export interface VistaPatio {
  series: LineChartSeries[];
  /** Lo que cabe, si Moden lo ha dicho: solo la linea, sin avisos. */
  capacidad: Array<number | null> | null;
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
  /** Cuando se fabrica cada obra, en las mismas columnas que la grafica. */
  obras: ObraGantt[];
  meses: MesPlanificacion[];
  /** Algo que fabricar en estos seis meses: sin nada, la grafica sobra. */
  conCarga: boolean;
  picoEstudio: PicoEstudio | null;
  /** Pestana 1: lo que se acopia con el minimo (null si nunca hay nada en el patio). */
  patio: VistaPatio | null;
  /** Pestana 2, sin capacidad de acopio, null: el patio no limita. */
  acopio: VistaAcopio | null;
  /** Dias en que salen mas camiones de los que puede: con lo real y, si empeora, con lo que esta en estudio. */
  camionesReal: string | null;
  camionesEstudio: string | null;
  /** Dias con el patio lleno, sombreados en las graficas y en el diagrama. */
  bandas: ChartBand[];
  /** Lo que no llega a su montaje por el patio y lo que fabrican al dia. */
  noLleganReal: string | null;
  noLleganEstudio: string | null;
}

/** Los dias que empiezan con el patio lleno (solo se fabrica lo que sale): con lo real y,
 *  aparte, los que solo se llenan con lo que esta en estudio. */
export function bandasPatio(ferralla: PlanificacionModenFerralla): ChartBand[] {
  const acopio = ferralla.acopio;
  if (!acopio) return [];
  const real = new Set(acopio.llenos_real ?? []);
  const estudio = new Set(acopio.llenos_con_fantasmas ?? []);
  const bandas: ChartBand[] = [
    { days: ferralla.dias.map(d => real.has(d.fecha)), color: ROJO, label: 'Patio lleno: solo se fabrica lo que sale' },
  ];
  if (ferralla.resumen.fantasmas > 0) {
    bandas.push({
      days: ferralla.dias.map(d => estudio.has(d.fecha) && !real.has(d.fecha)), color: AZUL,
      label: 'Patio lleno con lo que está en estudio',
    });
  }
  return bandas;
}

/** "No llegan a su montaje, fabricando como mucho 30 mód. al día: P03 (montaje 22/02), faltan 40 mód. el vie 19/02". */
export function textoNoLlegan(lista: NoLlega[] | undefined, maximo: number | null | undefined): string | null {
  if (!lista?.length) return null;
  const obras = lista.slice(0, 4).map(n =>
    `${n.nombre}${n.montaje ? ` (montaje ${fechaCorta(n.montaje)})` : ''}, faltan ${cifra(n.faltan)} mód. el ${diaCorto(n.fecha)}`);
  const resto = lista.length > 4 ? `; y ${lista.length - 4} más` : '';
  const cuanto = maximo ? `, fabricando como mucho ${cifra(maximo)} mód. al día` : '';
  return `No llegan a su montaje${cuanto}: ${obras.join('; ')}${resto}`;
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

export function vistaPatio(ferralla: PlanificacionModenFerralla): VistaPatio | null {
  const patio = ferralla.patio;
  if (!patio || !patio.dias.some(d => d.real || d.con_fantasmas)) return null;
  const real: LineChartSeries = { name: 'Real', color: NARANJA, values: patio.dias.map(d => d.real) };
  const series = ferralla.resumen.fantasmas > 0
    ? [{ name: 'Con proyectos en estudio', color: AZUL, values: patio.dias.map(d => d.con_fantasmas) }, real]
    : [real];
  return { series, capacidad: patio.capacidades.length ? patio.dias.map(d => d.capacidad) : null };
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
    texto: textoCapacidades(acopio.capacidades)
      + (ferralla.modulos_dia_max ? ` · fabrican como mucho ${cifra(ferralla.modulos_dia_max)} mód. al día` : ''),
    noCabeReal: textoNoCabe(acopio.excesos_real),
    // Solo si lo que esta en estudio empeora lo real.
    noCabeEstudio: conFantasmas && JSON.stringify(acopio.excesos_con_fantasmas) !== JSON.stringify(acopio.excesos_real)
      ? textoNoCabe(acopio.excesos_con_fantasmas) : null,
  };
}

/** Columna de una fecha en los dias de la grafica: entre dos (x.5) si cae en un dia sin
 *  fabricacion; antes del primero, -0.5; null si es despues del ultimo. */
export function columnaDe(dias: Array<{ fecha: string }>, fecha: string | null | undefined): number | null {
  if (!fecha) return null;
  const despues = dias.findIndex(d => d.fecha >= fecha);
  if (despues < 0) return null;
  return dias[despues].fecha === fecha ? despues : despues - 0.5;
}

/** "del 02/12 al 05/12" o "el 02/12". */
function rango(desde: string, hasta: string): string {
  return desde === hasta ? `el ${fechaCorta(desde)}` : `del ${fechaCorta(desde)} al ${fechaCorta(hasta)}`;
}

/** Las obras con algo que fabricar o esperando su montaje en el patio, para el diagrama
 *  (con lo que esta en estudio). Se marcan los dias de camiones en que la ferralla saca,
 *  entre todas, mas de los que puede. */
export function obrasDe(ferralla: PlanificacionModenFerralla, desde: string): ObraGantt[] {
  const dias = ferralla.dias;
  if (!dias.length) return [];
  const ultima = dias.length - 1;
  const demas = new Set((ferralla.camiones?.sobrecargas_con_fantasmas ?? []).map(s => s.fecha));
  const porDia = ferralla.camiones?.por_dia;
  const noLlegan = new Map((ferralla.no_llegan_con_fantasmas ?? []).map(n => [n.proyecto, n]));
  const obras: ObraGantt[] = [];
  for (const p of ferralla.proyectos) {
    const entrega = p.fecha_entrega && p.fecha_entrega >= desde ? p.fecha_entrega : null;
    const montaje = columnaDe(dias, entrega);
    const fabrica = !!(p.fabricacion_inicio && p.fabricacion_fin);
    // Ya hecho: solo la espera en el patio hasta su montaje.
    if (!fabrica && !(p.estado === 'COMPLETADO' && montaje !== null)) continue;
    let inicio: number | null = null;
    let fin: number | null = null;
    if (fabrica) {
      const a = columnaDe(dias, p.fabricacion_inicio);
      if (a === null) continue;
      inicio = Math.max(0, Math.ceil(a));
      const b = columnaDe(dias, p.fabricacion_fin);
      fin = b === null ? ultima : Math.max(inicio, Math.floor(b));
    }
    const falta = noLlegan.get(p.id);
    const envio = p.envio;
    const salidas: SalidaGantt[] = [];
    for (const salida of envio?.salidas ?? []) {
      const columna = salida.fecha >= desde ? columnaDe(dias, salida.fecha) : null;
      if (columna !== null && columna >= 0) salidas.push({ columna, camiones: salida.camiones, demas: demas.has(salida.fecha) });
    }
    const partes = [`${p.nombre}${p.fantasma ? ' (en estudio)' : ''}`];
    partes.push(fabrica ? `fabricación ${rango(p.fabricacion_inicio!, p.fabricacion_fin!)} (${cifra(p.modulos_pendientes)} mód.)` : 'fabricado');
    if (envio?.desde && envio.hasta) {
      const camiones = `${envio.camiones} ${envio.camiones === 1 ? 'camión' : 'camiones'}`;
      const cuando = (envio.salidas?.length ?? 0) > 1
        ? `${camiones}: ${envio.salidas!.map(s => `${s.camiones} el ${fechaCorta(s.fecha)}`).join(', ')}`
        : `${camiones} ${rango(envio.desde, envio.hasta)}`;
      partes.push(cuando);
      const apretados = (envio.salidas ?? []).filter(s => demas.has(s.fecha)).map(s => fechaCorta(s.fecha));
      if (apretados.length && porDia) partes.push(`entre todas, más de ${porDia} camiones al día el ${apretados.join(', ')}`);
    }
    if (p.fecha_entrega) partes.push(`montaje ${fechaCorta(p.fecha_entrega)}`);
    const noLlega = falta ? `no llega: faltan ${cifra(falta.faltan)} mód. el ${fechaCorta(falta.fecha)}` : null;
    if (noLlega) partes.push(noLlega);
    obras.push({
      id: p.id,
      nombre: p.nombre,
      desde: inicio,
      hasta: fin,
      montaje,
      salidas,
      estudio: p.fantasma,
      noLlega,
      detalle: partes.join(' · '),
    });
  }
  return obras;
}

/** "Salen más de 4 camiones al día: 6 el vie 04/12, 5 el lun 07/12"; con muchos dias,
 *  cuantos, entre cuando y el peor. */
export function textoSobrecargas(sobrecargas: SobrecargaCamiones[], porDia: number): string | null {
  if (!sobrecargas.length) return null;
  const cabecera = `Salen más de ${porDia} camiones al día`;
  if (sobrecargas.length <= 3) {
    return `${cabecera}: ${sobrecargas.map(s => `${cifra(s.camiones, 1)} el ${diaCorto(s.fecha)}`).join(', ')}`;
  }
  const peor = sobrecargas.reduce((max, s) => (s.camiones > max.camiones ? s : max));
  const primero = sobrecargas[0].fecha;
  const ultimo = sobrecargas[sobrecargas.length - 1].fecha;
  return `${cabecera} en ${sobrecargas.length} días, del ${diaCorto(primero)} al ${diaCorto(ultimo)}; hasta ${cifra(peor.camiones, 1)} el ${diaCorto(peor.fecha)}`;
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

/** Lo de ``con`` que no esta igual en ``real``: lo que anaden los proyectos en estudio. */
function ademas<T>(con: T[], real: T[]): T[] {
  const vistos = new Set(real.map(r => JSON.stringify(r)));
  return con.filter(c => !vistos.has(JSON.stringify(c)));
}

/** "No llegan…" → "no llegan…", para ir detras de "Con los proyectos en estudio, además:". */
function seguido(texto: string | null): string | null {
  return texto ? texto.charAt(0).toLowerCase() + texto.slice(1) : null;
}

function avisosNoLlegan(ferralla: PlanificacionModenFerralla): Pick<VistaFerralla, 'noLleganReal' | 'noLleganEstudio'> {
  const real = ferralla.no_llegan_real ?? [];
  const con = ferralla.no_llegan_con_fantasmas ?? [];
  const nuevos = ferralla.resumen.fantasmas > 0 ? ademas(con, real) : [];
  return {
    noLleganReal: textoNoLlegan(real, ferralla.modulos_dia_max),
    noLleganEstudio: seguido(textoNoLlegan(nuevos, ferralla.modulos_dia_max)),
  };
}

function avisosCamiones(ferralla: PlanificacionModenFerralla): Pick<VistaFerralla, 'camionesReal' | 'camionesEstudio'> {
  const camiones = ferralla.camiones;
  if (!camiones) return { camionesReal: null, camionesEstudio: null };
  const nuevas = ferralla.resumen.fantasmas > 0 ? ademas(camiones.sobrecargas_con_fantasmas, camiones.sobrecargas_real) : [];
  return {
    camionesReal: textoSobrecargas(camiones.sobrecargas_real, camiones.por_dia),
    camionesEstudio: seguido(textoSobrecargas(nuevas, camiones.por_dia)),
  };
}

export function vistaDe(ferralla: PlanificacionModenFerralla, desde: string): VistaFerralla {
  const dias = ferralla.dias;
  const conFantasmas = ferralla.resumen.fantasmas > 0;
  const real: LineChartSeries = { name: 'Real', color: NARANJA, values: dias.map(d => d.real) };
  // Lo real por encima: con fantasmas nunca pide menos.
  const series = conFantasmas
    ? [{ name: 'Con proyectos en estudio', color: AZUL, values: dias.map(d => d.con_fantasmas) }, real]
    : [real];

  return {
    id: ferralla.ferralla.id,
    nombre: ferralla.ferralla.nombre,
    datos: ferralla,
    labels: dias.map(d => fechaCorta(d.fecha)),
    labelsLargas: dias.map(d => fechaLarga(d.fecha)),
    series,
    obras: obrasDe(ferralla, desde),
    meses: porMes(ferralla.proyectos, desde),
    conCarga: dias.some(d => d.real || d.con_fantasmas),
    picoEstudio: conFantasmas ? picoEstudio(dias) : null,
    patio: vistaPatio(ferralla),
    acopio: vistaAcopio(ferralla),
    ...avisosCamiones(ferralla),
    bandas: bandasPatio(ferralla),
    ...avisosNoLlegan(ferralla),
  };
}

/** Un forjado en la ventana de camiones: cuantos lleva y en cuantos dias salen. */
export interface FilaEnvio {
  id: number;
  nombre: string;
  fantasma: boolean;
  montaje: string;
  camiones: number;
  /** Lo que sale ahora ("del lun 23/11 al vie 27/11"). */
  salen: string;
  minimos: number;
  /** Lo que hay en el campo: vacio, los justos. */
  dias: number | null;
  elegidos: number | null;
}

/** Los forjados por montar con camiones, por fecha de montaje. */
export function filasEnvio(ferralla: PlanificacionModenFerralla, desde: string): FilaEnvio[] {
  return ferralla.proyectos
    .filter(p => p.envio && p.envio.camiones > 0 && p.fecha_entrega && p.fecha_entrega >= desde)
    .sort((a, b) => a.fecha_entrega!.localeCompare(b.fecha_entrega!))
    .map(p => {
      const envio = p.envio!;
      const salen = envio.desde && envio.hasta
        ? envio.desde === envio.hasta ? `el ${diaCorto(envio.desde)}` : `del ${diaCorto(envio.desde)} al ${diaCorto(envio.hasta)}`
        : '';
      return {
        id: p.id, nombre: p.nombre, fantasma: p.fantasma, montaje: p.fecha_entrega!, camiones: envio.camiones,
        salen, minimos: envio.dias_minimos, dias: envio.dias_elegidos, elegidos: envio.dias_elegidos,
      };
    });
}

/** La ferralla que se ha elegido, para que siga al pasar de una pestana a otra (hasta recargar). */
@Injectable({ providedIn: 'root' })
export class FerrallaPlanificacion {
  readonly elegida = signal<number | null>(null);
}

/**
 * Planificacion de Moden: una ferralla a seis meses, con cuantos modulos al dia
 * tendria que fabricar para llegar a sus entregas, con lo real y sumando los
 * proyectos fantasma (los que Moden simula y la ferralla no ve). Dos pestanas
 * (``data.vista`` de la ruta): la 1, el minimo de siempre con lo que eso acopia
 * si todo sale el dia antes del montaje y cuando se fabrica cada obra; la 2,
 * con lo que cabe en el patio y los camiones de cada obra. Se elige la ferralla
 * arriba; sin elegir, la que mas fabrico el ultimo dia (lo decide el servidor).
 */
@Component({
  selector: 'app-planificacion-moden',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FabricacionObras, FormsModule, RouterLink, StatsLineChart],
  templateUrl: './planificacion.component.html',
  styleUrls: ['../admin-theme.css', './planificacion.component.css'],
})
export class PlanificacionComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  readonly pestana: PestanaPlanificacion = inject(ActivatedRoute).snapshot.data['vista'] === 2 ? 2 : 1;
  private readonly eleccion = inject(FerrallaPlanificacion);

  readonly datos = signal<PlanificacionModenResponse | null>(null);
  readonly cargando = signal(true);
  readonly error = signal(false);
  private usuarios: User[] = [];
  /** Las ferrallas para elegir y la que se ve. */
  readonly opciones = signal<Array<{ id: number; nombre: string }>>([]);
  readonly elegida = signal<number | null>(null);
  private peticion = 0;

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
  /** Lo que fabrican al dia como mucho; vacio: no se dice que no llega. */
  modulosDiaMax: number | null = null;

  // Camiones de una ferralla: los que saca al dia y en cuantos dias salen sus forjados.
  readonly camionesEn = signal<VistaFerralla | null>(null);
  readonly guardandoCamiones = signal(false);
  readonly errorCamiones = signal('');
  camionesPorDia = 4;
  filasCamiones: FilaEnvio[] = [];
  readonly diaCorto = diaCorto;

  ngOnInit(): void {
    this.cargar();
  }

  abrirObra(id: number): void {
    this.router.navigate(['/admin-dashboard/proyectos', id]);
  }

  abrirCamiones(vista: VistaFerralla): void {
    this.camionesPorDia = vista.datos.camiones?.por_dia ?? 4;
    this.filasCamiones = filasEnvio(vista.datos, this.datos()?.desde ?? '');
    this.errorCamiones.set('');
    this.camionesEn.set(vista);
  }

  cerrarCamiones(): void {
    if (!this.guardandoCamiones()) this.camionesEn.set(null);
  }

  get camionesValido(): boolean {
    const entero = (v: unknown, min: number, max: number) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
    return entero(this.camionesPorDia, 1, 50)
      && this.filasCamiones.every(f => f.dias === null || (f.dias as unknown) === '' || entero(f.dias, 1, 60));
  }

  /** Guarda los camiones al dia y los dias que han cambiado, y recarga el plan con ellos. */
  guardarCamiones(): void {
    const vista = this.camionesEn();
    if (!vista || !this.camionesValido || this.guardandoCamiones()) return;
    const dias = (f: FilaEnvio) => (f.dias === null || (f.dias as unknown) === '' ? null : Number(f.dias));
    const proyectos = this.filasCamiones.filter(f => dias(f) !== f.elegidos).map(f => ({ id: f.id, dias_envio: dias(f) }));
    this.guardandoCamiones.set(true);
    this.errorCamiones.set('');
    this.api.guardarCamionesFerralla(vista.id, { camiones_por_dia: Number(this.camionesPorDia), proyectos }).subscribe({
      next: () => {
        this.guardandoCamiones.set(false);
        this.camionesEn.set(null);
        this.cargar();
      },
      error: err => {
        this.errorCamiones.set(err?.error?.detail || 'No se pudieron guardar los camiones.');
        this.guardandoCamiones.set(false);
      },
    });
  }

  abrirAcopio(vista: VistaFerralla): void {
    const actuales = vista.datos.acopio?.capacidades ?? [];
    const hoy = this.datos()?.desde ?? '';
    this.filasAcopio = actuales.length ? actuales.map(c => ({ ...c })) : [{ desde: hoy, bastidores: 0 }];
    this.modulosDiaMax = vista.datos.modulos_dia_max ?? null;
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
    const maximo = this.modulosDiaMax as unknown;
    const maximoBien = maximo === null || maximo === '' || (Number.isInteger(Number(maximo)) && Number(maximo) >= 1 && Number(maximo) <= 1000);
    return this.filasAcopio.every(f => !!f.desde && Number.isInteger(Number(f.bastidores)) && Number(f.bastidores) >= 0)
      && new Set(fechas).size === fechas.length && maximoBien;
  }

  /** Guarda las capacidades (sin filas: sin limite) y recarga el plan con ellas. */
  guardarAcopio(): void {
    const vista = this.acopioEn();
    if (!vista || !this.acopioValido || this.guardandoAcopio()) return;
    this.guardandoAcopio.set(true);
    this.errorAcopio.set('');
    const capacidades = this.filasAcopio.map(f => ({ desde: f.desde, bastidores: Number(f.bastidores) }));
    const maximo = this.modulosDiaMax === null || (this.modulosDiaMax as unknown) === '' ? null : Number(this.modulosDiaMax);
    this.api.guardarAcopio(vista.id, capacidades, maximo).subscribe({
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

  /** Ver otra ferralla: se queda elegida tambien en la otra pestana. */
  elegirFerralla(id: number): void {
    if (id === this.elegida()) return;
    this.eleccion.elegida.set(id);
    this.elegida.set(id);
    this.datos.set(null);
    this.cargar();
  }

  cargar(): void {
    const peticion = ++this.peticion;
    this.cargando.set(true);
    this.error.set(false);
    const plan = this.api.getPlanificacionModen(this.pestana, this.eleccion.elegida());
    forkJoin({ plan, usuarios: this.api.getUsers() }).subscribe({
      next: ({ plan, usuarios }) => {
        // Si entretanto se eligio otra, esta respuesta ya no vale.
        if (peticion !== this.peticion) return;
        this.usuarios = usuarios;
        this.opciones.set(plan.opciones ?? []);
        this.elegida.set(plan.elegida ?? plan.ferrallas[0]?.ferralla.id ?? null);
        this.datos.set(plan);
        this.cargando.set(false);
      },
      error: () => {
        if (peticion !== this.peticion) return;
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
