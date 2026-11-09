import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import {
  ApiService, PlanificacionModenFerralla, PlanificacionModenProyecto, PlanificacionModenResponse, User,
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
      // Tenue: solo entregan fantasmas ese dia.
      tenue: delDia.every(e => e.fantasma),
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

  ngOnInit(): void {
    this.cargar();
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
