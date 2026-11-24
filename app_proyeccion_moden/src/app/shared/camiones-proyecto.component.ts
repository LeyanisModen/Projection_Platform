import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Camion, CamionesProyecto } from '../services/api.service';

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** "vie 27/11" */
export function diaCorto(iso: string | null): string {
  if (!iso) return '';
  const [anio, mes, dia] = iso.split('-').map(Number);
  const fecha = new Date(anio, mes - 1, dia);
  return `${DIAS[fecha.getDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/**
 * Camiones de un forjado: cada uno sale un dia con sus bastidores (4, salvo el
 * ultimo o uno que comparte con la planta de al lado), en orden de bastidor.
 * Por defecto salen todos el dia antes del montaje; moverlos cambia cuando
 * tienen que estar hechos y cuando queda sitio en el patio. Lo usa la ficha del
 * proyecto en el admin (por ahora Moden, para los estudios; despues la ferralla).
 */
@Component({
  selector: 'app-camiones-proyecto',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cargando) {
      <p class="cam-meta">Cargando…</p>
    } @else if (datos) {
      <p class="cam-resumen">
        {{ datos.bastidores }} {{ datos.bastidores === 1 ? 'bastidor' : 'bastidores' }}@if (datos.bastidores_estimados) { <span class="cam-meta">(estimados)</span>}
        @if (datos.salida) { · por defecto salen el {{ diaCorto(datos.salida) }}, el día antes del montaje }
      </p>
      @if (filas.length) {
      <ul class="cam-lista">
        @for (fila of filas; track $index; let i = $index) {
          <li [class.cam-defecto]="fila.por_defecto && !cambiado">
            <span class="cam-nombre">Camión {{ i + 1 }}</span>
            <input type="date" class="field cam-fecha" [ngModel]="fila.fecha" (ngModelChange)="cambiar(fila, 'fecha', $event)"
              [disabled]="guardando || archivado" [attr.aria-label]="'Día del camión ' + (i + 1)">
            <select class="field cam-bastidores" [ngModel]="fila.bastidores" (ngModelChange)="cambiar(fila, 'bastidores', +$event)"
              [disabled]="guardando || archivado" [attr.aria-label]="'Bastidores del camión ' + (i + 1)">
              @for (n of opciones; track n) { <option [ngValue]="n">{{ n }}</option> }
            </select>
            <label class="cam-enviado">
              <input type="checkbox" [ngModel]="fila.enviado" (ngModelChange)="cambiar(fila, 'enviado', $event)" [disabled]="guardando || archivado">
              Enviado
            </label>
            <button type="button" class="btn-icon danger" (click)="quitar(i)" [disabled]="guardando || archivado"
              [attr.aria-label]="'Quitar el camión ' + (i + 1)" title="Quitar">
              <i class="fa fa-trash" aria-hidden="true"></i>
            </button>
          </li>
        }
      </ul>
      } @else {
        <p class="cam-meta">Sin camiones: el forjado no tiene fecha de montaje ni bastidores.</p>
      }
      @if (aviso(); as texto) { <p class="cam-aviso" role="note">{{ texto }}</p> }
      @if (error) { <p class="cam-error" role="alert">{{ error }}</p> }
      @if (!archivado) {
      <div class="cam-acciones">
        <button type="button" class="btn btn-sm" (click)="anadir()" [disabled]="guardando">
          <i class="fa fa-plus" aria-hidden="true"></i> Camión
        </button>
        @if (!datos.por_defecto || cambiado) {
          <button type="button" class="btn btn-sm" (click)="porDefecto()" [disabled]="guardando">Por defecto</button>
        }
        @if (cambiado) {
          <button type="button" class="btn btn-sm btn-primary" (click)="guardar()" [disabled]="guardando">
            {{ guardando ? 'Guardando…' : 'Guardar' }}
          </button>
        }
      </div>
      }
    }
  `,
  // Botones y campos del tema del admin (el dashboard de la ferralla usa el mismo).
  styleUrls: ['../admin/admin-theme.css'],
  styles: [`
    :host { display: flex; flex-direction: column; gap: 8px; }
    .cam-resumen, .cam-meta, .cam-aviso, .cam-error { margin: 0; font-size: 13px; }
    .cam-meta { color: var(--muted, #7b8794); }
    .cam-aviso { color: var(--warn, #b7791f); }
    .cam-error { color: var(--danger, #c0392b); }
    .cam-lista { list-style: none; margin: 0; padding: 0; }
    /* Dos lineas por camion: nombre y quitar; dia, bastidores y enviado (cabe en la columna lateral). */
    .cam-lista li { display: grid; grid-template-columns: minmax(0, 1fr) 54px auto; grid-template-areas: "nombre nombre quitar" "fecha cuantos enviado";
      align-items: center; gap: 2px 6px; padding: 6px 8px 6px 0; border-top: 1px solid var(--line, #e4e7eb); }
    .cam-lista .cam-bastidores { padding: 0 4px; }
    .cam-enviado { white-space: nowrap; }
    .cam-nombre { grid-area: nombre; }
    .cam-fecha { grid-area: fecha; }
    .cam-bastidores { grid-area: cuantos; }
    .cam-enviado { grid-area: enviado; }
    .cam-lista li .btn-icon { grid-area: quitar; justify-self: end; width: 28px; height: 24px; }
    .cam-lista li:first-child { border-top: 0; }
    .cam-lista li.cam-defecto .cam-nombre, .cam-lista li.cam-defecto .field { color: var(--muted, #7b8794); }
    .cam-nombre { color: var(--ink, #1f2933); font-size: 13px; font-weight: 500; }
    .cam-lista .field { width: 100%; min-width: 0; height: 30px; box-sizing: border-box; font-size: 13px; }
    .cam-enviado { display: inline-flex; align-items: center; gap: 4px; margin: 0; color: var(--text, #3e4c59); font-size: 12px; }
    .cam-acciones { display: flex; flex-wrap: wrap; gap: 6px; }
  `],
})
export class CamionesProyectoComponent implements OnChanges {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) proyectoId!: number;
  @Input() archivado = false;
  @Output() cambio = new EventEmitter<CamionesProyecto>();

  readonly opciones = [1, 2, 3, 4];
  readonly diaCorto = diaCorto;
  datos: CamionesProyecto | null = null;
  filas: Camion[] = [];
  cambiado = false;
  cargando = false;
  guardando = false;
  error = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['proyectoId'] && this.proyectoId) this.cargar();
  }

  cargar(): void {
    this.cargando = true;
    this.api.getCamiones(this.proyectoId).subscribe({
      next: datos => this.poner(datos),
      error: () => {
        this.cargando = false;
        this.error = 'No se han podido cargar los camiones.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Lo que llevan entre todos frente a lo que tiene el forjado. */
  aviso(): string | null {
    if (!this.datos) return null;
    const llevan = this.filas.reduce((total, fila) => total + fila.bastidores, 0);
    const diferencia = this.datos.bastidores - llevan;
    if (diferencia > 0) {
      const cuando = this.datos.salida ? ` el ${diaCorto(this.datos.salida)}` : '';
      return `Llevan ${llevan} de ${this.datos.bastidores} bastidores: ${diferencia === 1 ? 'el que falta sale' : `los ${diferencia} que faltan salen`}${cuando}.`;
    }
    if (diferencia < 0) return `Llevan ${llevan} bastidores y el forjado tiene ${this.datos.bastidores}: sobran ${-diferencia}.`;
    return null;
  }

  cambiar(fila: Camion, campo: 'fecha' | 'bastidores' | 'enviado', valor: string | number | boolean): void {
    (fila as unknown as Record<string, unknown>)[campo] = valor;
    this.cambiado = true;
    this.error = '';
  }

  anadir(): void {
    const ultima = this.filas[this.filas.length - 1];
    this.filas = [...this.filas, { fecha: ultima?.fecha ?? this.datos?.salida ?? '', bastidores: 4, enviado: false }];
    this.cambiado = true;
  }

  quitar(indice: number): void {
    this.filas = this.filas.filter((_f, i) => i !== indice);
    this.cambiado = true;
  }

  guardar(): void {
    if (this.guardando) return;
    if (!this.filas.length) {
      this.porDefecto();
      return;
    }
    if (this.filas.some(f => !f.fecha)) {
      this.error = 'Cada camión necesita su día.';
      return;
    }
    this.guardando = true;
    this.api.guardarCamiones(this.proyectoId, this.filas).subscribe({
      next: datos => this.poner(datos),
      error: err => {
        this.guardando = false;
        this.error = err?.error?.detail || 'No se han podido guardar los camiones.';
        this.cdr.markForCheck();
      },
    });
  }

  porDefecto(): void {
    if (this.guardando) return;
    this.guardando = true;
    this.api.camionesPorDefecto(this.proyectoId).subscribe({
      next: datos => this.poner(datos),
      error: err => {
        this.guardando = false;
        this.error = err?.error?.detail || 'No se han podido restablecer los camiones.';
        this.cdr.markForCheck();
      },
    });
  }

  private poner(datos: CamionesProyecto): void {
    this.datos = datos;
    this.filas = datos.camiones.map(c => ({ ...c }));
    this.cambiado = false;
    this.cargando = false;
    this.guardando = false;
    this.error = '';
    this.cambio.emit(datos);
    this.cdr.markForCheck();
  }
}
