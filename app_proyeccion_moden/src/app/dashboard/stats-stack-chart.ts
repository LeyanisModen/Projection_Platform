import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, signal, viewChild,
} from '@angular/core';
import { formatNumber } from '@angular/common';
import { LineChartSeries, niceScale } from './stats-line-chart';

interface StackSegment { name: string; color: string; d: string; }

interface StackBar { index: number; x: number; segments: StackSegment[]; }

/** Rectangulo con las esquinas de arriba redondeadas (el extremo de la barra). */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const radio = Math.max(0, Math.min(r, w / 2, h));
  if (radio === 0) return `M${x} ${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x} ${y + h}V${y + radio}Q${x} ${y} ${x + radio} ${y}H${x + w - radio}Q${x + w} ${y} ${x + w} ${y + radio}V${y + h}Z`;
}

/**
 * Barras apiladas de las estadisticas: cada columna es un entero (las horas de
 * turno) partido en sus partes, la primera serie abajo (el trabajo) y las demas
 * encima (el tiempo muerto). Lectura al pasar el raton o con las flechas.
 */
@Component({
  selector: 'app-stats-stack-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc-header">
      <h4 class="sc-title">{{ title() }}</h4>
      <ul class="sc-legend">
        @for (s of series(); track s.name) {
          <li><span class="sc-swatch" [style.background]="s.color" aria-hidden="true"></span>{{ s.name }}</li>
        }
      </ul>
    </div>
    <div class="sc-body" #body tabindex="0" role="group" [attr.aria-label]="ariaLabel()"
      (keydown)="onKey($event)" (focus)="onFocus()" (blur)="active.set(null)">
      @if (!hasData()) {
        <p class="sc-empty" [style.height.px]="height()">Sin datos en el periodo.</p>
      } @else {
        <svg [attr.width]="width()" [attr.height]="height()" [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
          role="img" [attr.aria-label]="ariaLabel()" (pointermove)="onMove($event)" (pointerleave)="active.set(null)">
          @for (tick of ticks(); track tick.value) {
            <line class="sc-grid" [class.sc-axis]="tick.value === 0" [attr.x1]="plot().x" [attr.x2]="plot().x + plot().w"
              [attr.y1]="tick.y" [attr.y2]="tick.y" />
            <text class="sc-tick" [attr.x]="plot().x - 8" [attr.y]="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
          }
          @for (label of xLabels(); track label.index) {
            <text class="sc-xlabel" [attr.x]="label.x" [attr.y]="height() - 8" text-anchor="middle">{{ label.text }}</text>
          }
          @for (bar of bars(); track bar.index) {
            <g class="sc-bar" [class.sc-dim]="active() !== null && active() !== bar.index">
              @for (seg of bar.segments; track seg.name) {
                <path [attr.d]="seg.d" [attr.fill]="seg.color" />
              }
            </g>
          }
        </svg>
        @if (tooltip(); as tip) {
          <div class="sc-tooltip" [class.sc-tooltip-flip]="tip.flip" [style.left.px]="tip.left" [style.top.px]="tip.top" role="status">
            <span class="sc-tooltip-label">{{ tip.label }}</span>
            @for (row of tip.rows; track row.name) {
              <span class="sc-tooltip-row">
                <span class="sc-key" [style.background]="row.color"></span>
                <strong>{{ row.value }}</strong>
                <span>{{ row.name }}</span>
              </span>
            }
            @if (tip.share) { <span class="sc-tooltip-share">{{ tip.share }}</span> }
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; padding: 14px 16px 8px; border: 1px solid var(--line); background: var(--surface); }
    .sc-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 2px; }
    .sc-title { margin: 0; color: var(--ink); font-size: 13px; font-weight: 600; }
    .sc-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 11px; }
    .sc-legend li { display: inline-flex; align-items: center; gap: 5px; }
    .sc-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
    .sc-body { position: relative; outline: none; }
    .sc-body:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .sc-empty { display: grid; place-items: center; margin: 0; color: var(--muted); font-size: 13px; }
    svg { display: block; overflow: visible; touch-action: pan-y; }
    .sc-grid { stroke: var(--line); stroke-width: 1; }
    .sc-axis { stroke: var(--line-strong); }
    .sc-tick, .sc-xlabel { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .sc-bar { transition: opacity 0.12s ease; }
    .sc-dim { opacity: 0.45; }
    .sc-tooltip { position: absolute; z-index: 2; display: grid; gap: 3px; min-width: 120px; padding: 8px 10px; border: 1px solid var(--line-strong);
      border-radius: var(--radius-sm); background: var(--surface); box-shadow: 0 6px 18px rgba(31, 41, 51, 0.12);
      color: var(--text); font-size: 12px; white-space: nowrap; pointer-events: none; }
    .sc-tooltip-flip { transform: translateX(-100%); }
    .sc-tooltip-label { color: var(--muted); font-size: 11px; }
    .sc-tooltip-row { display: flex; align-items: center; gap: 6px; }
    .sc-tooltip-row strong { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
    .sc-tooltip-share { color: var(--ink); font-weight: 600; }
    .sc-key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  `,
})
export class StatsStackChart implements AfterViewInit, OnDestroy {
  readonly title = input('');
  readonly labels = input<string[]>([]);
  /** Partes de cada columna, de abajo arriba. */
  readonly series = input<LineChartSeries[]>([]);
  readonly unit = input('');
  readonly decimals = input(0);
  readonly height = input(220);
  /** Con texto, la lectura dice que parte del total es la primera serie: "62 % trabajado". */
  readonly shareLabel = input('');

  readonly width = signal(640);
  readonly active = signal<number | null>(null);

  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private observer: ResizeObserver | null = null;
  private readonly margin = { top: 18, right: 18, bottom: 28, left: 46 };
  /** Hueco del color del fondo entre las partes de una barra. */
  private readonly gap = 2;

  readonly plot = computed(() => {
    const m = this.margin;
    return { x: m.left, y: m.top, w: Math.max(this.width() - m.left - m.right, 80), h: Math.max(this.height() - m.top - m.bottom, 40) };
  });

  private readonly totals = computed(() => this.labels().map((_, i) =>
    this.series().reduce((sum, s) => sum + (typeof s.values[i] === 'number' && s.values[i]! > 0 ? s.values[i]! : 0), 0)));

  readonly hasData = computed(() => this.labels().length > 0 && this.totals().some(total => total > 0));

  private readonly scale = computed(() => niceScale(Math.max(0, ...this.totals()), this.decimals()));

  readonly ticks = computed(() => this.scale().ticks.map(value => ({ value, y: this.yAt(value), label: this.format(value) })));

  readonly xLabels = computed(() => {
    const labels = this.labels();
    const every = Math.max(1, Math.ceil(labels.length * 46 / this.plot().w));
    return labels.map((text, index) => ({ index, text, x: this.xAt(index) })).filter(l => l.index % every === 0);
  });

  readonly bars = computed<StackBar[]>(() => {
    const n = this.labels().length;
    const plot = this.plot();
    const ancho = Math.max(4, Math.min(36, (plot.w / Math.max(n, 1)) * 0.6));
    const bars: StackBar[] = [];
    for (let i = 0; i < n; i++) {
      const partes = this.series()
        .map(s => ({ s, value: s.values[i] }))
        .filter((p): p is { s: LineChartSeries; value: number } => typeof p.value === 'number' && p.value > 0);
      if (!partes.length) continue;
      let base = plot.y + plot.h;
      const x = this.xAt(i) - ancho / 2;
      const segments = partes.map((parte, k) => {
        const alto = (parte.value / this.scale().max) * plot.h;
        const top = base - alto;
        // Entre una parte y la de debajo, el hueco sale de la de arriba.
        const hueco = k > 0 ? Math.min(this.gap, alto) : 0;
        const ultima = k === partes.length - 1;
        const d = barPath(x, top, ancho, Math.max(0, alto - hueco), ultima ? 4 : 0);
        base = top;
        return { name: parte.s.name, color: parte.s.color, d };
      });
      bars.push({ index: i, x: this.xAt(i), segments });
    }
    return bars;
  });

  readonly tooltip = computed(() => {
    const index = this.active();
    if (index === null || index < 0 || index >= this.labels().length) return null;
    const unit = this.unit();
    const rows = this.series().map(s => {
      const value = s.values[index];
      return {
        name: s.name,
        color: s.color,
        value: typeof value === 'number' ? `${this.format(value)}${unit ? ' ' + unit : ''}` : 'sin datos',
      };
    });
    const total = this.totals()[index];
    const primera = this.series()[0]?.values[index];
    const share = this.shareLabel() && total > 0 && typeof primera === 'number'
      ? `${Math.round((primera / total) * 100)} % ${this.shareLabel()}` : '';
    const x = this.xAt(index);
    const flip = x > this.width() / 2;
    return { label: this.labels()[index], rows, share, flip, left: flip ? x - 12 : x + 12, top: this.plot().y };
  });

  readonly ariaLabel = computed(() => {
    const partes = this.series().map(s => {
      const total = s.values.reduce<number>((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
      return `${s.name}: ${this.format(total)}${this.unit() ? ' ' + this.unit() : ''} en total`;
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
    const ultima = this.bars().at(-1);
    this.active.set(ultima ? ultima.index : 0);
  }

  onKey(event: KeyboardEvent): void {
    const n = this.labels().length;
    if (!n || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const current = this.active() ?? 0;
    this.active.set(Math.min(n - 1, Math.max(0, current + (event.key === 'ArrowRight' ? 1 : -1))));
  }
}
