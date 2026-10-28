import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, signal, viewChild,
} from '@angular/core';
import { formatNumber } from '@angular/common';

/** Una serie de la grafica. `prev`/`next` son los valores del periodo anterior y
 *  siguiente: la linea se prolonga hacia ellos desvanecida para dar continuidad. */
export interface LineChartSeries {
  name: string;
  color: string;
  values: Array<number | null>;
  prev?: number | null;
  next?: number | null;
  /** Lectura de cada punto en vez del valor (p. ej. el dato real de una serie indexada). */
  tooltips?: Array<string | null>;
}

/** Una sola serie que parte el alto en dos: por debajo de la linea una cosa, por encima otra
 *  (p. ej. el % del turno trabajado: debajo trabajo, encima tiempo muerto). */
export interface SplitArea {
  below: string;
  above: string;
  belowLabel: string;
  aboveLabel: string;
}

/** Una marca vertical sobre un dia (p. ej. una entrega a obra). `index` puede caer entre
 *  dos columnas (x.5): entonces cuenta para la de despues. */
export interface ChartMark {
  index: number;
  label: string;
  /** Lineas de la lectura cuando el cursor cae en su columna. */
  detalle: string[];
  /** Mas suave: p. ej. una fecha aun orientativa. */
  tenue?: boolean;
}

type PointState = 'normal' | 'cumple' | 'bajo' | 'curso';

interface ChartPoint {
  index: number;
  x: number;
  y: number;
  value: number;
  estado: PointState;
}

interface ChartFade { id: string; x1: number; y1: number; x2: number; y2: number; entra: boolean; }

interface ChartLine {
  name: string;
  color: string;
  path: string;
  area: string | null;
  areaId: string;
  points: ChartPoint[];
  fades: ChartFade[];
  /** Etiqueta directa del maximo cuando hay una sola serie; el resto lo dicen el eje y la lectura. */
  pico: { x: number; y: number; text: string } | null;
}

interface LegendItem { kind: 'line' | 'cumple' | 'bajo' | 'target' | 'area' | 'mark' | 'mark-tenue'; label: string; color: string; }

// Alto de cada fila de etiquetas de las marcas, encima de la grafica; si no caben en tres
// filas (un movil), solo las lineas: el nombre lo da la lectura.
const FILA_MARCA = 14;
const MAX_FILAS_MARCA = 3;

/** Eje de raiz cuadrada: abre los valores pequenos sin exagerarlos como un logaritmo
 *  (0 / 10 / 50 / 100 / 200 / 500). Las marcas, redondas y sin amontonarse. */
export function sqrtScale(max: number): { max: number; ticks: number[] } {
  const top = niceScale(max, 0).max;
  const posicion = (v: number) => Math.sqrt(v / top);
  const candidatos: number[] = [];
  for (let potencia = 1; potencia < top; potencia *= 10) {
    for (const m of [1, 2, 5]) if (m * potencia < top) candidatos.push(m * potencia);
  }
  const ticks = [0];
  for (const v of candidatos) {
    if (posicion(v) - posicion(ticks[ticks.length - 1]) >= 0.12 && 1 - posicion(v) >= 0.12) ticks.push(v);
  }
  ticks.push(top);
  return { max: top, ticks };
}

/** Eje con pasos redondos: 0 / 5 / 10, nunca 0 / 3.7 / 7.4. */
export function niceScale(max: number, decimals: number): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const mults = decimals === 0 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  let step = mults.map(m => m * pow).find(s => s >= raw - 1e-9) ?? 10 * pow;
  if (decimals === 0 && step < 1) step = 1;
  const top = step * Math.ceil(max / step - 1e-9);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Number(v.toFixed(6)));
  return { max: top, ticks };
}

let nextChartId = 0;

/**
 * Grafica de linea con puntos para las estadisticas: linea de objetivo discontinua,
 * puntos que dicen si se llega (relleno verde) o no (hueco), extremos desvanecidos
 * hacia el periodo anterior y siguiente, y lectura al pasar el raton o con flechas.
 */
