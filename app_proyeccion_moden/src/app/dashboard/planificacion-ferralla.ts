import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';

import { ApiService, KilosOtrosLinea, PlanificacionResponse, PlanificacionTarjeta } from '../services/api.service';
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

/**
 * Planificacion de la ferralla a tres meses: los modulos al dia que piden las entregas
 * a obra, con cada entrega marcada, y debajo los kilos de cada proyecto (modulos,
 * elementos sueltos y lo que la ferralla apunte como "otros").
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
  /** Linea de "otros" que se esta guardando o borrando (por proyecto). */
  readonly guardandoId = signal<number | null>(null);
  readonly erroresOtros = signal<Record<number, string>>({});
  nuevoConcepto: Record<number, string> = {};
  nuevoKg: Record<number, string> = {};

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
  readonly resumen = computed(() => {
    const entregas = this.datos()?.entregas ?? [];
    const enVista = new Set(entregas.map(e => e.proyecto));
    return {
      entregas: entregas.length,
      modulos: entregas.reduce((total, e) => total + e.modulos_pendientes, 0),
      kilos: this.proyectos().filter(p => enVista.has(p.id)).reduce((total, p) => total + (p.kilos.total ?? 0), 0),
    };
  });

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

  /** "Edificio B · Planta 3" */
  ubicacion(proyecto: PlanificacionTarjeta): string {
    return [proyecto.edificio_nombre, proyecto.planta_etiqueta].filter(Boolean).join(' · ');
  }

  addOtros(proyecto: PlanificacionTarjeta): void {
    const concepto = (this.nuevoConcepto[proyecto.id] ?? '').trim();
    const kg = (this.nuevoKg[proyecto.id] ?? '').trim();
    if (!concepto || !kg) {
      this.setError(proyecto.id, 'Pon el concepto y los kilos.');
      return;
    }
    this.guardandoId.set(proyecto.id);
    this.api.addKilosOtros(proyecto.id, { concepto, kg }).subscribe({
      next: otros => {
        this.nuevoConcepto[proyecto.id] = '';
        this.nuevoKg[proyecto.id] = '';
        this.setOtros(proyecto.id, otros);
      },
      error: (err: HttpErrorResponse) => {
        const detalle = err.error?.kg?.[0] ?? err.error?.concepto?.[0] ?? 'No se pudo guardar.';
        this.setError(proyecto.id, detalle);
        this.guardandoId.set(null);
      },
    });
  }

  removeOtros(proyecto: PlanificacionTarjeta, linea: KilosOtrosLinea): void {
    this.guardandoId.set(proyecto.id);
    this.api.deleteKilosOtros(proyecto.id, linea.id).subscribe({
      next: otros => this.setOtros(proyecto.id, otros),
      error: () => {
        this.setError(proyecto.id, 'No se pudo quitar.');
        this.guardandoId.set(null);
      },
    });
  }

  /** Las lineas que devuelve el servidor y el total del proyecto con ellas. */
  private setOtros(proyectoId: number, otros: KilosOtrosLinea[]): void {
    this.setError(proyectoId, '');
    this.guardandoId.set(null);
    this.datos.update(datos => datos && {
      ...datos,
      proyectos: datos.proyectos?.map(p => p.id !== proyectoId ? p : {
        ...p,
        kilos: {
          ...p.kilos,
          otros,
          total: p.kilos.modulos === null ? null
            : Math.round((p.kilos.modulos + (p.kilos.sueltos ?? 0) + otros.reduce((t, o) => t + o.kg, 0)) * 100) / 100,
        },
      }),
    });
  }

  private setError(proyectoId: number, mensaje: string): void {
    this.erroresOtros.update(errores => ({ ...errores, [proyectoId]: mensaje }));
  }
}
