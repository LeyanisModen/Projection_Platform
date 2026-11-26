import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, computed, input, output, signal, viewChild,
} from '@angular/core';
import { ChartBand } from '../../dashboard/stats-line-chart';

/** Un dia en que salen camiones de una obra. */
export interface SalidaGantt {
  /** Columna del dia (x.5 si cae en un dia sin fabricacion). */
  columna: number;
  camiones: number;
  /** Ese dia la ferralla saca, entre todas, mas camiones de los que puede. */
  demas: boolean;
}

/** Una obra en el diagrama: las columnas son los dias laborables de la grafica de encima. */
export interface ObraGantt {
  id: number;
  nombre: string;
  /** Columnas en que se fabrica (null: ya esta hecha y espera en el patio). */
  desde: number | null;
  hasta: number | null;
  /** Columna de su montaje; con .5 si cae entre dos dias de fabricacion; null: despues de la vista. */
  montaje: number | null;
  salidas: SalidaGantt[];
  estudio: boolean;
  /** No llega a sus camiones: lo que le falta. */
  noLlega?: string | null;
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
  marcas: Array<{ x1: number; x2: number; demas: boolean }>;
  tx: number;
  anchor: 'start' | 'end';
}

// Los margenes de StatsLineChart: asi cada dia cae debajo de su columna de la grafica.
const MARGEN = { left: 46, right: 18, top: 6, bottom: 24 };
const FILA = 18;
const BARRA = 8;
const LETRA = 6.3;
const ROJO = '#c0392b';

