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

interface LegendItem { kind: 'line' | 'cumple' | 'bajo' | 'target'; label: string; color: string; }

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
      <h4 class="lc-title">{{ title() }}</h4>
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
          </defs>

          @for (tick of ticks(); track tick.value) {
            <line class="lc-grid" [class.lc-axis]="tick.value === 0" [attr.x1]="plot().x" [attr.x2]="plot().x + plot().w"
              [attr.y1]="tick.y" [attr.y2]="tick.y" />
            <text class="lc-tick" [attr.x]="plot().x - 8" [attr.y]="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
          }
          @for (label of xLabels(); track label.index) {
            <text class="lc-xlabel" [attr.x]="label.x" [attr.y]="height() - 8" text-anchor="middle">{{ label.text }}</text>
          }

          @for (line of lines(); track line.name) {
            @if (line.area) { <path [attr.d]="line.area" [attr.fill]="'url(#' + line.areaId + ')'" /> }
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
            @if (tip.objetivo) { <span class="lc-tooltip-row lc-tooltip-muted"><span class="lc-key lc-key-target"></span>Objetivo {{ tip.objetivo }}</span> }
            @if (tip.estado) { <span class="lc-tooltip-estado">{{ tip.estado }}</span> }
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; padding: 14px 16px 8px; border: 1px solid var(--line); background: var(--surface); }
    .lc-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 2px; }
    .lc-title { margin: 0; color: var(--ink); font-size: 13px; font-weight: 600; }
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
  `,
})
export class StatsLineChart implements AfterViewInit, OnDestroy {
  readonly title = input('');
  readonly labels = input<string[]>([]);
  readonly series = input<LineChartSeries[]>([]);
  /** Objetivo por columna; con objetivo, los puntos de la primera serie dicen si se llega. */
  readonly target = input<Array<number | null> | null>(null);
  readonly targetLabel = input('Objetivo');
  /** Columnas aun en curso: por debajo del objetivo no cuentan como incumplidas. */
  readonly pending = input<boolean[]>([]);
  readonly unit = input('');
  readonly decimals = input(0);
  readonly height = input(220);

  readonly width = signal(640);
  readonly active = signal<number | null>(null);

  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private readonly uid = `lc${++nextChartId}`;
  private observer: ResizeObserver | null = null;
  private readonly margin = { top: 18, right: 18, bottom: 28, left: 46 };

  readonly plot = computed(() => {
    const m = this.margin;
    return { x: m.left, y: m.top, w: Math.max(this.width() - m.left - m.right, 80), h: Math.max(this.height() - m.top - m.bottom, 40) };
  });

  /** Con muchas columnas los puntos se encogen para no pisarse. */
  readonly dotRadius = computed(() => {
    const paso = this.plot().w / Math.max(this.labels().length, 1);
    return paso < 16 ? 3 : paso < 26 ? 3.75 : 4.5;
  });

  readonly hasData = computed(() => this.labels().length > 0
    && this.series().some(s => s.values.some(v => v !== null && v !== undefined)));

  private readonly scale = computed(() => {
    let max = 0;
    for (const s of this.series()) {
      for (const v of [...s.values, s.prev, s.next]) if (typeof v === 'number' && v > max) max = v;
    }
    for (const t of this.target() ?? []) if (typeof t === 'number' && t > max) max = t;
    return niceScale(max, this.decimals());
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
    const single = this.series().length === 1;
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
      const area = single && points.length > 1
        ? `${path} L${last.x.toFixed(1)} ${base} L${first.x.toFixed(1)} ${base} Z` : null;
      const fades: ChartFade[] = [];
      if (first && first.index === 0 && typeof s.prev === 'number') {
        fades.push({ id: `${this.uid}-in-${si}`, x1: plot.x, y1: this.yAt((s.prev + first.value) / 2), x2: first.x, y2: first.y, entra: true });
      }
      if (last && last.index === n - 1 && typeof s.next === 'number') {
        fades.push({ id: `${this.uid}-out-${si}`, x1: last.x, y1: last.y, x2: plot.x + plot.w, y2: this.yAt((s.next + last.value) / 2), entra: false });
      }
      const maximo = points.reduce<ChartPoint | null>((best, p) => !best || p.value > best.value ? p : best, null);
      const pico = single && maximo && maximo.value > 0
        ? { x: maximo.x, y: maximo.y - 11, text: this.format(maximo.value) } : null;
      return { name: s.name, color: s.color, path, area, areaId: `${this.uid}-area-${si}`, points, fades, pico };
    });
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
    if (series.length > 1) {
      for (const s of series) items.push({ kind: 'line', label: s.name, color: s.color });
    }
    if (this.targetPath() && series.length) {
      items.push({ kind: 'cumple', label: 'Llega al objetivo', color: series[0].color });
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
        value: typeof value === 'number' ? `${this.format(value)}${unit ? ' ' + unit : ''}` : 'sin datos',
      };
    });
    const objetivoValor = this.target()?.[index];
    const punto = this.lines()[0]?.points.find(p => p.index === index);
    const estado = typeof objetivoValor !== 'number' || !punto ? ''
      : punto.estado === 'cumple' ? 'Objetivo cumplido'
      : punto.estado === 'curso' ? 'En curso'
      : `Faltan ${this.format(objetivoValor - punto.value)}`;
    const flip = x > this.width() / 2;
    return {
      label: this.labels()[index],
      rows,
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
    return plot.y + plot.h * (1 - value / this.scale().max);
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
