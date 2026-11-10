import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { finalize } from 'rxjs/operators';

import { ApiService, ProductionStatsModulo, ProductionStatsResponse, SeguimientoResponse } from '../../services/api.service';
import { LineChartSeries, StatsLineChart } from '../../dashboard/stats-line-chart';
import { fechaCorta, fechaLarga } from '../../dashboard/planificacion-ferralla';
import { cifra } from '../planificacion/planificacion.component';

const NARANJA = '#f0640f';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const CLAVE_FERRALLA = 'seguimiento.ferralla';
// Hoy se refresca solo: lo de ahora y lo hecho en el dia.
const REFRESCO_MS = 120_000;

export type Periodo = 'dia' | 'semana' | 'mes';

export function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dia(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function masDias(iso: string, dias: number): string {
  const d = dia(iso);
  return isoLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + dias));
}

/** El dia, la semana (de lunes) o el mes de una fecha; el que esta en curso, hasta hoy. */
export function rangoDe(periodo: Periodo, referencia: string, hoy: string): { from: string; to: string } {
  const d = dia(referencia);
  let from = referencia;
  let to = referencia;
  if (periodo === 'semana') {
    from = masDias(referencia, -((d.getDay() + 6) % 7));
    to = masDias(from, 6);
  } else if (periodo === 'mes') {
    from = isoLocal(new Date(d.getFullYear(), d.getMonth(), 1));
    to = isoLocal(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  }
  return { from, to: to > hoy ? hoy : to };
}

/** La fecha del periodo de antes o de despues. */
export function moverReferencia(periodo: Periodo, referencia: string, delta: -1 | 1): string {
  if (periodo === 'dia') return masDias(referencia, delta);
  if (periodo === 'semana') return masDias(referencia, 7 * delta);
  const d = dia(referencia);
  return isoLocal(new Date(d.getFullYear(), d.getMonth() + delta, 1));
}

export function etiquetaPeriodo(periodo: Periodo, rango: { from: string; to: string }): string {
  if (periodo === 'dia') return fechaLarga(rango.from);
  if (periodo === 'semana') return `del ${fechaCorta(rango.from)} al ${fechaCorta(rango.to)}`;
  const d = dia(rango.from);
  return `${MESES[d.getMonth()]} ${d.getFullYear()}`;
}

function hora(iso: string): string {
  return iso.slice(11, 16);
}

/** "hoy a las 09:38", "ayer a las 22:10", "el vie 6 nov a las 15:58". */
export function cuando(iso: string, hoy: string): string {
  const fecha = iso.slice(0, 10);
  const cual = fecha === hoy ? 'hoy' : fecha === masDias(hoy, -1) ? 'ayer' : fecha === masDias(hoy, 1) ? 'mañana' : `el ${fechaLarga(fecha)}`;
  return `${cual} a las ${hora(iso)}`;
}

export interface EstadoAhora {
  texto: string;
  tono: 'ok' | 'warn' | 'muted';
  detalle: string[];
}

/** Trabajando, parados, sin empezar o fuera de turno, con lo que lo explica. */
export function estadoAhora(s: SeguimientoResponse | null, hoy: string): EstadoAhora | null {
  if (!s || s.mesas == null) return null;
  if (!s.mesas) return { texto: 'Sin mesas', tono: 'muted', detalle: [] };
  const trabajando = s.mesas_trabajando ?? 0;
  const enPausa = s.mesas_en_pausa ?? 0;
  const turno = s.turno ?? null;
  const ultima = s.ultima_senal ?? null;
  const empezado = !!turno && !!ultima && Date.parse(ultima) >= Date.parse(turno.inicio);
  const detalle: string[] = [];
  let texto: string;
  let tono: EstadoAhora['tono'];
  if (enPausa >= s.mesas) {
    texto = 'En pausa';
    tono = 'muted';
  } else if (trabajando) {
    texto = 'Trabajando';
    tono = 'ok';
    detalle.push(`${trabajando} de ${s.mesas} ${s.mesas === 1 ? 'mesa' : 'mesas'}`);
    if (!turno) detalle.push('fuera de turno');
  } else if (turno && !empezado) {
    texto = 'Sin empezar';
    tono = 'warn';
  } else if (turno && ultima) {
    texto = 'Parados';
    tono = 'warn';
    detalle.push(ultima.slice(0, 10) === hoy ? `desde las ${hora(ultima)}` : `desde ${cuando(ultima, hoy)}`);
  } else {
    texto = 'Fuera de turno';
    tono = 'muted';
    if (ultima) detalle.push(`última marca ${cuando(ultima, hoy)}`);
  }
  if (enPausa && enPausa < s.mesas) detalle.push(`${enPausa} en pausa`);
  if (turno) {
    detalle.push(empezado || trabajando ? `${turno.nombre} hasta las ${hora(turno.fin)}` : `${turno.nombre} desde las ${hora(turno.inicio)}`);
  } else if (s.siguiente_turno) {
    detalle.push(`entra ${cuando(s.siguiente_turno.inicio, hoy)}`);
  }
  return { texto, tono, detalle };
}

export interface HechoProyecto {
  id: number;
  nombre: string;
  modulos: number;
  kilos: number;
}

/** Lo terminado en el periodo, por proyecto: el que mas modulos, primero. */
export function porProyecto(modulos: ProductionStatsModulo[]): HechoProyecto[] {
  const proyectos = new Map<number, HechoProyecto>();
  for (const modulo of modulos) {
    const fila = proyectos.get(modulo.proyecto_id)
      ?? { id: modulo.proyecto_id, nombre: modulo.proyecto_nombre, modulos: 0, kilos: 0 };
    fila.modulos += 1;
    fila.kilos += modulo.peso_kg || 0;
    proyectos.set(modulo.proyecto_id, fila);
  }
  return Array.from(proyectos.values()).sort((a, b) => b.modulos - a.modulos || a.nombre.localeCompare(b.nombre));
}

export interface Grafica {
  labels: string[];
  fullLabels: string[];
  series: LineChartSeries[];
  target: Array<number | null> | null;
  pending: boolean[];
}

/** Modulos por hora (un dia) o por dia (semana o mes), con el minimo de cada dia. */
export function graficaDe(stats: ProductionStatsResponse, hoy: string, horaActual: number): Grafica | null {
  const { from, to } = stats.range;
  if (from === to) {
    const porHora = new Map((stats.por_hora ?? []).map(h => [h.hora, h.modulos_completados]));
    const horas = Array.from(new Set([...(stats.range.horas ?? []), ...porHora.keys()])).sort();
    if (!horas.length) return null;
    const esHoy = from === hoy;
    return {
      labels: horas.map(h => `${h}h`),
      fullLabels: horas.map(h => `${fechaLarga(from)}, de ${h}:00 a ${String(Number(h) + 1).padStart(2, '0')}:00`),
      series: [{ name: 'Módulos', color: NARANJA, values: horas.map(h => esHoy && Number(h) > horaActual ? null : porHora.get(h) ?? 0) }],
      target: null,
      pending: horas.map(h => esHoy && Number(h) === horaActual),
    };
  }
  const objetivo = new Map((stats.range.dias ?? []).map(d => [d.fecha, d.objetivo ?? 0]));
  const porDia = new Map(stats.por_dia.map(d => [d.fecha, d.modulos_completados]));
  // Los dias con turno y los que se trabajo sin el.
  const fechas = Array.from(new Set([...objetivo.keys(), ...porDia.keys()]))
    .filter(fecha => fecha >= from && fecha <= to).sort();
  if (!fechas.length) return null;
  const conObjetivo = fechas.some(fecha => (objetivo.get(fecha) ?? 0) > 0);
  return {
    labels: fechas.map(fechaCorta),
    fullLabels: fechas.map(fechaLarga),
    series: [{ name: 'Módulos', color: NARANJA, values: fechas.map(fecha => porDia.get(fecha) ?? 0) }],
    target: conObjetivo ? fechas.map(fecha => objetivo.get(fecha) || null) : null,
    pending: fechas.map(fecha => fecha === hoy),
  };
}

function leerFerralla(): number | null {
  try {
    const valor = Number(localStorage.getItem(CLAVE_FERRALLA));
    return Number.isFinite(valor) && valor > 0 ? valor : null;
  } catch {
    return null;
  }
}

function guardarFerralla(id: number): void {
  try {
    localStorage.setItem(CLAVE_FERRALLA, String(id));
  } catch {
    // Sin almacenamiento: la proxima vez, la primera.
  }
}

/**
 * Seguimiento de una ferralla para Moden: si esta trabajando ahora, que tiene
 * en las mesas y lo que lleva hecho en el dia, la semana o el mes (las mismas
 * cifras que ve ella en sus estadisticas), sin entrar con su usuario.
 */
@Component({
  selector: 'app-seguimiento',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, StatsLineChart],
  templateUrl: './seguimiento.component.html',
  styleUrls: ['../admin-theme.css', './seguimiento.component.css'],
})
export class SeguimientoComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly ferrallas = signal<SeguimientoResponse['ferrallas']>([]);
  readonly elegida = signal<number | null>(null);
  readonly cargandoLista = signal(true);
  readonly errorLista = signal(false);

  readonly periodo = signal<Periodo>('dia');
  readonly referencia = signal(isoLocal(new Date()));
  readonly hoy = signal(isoLocal(new Date()));

  readonly ahora = signal<SeguimientoResponse | null>(null);
  readonly stats = signal<ProductionStatsResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal(false);
  private peticion = 0;
  private enVuelo = false;

  readonly cifra = cifra;
  readonly fechaCorta = fechaCorta;

  readonly rango = computed(() => rangoDe(this.periodo(), this.referencia(), this.hoy()));
  readonly etiqueta = computed(() => etiquetaPeriodo(this.periodo(), this.rango()));
  readonly estado = computed(() => estadoAhora(this.ahora(), this.hoy()));
  readonly hechos = computed(() => porProyecto(this.stats()?.modulos ?? []));
  readonly grafica = computed(() => {
    const stats = this.stats();
    return stats ? graficaDe(stats, this.hoy(), new Date().getHours()) : null;
  });

  ngOnInit(): void {
    this.cargarLista();
    const reloj = setInterval(() => this.refrescar(), REFRESCO_MS);
    this.destroyRef.onDestroy(() => clearInterval(reloj));
  }

  cargarLista(): void {
    this.cargandoLista.set(true);
    this.errorLista.set(false);
    this.api.getSeguimiento().subscribe({
      next: ({ ferrallas }) => {
        this.ferrallas.set(ferrallas);
        this.cargandoLista.set(false);
        const guardada = leerFerralla();
        const elegida = ferrallas.find(f => f.id === guardada) ?? ferrallas[0];
        if (elegida) this.elegir(elegida.id);
      },
      error: () => {
        this.errorLista.set(true);
        this.cargandoLista.set(false);
      },
    });
  }

  elegir(id: number): void {
    this.elegida.set(id);
    guardarFerralla(id);
    this.ahora.set(null);
    this.stats.set(null);
    this.cargar();
  }

  elegirPeriodo(periodo: Periodo): void {
    this.periodo.set(periodo);
    this.referencia.set(this.hoy());
    this.cargar();
  }

  puedeMover(delta: -1 | 1): boolean {
    return delta < 0 || rangoDe(this.periodo(), moverReferencia(this.periodo(), this.referencia(), delta), this.hoy()).from <= this.hoy();
  }

  mover(delta: -1 | 1): void {
    if (!this.puedeMover(delta)) return;
    this.referencia.set(moverReferencia(this.periodo(), this.referencia(), delta));
    this.cargar();
  }

  cargar(silencioso = false): void {
    const usuario = this.elegida();
    if (usuario === null) return;
    const { from, to } = this.rango();
    const peticion = ++this.peticion;
    if (!silencioso) {
      this.cargando.set(true);
      this.stats.set(null);
    }
    this.error.set(false);
    this.enVuelo = true;
    forkJoin({
      ahora: this.api.getSeguimiento(usuario),
      stats: this.api.getProductionStats({ from, to, usuario }),
    }).pipe(finalize(() => { if (peticion === this.peticion) this.enVuelo = false; })).subscribe({
      next: ({ ahora, stats }) => {
        if (peticion !== this.peticion) return;
        this.ahora.set(ahora);
        this.stats.set(stats);
        this.cargando.set(false);
      },
      error: () => {
        if (peticion !== this.peticion) return;
        // Un refresco que falla deja lo que habia.
        if (!silencioso || !this.stats()) this.error.set(true);
        this.cargando.set(false);
      },
    });
  }

  /** Cada dos minutos con la pestana a la vista: lo de ahora y, si se mira hoy, lo hecho. */
  refrescar(): void {
    const hoy = isoLocal(new Date());
    if (hoy !== this.hoy()) {
      // Pasada la medianoche, el que miraba hoy sigue mirando hoy.
      if (this.rango().to === this.hoy()) this.referencia.set(hoy);
      this.hoy.set(hoy);
    }
    const usuario = this.elegida();
    if (usuario === null || this.enVuelo || document.visibilityState !== 'visible') return;
    if (this.rango().to === this.hoy()) {
      this.cargar(true);
      return;
    }
    const peticion = this.peticion;
    this.api.getSeguimiento(usuario).subscribe({
      next: ahora => { if (peticion === this.peticion) this.ahora.set(ahora); },
      error: () => undefined,
    });
  }

  horas(valor: number | null | undefined): string {
    return valor === null || valor === undefined ? '—' : `${cifra(valor, 1)} h`;
  }
}