/**
 * Cuando se fabrica cada obra, debajo de la grafica de modulos al dia y con sus
 * mismos dias: la barra es la fabricacion, la linea fina lo que espera en el
 * patio, cada trazo grueso un dia en que salen sus camiones (en rojo si ese dia
 * salen mas de los que puede la ferralla; sin camiones, no hay) y la raya el montaje. Las columnas
 * sombreadas son dias con el patio lleno: solo se fabrica lo que sale. Una obra
 * que no llega lleva el nombre en rojo. Las que no caben en una fila bajan a otra.
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
        @if (hayCamiones()) {
          <li><svg width="20" height="10" aria-hidden="true"><line x1="7" y1="5" x2="13" y2="5" class="fo-envio" [attr.stroke]="colorReal()" /></svg>Salen camiones</li>
        }
        @if (hayDemas()) {
          <li><svg width="20" height="10" aria-hidden="true"><line x1="7" y1="5" x2="13" y2="5" class="fo-envio" [attr.stroke]="rojo" /></svg>{{ textoDemas() }}</li>
        }
        <li><svg width="20" height="10" aria-hidden="true"><line x1="10" y1="0" x2="10" y2="10" class="fo-montaje" /></svg>Montaje</li>
        @for (banda of bandasVisibles(); track banda.label) {
          <li><svg width="20" height="10" aria-hidden="true"><rect x="1" y="0" width="18" height="10" [attr.fill]="banda.color" class="fo-banda" /></svg>{{ banda.label }}</li>
        }
        @if (hayEstudio()) {
          <li><svg width="20" height="10" aria-hidden="true"><rect x="1" y="1" width="18" height="8" rx="2" [attr.fill]="colorEstudio()" /></svg>En estudio</li>
        }
        @if (hayNoLlega()) {
          <li class="fo-no-llega-leyenda">Nombre en rojo: no llega</li>
        }
      </ul>
    </div>
    <div class="fo-body" #body>
      @if (obras().length) {
        <svg [attr.width]="width()" [attr.height]="alto()" [attr.viewBox]="'0 0 ' + width() + ' ' + alto()" role="img"
          [attr.aria-label]="title()">
          @for (columna of columnasBanda(); track $index) {
            <rect class="fo-banda" [attr.x]="columna.x" [attr.y]="MARGEN.top" [attr.width]="columna.w" [attr.height]="alto() - MARGEN.top - MARGEN.bottom"
              [attr.fill]="columna.color" />
          }
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
              @if (obra.desde !== null) {
                <rect class="fo-barra" [attr.x]="obra.x0" [attr.y]="obra.y" [attr.width]="Math.max(obra.x1 - obra.x0, 2)" [attr.height]="barra"
                  rx="2" [attr.fill]="color(obra)" />
              }
              @for (marca of obra.marcas; track $index) {
                <line class="fo-envio" [attr.x1]="marca.x1" [attr.x2]="marca.x2" [attr.y1]="obra.y + barra / 2" [attr.y2]="obra.y + barra / 2"
                  [attr.stroke]="marca.demas ? rojo : color(obra)" />
              }
              @if (obra.xMontaje !== null) {
                <line class="fo-montaje" [attr.x1]="obra.xMontaje" [attr.x2]="obra.xMontaje" [attr.y1]="obra.y - 3" [attr.y2]="obra.y + barra + 3" />
              }
              <text class="fo-nombre" [class.fo-no-llega]="!!obra.noLlega" [attr.x]="obra.tx" [attr.y]="obra.y + barra - 0.5"
                [attr.text-anchor]="obra.anchor" [style.fill]="obra.noLlega ? rojo : obra.estudio ? colorEstudio() : null">{{ obra.nombre }}</text>
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
    .fo-no-llega-leyenda { color: #c0392b; }
    .fo-body { position: relative; }
    svg { display: block; overflow: visible; }
    .fo-grid { stroke: var(--line); stroke-width: 1; }
    .fo-banda { opacity: 0.12; }
    .fo-xlabel { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .fo-espera { stroke-width: 1.5; opacity: 0.45; }
    .fo-envio { stroke-width: 5; stroke-linecap: round; }
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
  /** Los camiones que saca la ferralla al dia (para la leyenda de los dias de mas). */
  readonly camionesPorDia = input<number | null>(null);
  /** Dias con el patio lleno (columnas sombreadas). */
  readonly bandas = input<ChartBand[]>([]);
  /** Abrir la ficha de una obra. */
  readonly abrir = output<number>();

  readonly MARGEN = MARGEN;
  readonly barra = BARRA;
  readonly rojo = ROJO;
  readonly Math = Math;
  readonly width = signal(640);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private observer: ResizeObserver | null = null;

  readonly hayEstudio = computed(() => this.obras().some(o => o.estudio));
  /** Sin camiones (la planificacion 1: todo sale el dia antes del montaje), solo barra, patio y montaje. */
  readonly hayCamiones = computed(() => this.obras().some(o => o.salidas.length));
  readonly hayDemas = computed(() => this.obras().some(o => o.salidas.some(s => s.demas)));
  readonly hayNoLlega = computed(() => this.obras().some(o => !!o.noLlega));
  readonly bandasVisibles = computed(() => this.bandas().filter(b => b.days.some(Boolean)));
  readonly textoDemas = computed(() => {
    const porDia = this.camionesPorDia();
    return porDia ? `Más de ${porDia} camiones ese día` : 'Más camiones de los que caben';
  });

  private readonly paso = computed(() => Math.max(this.width() - MARGEN.left - MARGEN.right, 80) / Math.max(this.labels().length, 1));

  /** Un rectangulo por columna sombreada (la primera banda que la marca). */
  readonly columnasBanda = computed(() => {
    const paso = this.paso();
    const columnas: Array<{ x: number; w: number; color: string }> = [];
    for (let i = 0; i < this.labels().length; i++) {
      const banda = this.bandas().find(b => b.days[i]);
      if (banda) columnas.push({ x: MARGEN.left + i * paso, w: paso, color: banda.color });
    }
    return columnas;
  });

  /** Cada obra en la primera fila donde no pisa a la anterior (barra, espera y nombre). */
  readonly dibujadas = computed<ObraDibujada[]>(() => {
    const paso = this.paso();
    const ancho = this.width();
    const borde = MARGEN.left + this.labels().length * paso;
    const izquierda = (columna: number) => MARGEN.left + columna * paso;
    const centro = (columna: number) => MARGEN.left + (columna + 0.5) * paso;
    // Un trazo por dia de camiones, mas corto que la columna para que se vean sueltos.
    const medio = Math.max(Math.min(paso * 0.3, 6), 1);
    const finDeFila: number[] = [];
    const orden = [...this.obras()].sort((a, b) => (a.desde ?? -1) - (b.desde ?? -1) || (a.montaje ?? 1e9) - (b.montaje ?? 1e9));
    return orden.map(obra => {
      const x0 = obra.desde !== null ? izquierda(obra.desde) + 1 : MARGEN.left;
      const x1 = obra.hasta !== null ? izquierda(obra.hasta + 1) - 1 : x0;
      const xMontaje = obra.montaje !== null ? centro(obra.montaje) : null;
      const xFin = xMontaje ?? borde;
      const marcas = obra.salidas.map(s => ({ x1: centro(s.columna) - medio, x2: centro(s.columna) + medio, demas: s.demas }));
      const derecha = Math.max(x1, xFin, ...marcas.map(m => m.x2));
      const texto = obra.nombre.length * LETRA + 4;
      // El nombre detras del montaje; pegado al borde derecho, delante de la barra.
      let anchor: 'start' | 'end' = 'start';
      let tx = derecha + 5;
      if (tx + texto > ancho) {
        anchor = 'end';
        tx = x0 - 5;
      }
      const desde = anchor === 'end' ? tx - texto : x0;
      const hasta = anchor === 'end' ? derecha : tx + texto;
      let fila = finDeFila.findIndex(fin => fin < desde - 6);
      if (fila < 0) {
        fila = finDeFila.length;
        finDeFila.push(0);
      }
      finDeFila[fila] = hasta;
      return { ...obra, y: MARGEN.top + 4 + fila * FILA, x0, x1, xFin, xMontaje, marcas, tx, anchor };
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