@Component({
  selector: 'app-stats-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lc-header">
      <h4 class="lc-title">{{ title() }}@if (info()) {&ngsp;<i class="fa fa-info-circle lc-info" role="img" tabindex="0"
          [attr.title]="info()" [attr.aria-label]="info()"></i>}</h4>
      @if (legend().length) {
        <ul class="lc-legend">
          @for (item of legend(); track item.label) {
            <li>
              <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden="true">
                @switch (item.kind) {
                  @case ('line') { <line x1="1" y1="5" x2="19" y2="5" [attr.stroke]="item.color" stroke-width="2" stroke-linecap="round" /> }
                  @case ('target') { <line x1="1" y1="5" x2="19" y2="5" class="lc-target" /> }
                  @case ('cumple') { <circle cx="10" cy="5" r="4" class="lc-dot-cumple" /> }
                  @case ('bajo') { <circle cx="10" cy="5" r="3.5" class="lc-dot-hueco" [attr.stroke]="item.color" /> }
                  @case ('area') { <rect x="2" y="1" width="16" height="8" rx="2" [attr.fill]="item.color" fill-opacity="0.45" /> }
                  @case ('mark') { <line x1="10" y1="0" x2="10" y2="10" class="lc-mark" /> }
                  @case ('mark-tenue') { <line x1="10" y1="0" x2="10" y2="10" class="lc-mark lc-mark-tenue" /> }
                }
              </svg>
              {{ item.label }}
            </li>
          }
        </ul>
      }
    </div>
    <div class="lc-body" #body tabindex="0" role="group" [attr.aria-label]="ariaLabel()"
      (keydown)="onKey($event)" (focus)="onFocus()" (blur)="active.set(null)">
      @if (!hasData()) {
        <p class="lc-empty" [style.height.px]="height()">Sin datos en el periodo.</p>
      } @else {
        <svg [attr.width]="width()" [attr.height]="height()" [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
          role="img" [attr.aria-label]="ariaLabel()" (pointermove)="onMove($event)" (pointerleave)="active.set(null)">
          <defs>
            @for (line of lines(); track line.name) {
              <linearGradient [attr.id]="line.areaId" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" [attr.stop-color]="line.color" stop-opacity="0.16" />
                <stop offset="1" [attr.stop-color]="line.color" stop-opacity="0" />
              </linearGradient>
              @for (fade of line.fades; track fade.id) {
                <linearGradient [attr.id]="fade.id" gradientUnits="userSpaceOnUse"
                  [attr.x1]="fade.x1" y1="0" [attr.x2]="fade.x2" y2="0">
                  <stop offset="0" [attr.stop-color]="line.color" [attr.stop-opacity]="fade.entra ? 0 : 1" />
                  <stop offset="1" [attr.stop-color]="line.color" [attr.stop-opacity]="fade.entra ? 1 : 0" />
                </linearGradient>
              }
            }
            @if (splitAreas(); as partes) {
              <!-- Como el area de las demas: cada color fuerte junto a la linea y desvaneciendose. -->
              <linearGradient [attr.id]="uid + '-split-below'" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" [attr.stop-color]="partes.belowColor" stop-opacity="0.24" />
                <stop offset="1" [attr.stop-color]="partes.belowColor" stop-opacity="0.02" />
              </linearGradient>
              <linearGradient [attr.id]="uid + '-split-above'" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0" [attr.stop-color]="partes.aboveColor" stop-opacity="0.34" />
                <stop offset="1" [attr.stop-color]="partes.aboveColor" stop-opacity="0.04" />
              </linearGradient>
            }
          </defs>

          @for (tick of ticks(); track tick.value) {
            <line class="lc-grid" [class.lc-axis]="tick.value === 0" [attr.x1]="plot().x" [attr.x2]="plot().x + plot().w"
              [attr.y1]="tick.y" [attr.y2]="tick.y" />
            <text class="lc-tick" [attr.x]="plot().x - 8" [attr.y]="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
          }
          @for (label of xLabels(); track label.index) {
            <text class="lc-xlabel" [attr.x]="label.x" [attr.y]="height() - 8" text-anchor="middle">{{ label.text }}</text>
          }

          @if (splitAreas(); as partes) {
            <path class="lc-split-above" [attr.d]="partes.above" [attr.fill]="'url(#' + uid + '-split-above)'" />
            <path class="lc-split-below" [attr.d]="partes.below" [attr.fill]="'url(#' + uid + '-split-below)'" />
          }
          @for (line of lines(); track line.name) {
            @if (line.area) { <path [attr.d]="line.area" [attr.fill]="'url(#' + line.areaId + ')'" /> }
          }
          @for (marca of markLayout(); track $index) {
            <line class="lc-mark" [class.lc-mark-tenue]="marca.tenue" [attr.x1]="marca.x" [attr.x2]="marca.x"
              [attr.y1]="marca.y + 3" [attr.y2]="plot().y + plot().h" />
          }
          @for (marca of markLayout(); track $index) {
            @if (marca.conEtiqueta) {
            <text class="lc-mark-label" [class.lc-mark-tenue]="marca.tenue" [attr.x]="marca.anchor === 'end' ? marca.x - 3 : marca.x + 3"
              [attr.y]="marca.y" [attr.text-anchor]="marca.anchor">{{ marca.label }}</text>
            }
          }
          @if (targetPath(); as objetivo) {
            <path class="lc-target" [attr.d]="objetivo.d" />
            <text class="lc-target-label" [attr.x]="objetivo.labelX" [attr.y]="objetivo.labelY" [attr.text-anchor]="objetivo.anchor">{{ targetLabel() }}</text>
          }
          @for (line of lines(); track line.name) {
            @for (fade of line.fades; track fade.id) {
              <line class="lc-line" [attr.x1]="fade.x1" [attr.y1]="fade.y1" [attr.x2]="fade.x2" [attr.y2]="fade.y2"
                [attr.stroke]="'url(#' + fade.id + ')'" />
            }
            <path class="lc-line" [attr.d]="line.path" [attr.stroke]="line.color" />
          }
          @for (line of lines(); track line.name) {
            @if (line.pico; as pico) {
              <text class="lc-pico" [attr.x]="pico.x" [attr.y]="pico.y" text-anchor="middle">{{ pico.text }}</text>
            }
          }
          @if (active() !== null) {
            <line class="lc-cross" [attr.x1]="xAt(active()!)" [attr.x2]="xAt(active()!)"
              [attr.y1]="plot().y" [attr.y2]="plot().y + plot().h" />
          }
          @for (line of lines(); track line.name) {
            @for (point of line.points; track point.index) {
              <circle [attr.cx]="point.x" [attr.cy]="point.y" [attr.r]="dotRadius() + (point.estado === 'normal' || point.estado === 'cumple' ? 0.75 : 0) + (point.index === active() ? 1.5 : 0)"
                [class.lc-dot-cumple]="point.estado === 'cumple'"
                [class.lc-dot-hueco]="point.estado === 'bajo' || point.estado === 'curso'"
                [class.lc-dot-curso]="point.estado === 'curso'"
                [class.lc-dot]="point.estado === 'normal'"
                [attr.fill]="point.estado === 'normal' ? line.color : null"
                [attr.stroke]="point.estado === 'bajo' ? line.color : null" />
            }
          }
        </svg>
        @if (tooltip(); as tip) {
          <div class="lc-tooltip" [class.lc-tooltip-flip]="tip.flip" [style.left.px]="tip.left" [style.top.px]="tip.top" role="status">
            <span class="lc-tooltip-label">{{ tip.label }}</span>
            @for (row of tip.rows; track row.name) {
              <span class="lc-tooltip-row">
                <span class="lc-key" [style.background]="row.color"></span>
                <strong>{{ row.value }}</strong>
                @if (tip.rows.length > 1) { <span>{{ row.name }}</span> }
              </span>
            }
            @if (tip.objetivo) { <span class="lc-tooltip-row lc-tooltip-muted"><span class="lc-key lc-key-target"></span>Mínimo {{ tip.objetivo }}</span> }
            @if (tip.estado) { <span class="lc-tooltip-estado">{{ tip.estado }}</span> }
            @for (linea of tip.marcas; track $index) { <span class="lc-tooltip-marca">{{ linea }}</span> }
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; padding: 14px 16px 8px; border: 1px solid var(--line); background: var(--surface); }
    .lc-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 2px; }
    .lc-title { margin: 0; color: var(--ink); font-size: 13px; font-weight: 600; }
    .lc-info { color: var(--muted); font-size: 12px; cursor: help; }
    .lc-info:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .lc-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 11px; }
    .lc-legend li { display: inline-flex; align-items: center; gap: 5px; }
    .lc-body { position: relative; outline: none; }
    .lc-body:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .lc-empty { display: grid; place-items: center; margin: 0; color: var(--muted); font-size: 13px; }
    svg { display: block; overflow: visible; touch-action: pan-y; }
    .lc-grid { stroke: var(--line); stroke-width: 1; }
    .lc-axis { stroke: var(--line-strong); }
    .lc-tick, .lc-xlabel { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .lc-target { fill: none; stroke: var(--text); stroke-width: 1.5; stroke-dasharray: 5 4; opacity: 0.8; }
    .lc-target-label { fill: var(--text); font-size: 11px; font-weight: 600; }
    .lc-pico { fill: var(--ink); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .lc-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .lc-cross { stroke: var(--line-strong); stroke-width: 1; }
    circle { transition: r 0.12s ease; }
    .lc-dot { stroke: var(--surface); stroke-width: 2; }
    .lc-dot-cumple { fill: var(--ok); stroke: var(--surface); stroke-width: 2; }
    .lc-dot-hueco { fill: var(--surface); stroke-width: 2; }
    .lc-dot-curso { stroke: var(--muted); }
    .lc-tooltip { position: absolute; z-index: 2; display: grid; gap: 3px; min-width: 110px; padding: 8px 10px; border: 1px solid var(--line-strong);
      border-radius: var(--radius-sm); background: var(--surface); box-shadow: 0 6px 18px rgba(31, 41, 51, 0.12);
      color: var(--text); font-size: 12px; white-space: nowrap; pointer-events: none; }
    .lc-tooltip-flip { transform: translateX(-100%); }
    .lc-tooltip-label { color: var(--muted); font-size: 11px; }
    .lc-tooltip-row { display: flex; align-items: center; gap: 6px; }
    .lc-tooltip-row strong { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
    .lc-tooltip-muted { color: var(--muted); }
    .lc-tooltip-estado { color: var(--ink); font-weight: 600; }
    .lc-key { display: inline-block; width: 12px; height: 2px; border-radius: 1px; }
    .lc-key-target { height: 0; border-top: 2px dashed var(--text); background: none; }
    .lc-mark { stroke: var(--ink); stroke-width: 1.25; stroke-dasharray: 3 3; opacity: 0.7; }
    .lc-mark-tenue { opacity: 0.35; }
    /* Con un halo del fondo: si una marca cruza la etiqueta de otra, la etiqueta se lee. */
    .lc-mark-label { fill: var(--ink); font-size: 11px; font-weight: 600; paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
    .lc-mark-label.lc-mark-tenue { fill: var(--muted); font-weight: 500; opacity: 1; }
    .lc-tooltip-marca { color: var(--ink); font-weight: 600; }
  `,
})
export class StatsLineChart implements AfterViewInit, OnDestroy {
  readonly title = input('');
  /** Aclaracion del titulo: un icono (i) que la dice al pasar el raton. */
  readonly info = input('');
  readonly labels = input<string[]>([]);
  /** Lo que dice la lectura de cada columna si el eje lo abrevia ("jue 12 nov" frente a "12/11"). */
  readonly fullLabels = input<string[] | null>(null);
  readonly series = input<LineChartSeries[]>([]);
  /** Objetivo por columna; con objetivo, los puntos de la primera serie dicen si se llega. */
  readonly target = input<Array<number | null> | null>(null);
  readonly targetLabel = input('Mínimo');
  /** Area y etiqueta del maximo para la primera serie aunque haya mas de una. */
  readonly primaryArea = input(false);
  /** Techo fijo del eje (p. ej. 100 para un porcentaje). */
  readonly maxValue = input<number | null>(null);
  /** Eje de raiz cuadrada: que los valores pequenos (el desperdicio junto al peso) se vean. */
  readonly sqrtScale = input(false);
  /** La primera serie parte el alto: debajo un color, encima otro. */
  readonly split = input<SplitArea | null>(null);
  /** Columnas aun en curso: por debajo del objetivo no cuentan como incumplidas. */
  readonly pending = input<boolean[]>([]);
  /** Marcas verticales con su etiqueta encima de la grafica (p. ej. las entregas). */
  readonly marks = input<ChartMark[]>([]);
  readonly markLabel = input('Entrega');
  readonly markTenueLabel = input('');
  readonly unit = input('');
  readonly decimals = input(0);
  readonly height = input(220);

  readonly width = signal(640);
  readonly active = signal<number | null>(null);

  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  readonly uid = `lc${++nextChartId}`;
  private observer: ResizeObserver | null = null;
  private readonly margin = { top: 18, right: 18, bottom: 28, left: 46 };

  /** Marcas con su x y su fila de etiqueta: la que pisaria a otra baja una fila. */
  readonly markLayout = computed(() => {
    const m = this.margin;
    const n = Math.max(this.labels().length, 1);
    const w = Math.max(this.width() - m.left - m.right, 80);
    const finDeFila: number[] = [];
    const marcas = [...this.marks()].sort((a, b) => a.index - b.index).map(marca => {
      const x = m.left + (marca.index + 0.5) * w / n;
      const ancho = marca.label.length * 6.6 + 6;
      // Pegada al borde derecho, la etiqueta va a la izquierda de su linea.
      const anchor: 'start' | 'end' = x + ancho > this.width() ? 'end' : 'start';
      const desde = anchor === 'end' ? x - ancho : x;
      let fila = finDeFila.findIndex(fin => fin < desde - 4);
      if (fila < 0) {
        fila = finDeFila.length;
        finDeFila.push(0);
      }
      finDeFila[fila] = anchor === 'end' ? x : x + ancho;
      return { ...marca, x, fila, anchor, y: m.top - 4 + fila * FILA_MARCA, conEtiqueta: true };
    });
    if (finDeFila.length <= MAX_FILAS_MARCA) return marcas;
    return marcas.map(marca => ({ ...marca, fila: -1, y: m.top - 3, conEtiqueta: false }));
  });

  readonly plot = computed(() => {
    const m = this.margin;
    const filas = this.markLayout().reduce((max, marca) => Math.max(max, marca.fila + 1), 0);
    const top = m.top + filas * FILA_MARCA;
    return { x: m.left, y: top, w: Math.max(this.width() - m.left - m.right, 80), h: Math.max(this.height() - top - m.bottom, 40) };
  });

  /** Con muchas columnas los puntos se encogen para no pisarse. */
  readonly dotRadius = computed(() => {
    const paso = this.plot().w / Math.max(this.labels().length, 1);
    return paso < 16 ? 3 : paso < 26 ? 3.75 : 4.5;
  });

  readonly hasData = computed(() => this.labels().length > 0
    && this.series().some(s => s.values.some(v => v !== null && v !== undefined)));

  private readonly scale = computed(() => {
    const tope = this.maxValue();
    if (tope !== null) return niceScale(tope, this.decimals());
    let max = 0;
    for (const s of this.series()) {
      for (const v of [...s.values, s.prev, s.next]) if (typeof v === 'number' && v > max) max = v;
    }
    for (const t of this.target() ?? []) if (typeof t === 'number' && t > max) max = t;
    return this.sqrtScale() ? sqrtScale(max) : niceScale(max, this.decimals());
  });

  readonly ticks = computed(() => this.scale().ticks.map(value => ({ value, y: this.yAt(value), label: this.format(value) })));

  readonly xLabels = computed(() => {
    const labels = this.labels();
    const every = Math.max(1, Math.ceil(labels.length * 46 / this.plot().w));
    return labels.map((text, index) => ({ index, text, x: this.xAt(index) })).filter(l => l.index % every === 0);
  });

  readonly lines = computed<ChartLine[]>(() => {
    const n = this.labels().length;
    if (!n) return [];
    const plot = this.plot();
    const base = plot.y + plot.h;
    const target = this.target();
    const pending = this.pending();
    // Area degradada y etiqueta del maximo: solo la serie principal, y no si el alto va partido.
    const principal = (this.series().length === 1 || this.primaryArea()) && !this.split();
    return this.series().map((s, si) => {
      const points: ChartPoint[] = [];
      for (let i = 0; i < n; i++) {
        const value = s.values[i];
        if (value === null || value === undefined) continue;
        let estado: PointState = 'normal';
        const objetivo = si === 0 && target ? target[i] : null;
        if (typeof objetivo === 'number') {
          estado = value >= objetivo - 1e-9 ? 'cumple' : pending[i] ? 'curso' : 'bajo';
        }
        points.push({ index: i, x: this.xAt(i), y: this.yAt(value), value, estado });
      }
      const path = points.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
      const first = points[0];
      const last = points[points.length - 1];
      const area = principal && si === 0 && points.length > 1
        ? `${path} L${last.x.toFixed(1)} ${base} L${first.x.toFixed(1)} ${base} Z` : null;
      const fades: ChartFade[] = [];
      if (first && first.index === 0 && typeof s.prev === 'number') {
        fades.push({ id: `${this.uid}-in-${si}`, x1: plot.x, y1: this.yAt((s.prev + first.value) / 2), x2: first.x, y2: first.y, entra: true });
      }
      if (last && last.index === n - 1 && typeof s.next === 'number') {
        fades.push({ id: `${this.uid}-out-${si}`, x1: last.x, y1: last.y, x2: plot.x + plot.w, y2: this.yAt((s.next + last.value) / 2), entra: false });
      }
      const maximo = points.reduce<ChartPoint | null>((best, p) => !best || p.value > best.value ? p : best, null);
      // Con marcas, sus etiquetas van arriba: el maximo lo da la lectura.
      const pico = principal && si === 0 && maximo && maximo.value > 0 && !this.marks().length
        ? { x: maximo.x, y: maximo.y - 11, text: this.format(maximo.value) } : null;
      return { name: s.name, color: s.color, path, area, areaId: `${this.uid}-area-${si}`, points, fades, pico };
    });
  });

  /** Con el alto partido: lo de debajo de la primera linea y lo de encima, hasta el techo. */
  readonly splitAreas = computed(() => {
    const partido = this.split();
    const points = this.lines()[0]?.points ?? [];
    if (!partido || points.length < 2) return null;
    const plot = this.plot();
    const path = points.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const first = points[0];
    const last = points[points.length - 1];
    const base = plot.y + plot.h;
    const techo = this.yAt(this.scale().max);
    return {
      below: `${path} L${last.x.toFixed(1)} ${base} L${first.x.toFixed(1)} ${base} Z`,
      above: `${path} L${last.x.toFixed(1)} ${techo} L${first.x.toFixed(1)} ${techo} Z`,
      belowColor: partido.below,
      aboveColor: partido.above,
    };
  });

  readonly targetPath = computed(() => {
    const target = this.target();
    if (!target) return null;
    const plot = this.plot();
    const points = target.map((value, i) => typeof value === 'number' ? { x: this.xAt(i), y: this.yAt(value) } : null)
      .filter((p): p is { x: number; y: number } => p !== null);
    if (!points.length) return null;
    const first = points[0];
    const last = points[points.length - 1];
    const d = [`M${plot.x} ${first.y.toFixed(1)}`, ...points.map(p => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`),
      `L${plot.x + plot.w} ${last.y.toFixed(1)}`].join(' ');
    // La etiqueta va al final de la linea salvo que ahi tape un punto y al principio no.
    const choca = (desde: number, hasta: number, y: number): boolean => this.lines().some(line =>
      line.points.some(p => p.x >= desde && p.x <= hasta && p.y > y - 18 && p.y < y + 8));
    const alInicio = choca(plot.x + plot.w - 120, plot.x + plot.w, last.y - 6) && !choca(plot.x, plot.x + 120, first.y - 6);
    return alInicio
      ? { d, labelX: plot.x + 4, labelY: first.y - 6, anchor: 'start' }
      : { d, labelX: plot.x + plot.w, labelY: last.y - 6, anchor: 'end' };
  });

  readonly legend = computed<LegendItem[]>(() => {
    const series = this.series();
    const items: LegendItem[] = [];
    const partido = this.split();
    if (partido) {
      items.push({ kind: 'area', label: partido.belowLabel, color: partido.below });
      items.push({ kind: 'area', label: partido.aboveLabel, color: partido.above });
    } else if (series.length > 1) {
      for (const s of series) items.push({ kind: 'line', label: s.name, color: s.color });
    }
    const marcas = this.marks();
    if (marcas.some(marca => !marca.tenue)) items.push({ kind: 'mark', label: this.markLabel(), color: '' });
    if (marcas.some(marca => marca.tenue) && this.markTenueLabel()) {
      items.push({ kind: 'mark-tenue', label: this.markTenueLabel(), color: '' });
    }
    if (this.targetPath() && series.length) {
      items.push({ kind: 'cumple', label: 'Llega al mínimo', color: series[0].color });
      items.push({ kind: 'bajo', label: 'Por debajo', color: series[0].color });
      items.push({ kind: 'target', label: this.targetLabel(), color: '' });
    }
    return items;
  });

  readonly tooltip = computed(() => {
    const index = this.active();
    if (index === null || index < 0 || index >= this.labels().length) return null;
    const x = this.xAt(index);
    const unit = this.unit();
    const rows = this.series().map(s => {
      const value = s.values[index];
      return {
        name: s.name,
        color: s.color,
        value: s.tooltips?.[index]
          ?? (typeof value === 'number' ? `${this.format(value)}${unit ? ' ' + unit : ''}` : 'sin datos'),
      };
    });
    const objetivoValor = this.target()?.[index];
    const punto = this.lines()[0]?.points.find(p => p.index === index);
    const estado = typeof objetivoValor !== 'number' || !punto ? ''
      : punto.estado === 'cumple' ? 'Mínimo cumplido'
      : punto.estado === 'curso' ? 'En curso'
      : `Faltan ${this.format(objetivoValor - punto.value)}`;
    const flip = x > this.width() / 2;
    return {
      label: this.fullLabels()?.[index] ?? this.labels()[index],
      rows,
      marcas: this.marks().filter(marca => Math.ceil(marca.index) === index).flatMap(marca => marca.detalle),
      objetivo: typeof objetivoValor === 'number' ? this.format(objetivoValor) : '',
      estado,
      flip,
      left: flip ? x - 12 : x + 12,
      top: this.plot().y,
    };
  });

  readonly ariaLabel = computed(() => {
    const partes = this.series().map(s => {
      const valores = s.values.filter((v): v is number => typeof v === 'number');
      if (!valores.length) return `${s.name}: sin datos`;
      return `${s.name}: último valor ${this.format(valores[valores.length - 1])}, máximo ${this.format(Math.max(...valores))}`;
    });
    return `${this.title()}. ${this.labels().length} periodos. ${partes.join('. ')}. Los valores están en la tabla de detalle.`;
  });

  xAt(index: number): number {
    const plot = this.plot();
    const n = Math.max(this.labels().length, 1);
    return plot.x + (index + 0.5) * plot.w / n;
  }

  private yAt(value: number): number {
    const plot = this.plot();
    const fraccion = this.sqrtScale()
      ? Math.sqrt(Math.max(value, 0) / this.scale().max)
      : value / this.scale().max;
    return plot.y + plot.h * (1 - fraccion);
  }

  private format(value: number): string {
    return formatNumber(value, 'en-US', `1.0-${this.decimals()}`);
  }

  ngAfterViewInit(): void {
    const el = this.body()?.nativeElement;
    if (!el) return;
    if (el.clientWidth > 0) this.width.set(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    this.observer = new ResizeObserver(entries => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width > 0 && width !== this.width()) this.width.set(width);
    });
    this.observer.observe(el);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  onMove(event: PointerEvent): void {
    const n = this.labels().length;
    if (!n) return;
    const rect = (event.currentTarget as SVGElement).getBoundingClientRect();
    const plot = this.plot();
    const index = Math.floor((event.clientX - rect.left - plot.x) / (plot.w / n));
    this.active.set(Math.min(n - 1, Math.max(0, index)));
  }

  onFocus(): void {
    if (this.active() !== null) return;
    const ultimo = this.lines()[0]?.points.at(-1);
    this.active.set(ultimo ? ultimo.index : 0);
  }

  onKey(event: KeyboardEvent): void {
    const n = this.labels().length;
    if (!n || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const current = this.active() ?? 0;
    this.active.set(Math.min(n - 1, Math.max(0, current + (event.key === 'ArrowRight' ? 1 : -1))));
  }
}
