import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, output, signal, viewChild,
} from '@angular/core';

/** Una obra en el diagrama: las columnas son los dias laborables de la grafica de encima. */
export interface ObraGantt {
  id: number;
  nombre: string;
  /** Columnas en que se fabrica (null: ya esta hecha y espera en el patio). */
  desde: number | null;
  hasta: number | null;
  /** Columna de su montaje; con .5 si cae entre dos dias de fabricacion; null: despues de la vista. */
  montaje: number | null;
  /** Columnas del primer y del ultimo camion. */
  envioDesde: number | null;
  envioHasta: number | null;
  estudio: boolean;
  /** Lo que dice al pasar el raton. */
  detalle: string;
}

interface ObraDibujada extends ObraGantt {
  y: number;
  /** Barra de fabricacion. */
  x0: number;
  x1: number;
  /** Espera en el patio hasta el montaje (o hasta el borde si se monta despues). */
  xFin: number;
  xMontaje: number | null;
  xe0: number | null;
  xe1: number | null;
  tx: number;
  anchor: 'start' | 'end';
}

// Los margenes de StatsLineChart: asi cada dia cae debajo de su columna de la grafica.
const MARGEN = { left: 46, right: 18, top: 6, bottom: 24 };
const FILA = 18;
const BARRA = 8;
const LETRA = 6.3;

/**
 * Cuando se fabrica cada obra, debajo de la grafica de modulos al dia y con sus
 * mismos dias: la barra es la fabricacion, la linea fina lo que espera en el
 * patio, lo grueso de la linea los dias en que salen sus camiones y la raya el
 * montaje. Cada obra con su nombre; las que no caben en una fila bajan a otra.
 */
