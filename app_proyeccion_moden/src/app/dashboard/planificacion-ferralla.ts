import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ApiService, PlanificacionPrevistos, PlanificacionResponse, PlanificacionTarjeta } from '../services/api.service';
import { ChartMark, LineChartSeries, StatsLineChart } from './stats-line-chart';

// La serie de modulos, en el naranja de los modulos de Estadisticas.
const CHART_NARANJA = '#f0640f';
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fecha(iso: string): Date {
  const [anio, mes, dia] = iso.split('-').map(Number);
  return new Date(anio, mes - 1, dia);
}

const dosCifras = (n: number): string => String(n).padStart(2, '0');

/** "12/11" */
export function fechaCorta(iso: string): string {
  const d = fecha(iso);
  return `${dosCifras(d.getDate())}/${dosCifras(d.getMonth() + 1)}`;
}

/** "jue 12 nov" */
export function fechaLarga(iso: string): string {
  const d = fecha(iso);
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`;
}

/** Lo mas corto que distingue cada entrega: el final de su nombre que no acaba igual en
 *  ninguna otra ("RIPA_BH_P05" -> "P05"; con "RIPA_BI_P05" tambien, "BH_P05"). */
export function etiquetasCortas(nombres: string[]): Map<string, string> {
  const distintos = Array.from(new Set(nombres)).map(nombre => ({ nombre, partes: nombre.split('_') }));
  const final = (partes: string[], n: number) => partes.slice(-n).join('_');
  return new Map(distintos.map(({ nombre, partes }) => {
    for (let n = 1; n < partes.length; n++) {
      const corto = final(partes, n);
      if (distintos.every(otro => otro.nombre === nombre || final(otro.partes, n) !== corto)) return [nombre, corto];
    }
    return [nombre, nombre];
  }));
}

/** Los forjados de un edificio, en una columna con el total a obra de los que se ven. */
export interface ColumnaEdificio {
  clave: string;
  nombre: string;
  proyectos: PlanificacionTarjeta[];
  kilos: number;
  confirmado: number;
  previsto: number;
  /** Forjados de los que aun no se sabe ningun kilo: no suman. */
  sinKilos: number;
}

const MEDIA_DE: Record<NonNullable<PlanificacionPrevistos['de']>, string> = {
  proyecto: 'media de sus módulos subidos',
  edificio: 'media de los módulos del edificio',
  ferralla: 'media de los módulos de la ferralla',
};

/**
 * Planificacion de la ferralla a tres meses: los modulos al dia que piden las entregas
 * a obra, con cada entrega marcada, y debajo los kilos de cada proyecto: los de los
 * modulos y los elementos sueltos, confirmados (lo subido) y previstos estimados (los modulos que
 * faltan por subir, a su peso medio).
 */
@Component({
  selector: 'app-planificacion-ferralla',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, StatsLineChart],
  templateUrl: './planificacion-ferralla.html',
  styleUrl: './planificacion-ferralla.css',
})
export class PlanificacionFerralla implements OnInit {
  private readonly api = inject(ApiService);

  readonly datos = signal<PlanificacionResponse | null>(null);
  readonly cargando = signal(true);
  readonly error = signal(false);

  readonly fechaLarga = fechaLarga;
  readonly fechaCorta = fechaCorta;

  readonly dias = computed(() => this.datos()?.dias ?? []);
  readonly labels = computed(() => this.dias().map(dia => fechaCorta(dia.fecha)));
  readonly labelsLargas = computed(() => this.dias().map(dia => fechaLarga(dia.fecha)));

  readonly series = computed<LineChartSeries[]>(() => [{
    name: 'Módulos al día',
    color: CHART_NARANJA,
    values: this.dias().map(dia => dia.modulos),
    // Pasada la ultima entrega no se pide nada.
    tooltips: this.dias().map(dia => dia.modulos ? null : 'Sin entregas por delante'),
  }]);

  /** Una marca por dia de entrega; si cae en un dia sin fabricacion, entre el de antes y el de despues. */
  readonly marcas = computed<ChartMark[]>(() => {
    const dias = this.dias();
    const entregas = this.datos()?.entregas ?? [];
    const cortas = etiquetasCortas(entregas.map(e => e.nombre));
    const porFecha = new Map<string, typeof entregas>();
    for (const entrega of entregas) porFecha.set(entrega.fecha, [...(porFecha.get(entrega.fecha) ?? []), entrega]);
    return Array.from(porFecha, ([dia, delDia]) => {
      const despues = dias.findIndex(d => d.fecha >= dia);
      const index = despues < 0 ? dias.length - 0.5 : dias[despues].fecha === dia ? despues : despues - 0.5;
      return {
        index,
        label: delDia.map(e => cortas.get(e.nombre)).join(' · '),
        tenue: delDia.every(e => e.orientativa),
        detalle: delDia.map(e => `Entrega ${e.nombre}${e.orientativa ? ' (orientativa)' : ''} · ${e.modulos_pendientes} mód. por fabricar`),
      };
    });
  });

  readonly proyectos = computed(() => this.datos()?.proyectos ?? []);

  /** Una columna por edificio, por orden de su primera entrega; lo que no es de un edificio, al final. */
  readonly columnas = computed<ColumnaEdificio[]>(() => {
    const columnas = new Map<string, ColumnaEdificio>();
    for (const proyecto of this.proyectos()) {
      const clave = proyecto.edificio === null ? 'sin-edificio' : String(proyecto.edificio);
      let columna = columnas.get(clave);
      if (!columna) {
        columna = {
          clave, nombre: proyecto.edificio_nombre ?? 'Sin edificio', proyectos: [], kilos: 0, confirmado: 0, previsto: 0, sinKilos: 0,
        };
        columnas.set(clave, columna);
      }
      columna.proyectos.push(proyecto);
      if (proyecto.kilos.total === null) columna.sinKilos++;
      columna.kilos += proyecto.kilos.total ?? 0;
      columna.confirmado += proyecto.kilos.confirmado ?? 0;
      columna.previsto += proyecto.kilos.previsto ?? 0;
    }
    return Array.from(columnas.values())
      .sort((a, b) => Number(a.clave === 'sin-edificio') - Number(b.clave === 'sin-edificio'));
  });
  readonly resumen = computed(() => {
    const entregas = this.datos()?.entregas ?? [];
    const enVista = new Set(entregas.map(e => e.proyecto));
    const proyectos = this.proyectos().filter(p => enVista.has(p.id));
    const suma = (kilos: (p: PlanificacionTarjeta) => number | null) => proyectos.reduce((total, p) => total + (kilos(p) ?? 0), 0);
    // Hasta que se suben, los modulos que faltan son los previstos: una estimacion.
    const estimados = new Map(proyectos.map(p => [p.id, p.kilos.previstos?.modulos ?? 0]));
    return {
      entregas: entregas.length,
      modulos: entregas.reduce((total, e) => total + e.modulos_pendientes, 0),
      modulosEstimados: entregas.reduce((total, e) => total + Math.min(e.modulos_pendientes, estimados.get(e.proyecto) ?? 0), 0),
      kilos: suma(p => p.kilos.total),
      confirmado: suma(p => p.kilos.confirmado),
      previsto: suma(p => p.kilos.previsto),
    };
  });

  /** Los modulos del proyecto que aun son una estimacion (los previstos que faltan por subir). */
  modulosEstimadosTitulo(proyecto: PlanificacionTarjeta): string {
    const estimados = proyecto.kilos.previstos?.modulos ?? 0;
    if (!estimados) return '';
    const subidos = proyecto.kilos.modulos_subidos;
    return subidos ? `${subidos} confirmados · ${estimados} previstos estimados` : 'Previstos estimados: aún no hay módulos subidos';
  }

  /** "A 129 kg/módulo, media de los módulos del edificio" */
  previstosDetalle(previstos: PlanificacionPrevistos): string {
    if (previstos.peso_medio === null || previstos.de === null) return '';
    return `A ${Math.round(previstos.peso_medio)} kg/módulo, ${MEDIA_DE[previstos.de]}`;
  }

  ngOnInit(): void {
    this.cargar();
  }

  cargar(usuario?: number): void {
    this.cargando.set(true);
    this.error.set(false);
    this.api.getPlanificacion(usuario).subscribe({
      next: datos => {
        this.datos.set(datos);
        this.cargando.set(false);
      },
      error: () => {
        this.error.set(true);
        this.cargando.set(false);
      },
    });
  }

  elegirFerralla(id: string): void {
    if (id) this.cargar(Number(id));
  }
}