@Component({
  selector: 'app-fabricacion-obras',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fo-header">
      <h4 class="fo-title">{{ title() }}</h4>
      <ul class="fo-legend">
        <li><svg width="20" height="10" aria-hidden="true"><rect x="1" y="1" width="18" height="8" rx="2" [attr.fill]="colorReal()" /></svg>Fabricación</li>
        <li><svg width="20" height="10" aria-hidden="true"><line x1="1" y1="5" x2="19" y2="5" class="fo-espera" [attr.stroke]="colorReal()" /></svg>En el patio</li>
        <li><svg width="20" height="10" aria-hidden="true"><line x1="1" y1="5" x2="19" y2="5" class="fo-envio" [attr.stroke]="colorReal()" /></svg>Salen camiones</li>
        <li><svg width="20" height="10" aria-hidden="true"><line x1="10" y1="0" x2="10" y2="10" class="fo-montaje" /></svg>Montaje</li>
        @if (hayEstudio()) {
          <li><svg width="20" height="10" aria-hidden="true"><rect x="1" y="1" width="18" height="8" rx="2" [attr.fill]="colorEstudio()" /></svg>En estudio</li>
        }
      </ul>
    </div>
    <div class="fo-body" #body>
      @if (obras().length) {
        <svg [attr.width]="width()" [attr.height]="alto()" [attr.viewBox]="'0 0 ' + width() + ' ' + alto()" role="img"
          [attr.aria-label]="title()">
          @for (label of xLabels(); track label.index) {
            <line class="fo-grid" [attr.x1]="label.x" [attr.x2]="label.x" [attr.y1]="MARGEN.top" [attr.y2]="alto() - MARGEN.bottom" />
            <text class="fo-xlabel" [attr.x]="label.x" [attr.y]="alto() - 8" text-anchor="middle">{{ label.text }}</text>
          }
          @for (obra of dibujadas(); track obra.id) {
            <g class="fo-obra" tabindex="0" role="link" [attr.aria-label]="obra.detalle" (click)="abrir.emit(obra.id)"
              (keydown.enter)="abrir.emit(obra.id)">
              <title>{{ obra.detalle }}</title>
              @if (obra.xFin > obra.x1) {
                <line class="fo-espera" [attr.x1]="obra.x1" [attr.x2]="obra.xFin" [attr.y1]="obra.y + barra / 2" [attr.y2]="obra.y + barra / 2"
                  [attr.stroke]="color(obra)" />
              }
              @if (obra.xe0 !== null && obra.xe1 !== null) {
                <line class="fo-envio" [attr.x1]="obra.xe0" [attr.x2]="obra.xe1" [attr.y1]="obra.y + barra / 2" [attr.y2]="obra.y + barra / 2"
                  [attr.stroke]="color(obra)" />
              }
              @if (obra.desde !== null) {
                <rect class="fo-barra" [attr.x]="obra.x0" [attr.y]="obra.y" [attr.width]="Math.max(obra.x1 - obra.x0, 2)" [attr.height]="barra"
                  rx="2" [attr.fill]="color(obra)" />
              }
              @if (obra.xMontaje !== null) {
                <line class="fo-montaje" [attr.x1]="obra.xMontaje" [attr.x2]="obra.xMontaje" [attr.y1]="obra.y - 3" [attr.y2]="obra.y + barra + 3" />
              }
              <text class="fo-nombre" [class.fo-estudio]="obra.estudio" [attr.x]="obra.tx" [attr.y]="obra.y + barra - 0.5"
                [attr.text-anchor]="obra.anchor" [style.fill]="obra.estudio ? colorEstudio() : null">{{ obra.nombre }}</text>
            </g>
          }
        </svg>
      } @else {
        <p class="fo-vacio">Nada que fabricar en estos meses.</p>
      }
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; padding: 14px 16px 8px; border: 1px solid var(--line); background: var(--surface); }
    .fo-header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 6px; }
    .fo-title { margin: 0; color: var(--ink); font-size: 13px; font-weight: 600; }
    .fo-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 11px; }
    .fo-legend li { display: inline-flex; align-items: center; gap: 5px; }
    .fo-body { position: relative; }
    svg { display: block; overflow: visible; }
    .fo-grid { stroke: var(--line); stroke-width: 1; }
    .fo-xlabel { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .fo-espera { stroke-width: 1.5; opacity: 0.45; }
    .fo-envio { stroke-width: 4; stroke-linecap: round; opacity: 0.8; }
    .fo-montaje { stroke: var(--ink); stroke-width: 1.5; }
    .fo-nombre { fill: var(--ink); font-size: 11px; font-weight: 600; paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
    .fo-obra { cursor: pointer; outline: none; }
    .fo-obra:hover .fo-nombre, .fo-obra:focus-visible .fo-nombre { text-decoration: underline; }
    .fo-obra:focus-visible .fo-barra { stroke: var(--ink); stroke-width: 1.5; }
    .fo-vacio { margin: 8px 0; color: var(--muted); font-size: 13px; }
  `,
})
export class FabricacionObras implements AfterViewInit, OnDestroy {
  readonly title = input('Cuándo se fabrica cada obra');
  /** Las etiquetas de los dias de la grafica de encima (una por columna). */
  readonly labels = input<string[]>([]);
  readonly obras = input<ObraGantt[]>([]);
  readonly colorReal = input('#f0640f');
  readonly colorEstudio = input('#2264b8');
  /** Abrir la ficha de una obra. */
  readonly abrir = output<number>();

  readonly MARGEN = MARGEN;
  readonly barra = BARRA;
  readonly Math = Math;
  readonly width = signal(640);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private observer: ResizeObserver | null = null;

  readonly hayEstudio = computed(() => this.obras().some(o => o.estudio));

  private readonly paso = computed(() => Math.max(this.width() - MARGEN.left - MARGEN.right, 80) / Math.max(this.labels().length, 1));

  /** Cada obra en la primera fila donde no pisa a la anterior (barra, espera y nombre). */
  readonly dibujadas = computed<ObraDibujada[]>(() => {
    const paso = this.paso();
    const ancho = this.width();
    const borde = MARGEN.left + this.labels().length * paso;
    const izquierda = (columna: number) => MARGEN.left + columna * paso;
    const centro = (columna: number) => MARGEN.left + (columna + 0.5) * paso;
    const finDeFila: number[] = [];
    const orden = [...this.obras()].sort((a, b) => (a.desde ?? -1) - (b.desde ?? -1) || (a.montaje ?? 1e9) - (b.montaje ?? 1e9));
    return orden.map(obra => {
      const x0 = obra.desde !== null ? izquierda(obra.desde) + 1 : MARGEN.left;
      const x1 = obra.hasta !== null ? izquierda(obra.hasta + 1) - 1 : x0;
      const xMontaje = obra.montaje !== null ? centro(obra.montaje) : null;
      const xFin = xMontaje ?? borde;
      const xe0 = obra.envioDesde !== null ? centro(obra.envioDesde) : null;
      const xe1 = obra.envioHasta !== null ? centro(obra.envioHasta) : null;
      const texto = obra.nombre.length * LETRA + 4;
      // El nombre detras del montaje; pegado al borde derecho, delante de la barra.
      let anchor: 'start' | 'end' = 'start';
      let tx = Math.max(x1, xFin) + 5;
      if (tx + texto > ancho) {
        anchor = 'end';
        tx = x0 - 5;
      }
      const desde = anchor === 'end' ? tx - texto : x0;
      const hasta = anchor === 'end' ? Math.max(x1, xFin) : tx + texto;
      let fila = finDeFila.findIndex(fin => fin < desde - 6);
      if (fila < 0) {
        fila = finDeFila.length;
        finDeFila.push(0);
      }
      finDeFila[fila] = hasta;
      return { ...obra, y: MARGEN.top + 4 + fila * FILA, x0, x1, xFin, xMontaje, xe0, xe1, tx, anchor };
    });
  });

  readonly alto = computed(() => {
    const filas = this.dibujadas().reduce((max, obra) => Math.max(max, (obra.y - MARGEN.top - 4) / FILA + 1), 0);
    return MARGEN.top + 4 + filas * FILA + MARGEN.bottom;
  });

  readonly xLabels = computed(() => {
    const labels = this.labels();
    const paso = this.paso();
    const cada = Math.max(1, Math.ceil(46 / paso));
    return labels.map((text, index) => ({ index, text, x: MARGEN.left + (index + 0.5) * paso })).filter(l => l.index % cada === 0);
  });

  color(obra: ObraGantt): string {
    return obra.estudio ? this.colorEstudio() : this.colorReal();
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
}
