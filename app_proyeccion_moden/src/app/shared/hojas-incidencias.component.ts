import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnDestroy,
  Output, SimpleChanges, inject,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Subscription } from 'rxjs';
import { ApiService, HojaIncidencias } from '../services/api.service';

/**
 * Hojas de incidencias de un proyecto: el PDF escaneado de las hojas que
 * firma el supervisor junto a las mesas al terminar cada modulo, con lo que
 * haya pasado. Se suben, se ven y se descargan. Lo usan la tarjeta del
 * proyecto en el dashboard de la ferralla (con visor) y la ficha del
 * proyecto en el admin (sin visor: «Ver» abre otra pestaña).
 */
@Component({
  selector: 'app-hojas-incidencias',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hojas-barra">
      @if (!archivado) {
        <label class="hojas-subir" [class.is-busy]="subiendo">
          <input type="file" accept="application/pdf,.pdf" multiple (change)="subir($event)" [disabled]="subiendo">
          <i class="fa" [class.fa-upload]="!subiendo" [class.fa-spinner]="subiendo" [class.fa-spin]="subiendo" aria-hidden="true"></i>
          {{ subiendo ? 'Subiendo…' : 'Subir PDF' }}
        </label>
      } @else {
        <span class="hojas-meta">Proyecto archivado: las hojas van en su .zip.</span>
      }
      @if (hojas.length) {
        <span class="hojas-meta">{{ hojas.length }} {{ hojas.length === 1 ? 'hoja' : 'hojas' }}</span>
      }
    </div>
    @if (error) { <p class="hojas-error" role="alert">{{ error }}</p> }

    @if (cargando) {
      <p class="hojas-meta">Cargando…</p>
    } @else if (hojas.length === 0) {
      <p class="hojas-vacio">Aún no hay hojas.</p>
    } @else {
      <div class="hojas-cuerpo" [class.con-visor]="conVisor">
        <ul class="hojas-lista">
          @for (hoja of hojas; track hoja.id) {
            <li [class.is-activa]="conVisor && hoja.id === seleccionada?.id">
              <button type="button" class="hojas-abrir" (click)="ver(hoja)" [title]="'Ver ' + hoja.nombre">
                <i class="fa fa-file-pdf-o" aria-hidden="true"></i>
                <span class="hojas-texto">
                  <span class="hojas-nombre">{{ hoja.nombre }}</span>
                  <span class="hojas-meta">
                    {{ hoja.subido_at | date:'dd/MM/yyyy HH:mm' }}
                    · {{ hoja.de_moden ? 'Moden' : (hoja.subido_por || 'ferralla') }}
                    · {{ tamano(hoja.tamano) }}
                  </span>
                </span>
              </button>
              @if (hoja.url) {
                <a class="hojas-accion" [href]="hoja.url" [attr.download]="hoja.nombre"
                  [title]="'Descargar ' + hoja.nombre" [attr.aria-label]="'Descargar ' + hoja.nombre">
                  <i class="fa fa-download" aria-hidden="true"></i>
                </a>
              }
              @if (hoja.puede_borrar) {
                <button type="button" class="hojas-accion hojas-borrar" (click)="borrar(hoja)" [disabled]="borrando"
                  [title]="'Borrar ' + hoja.nombre" [attr.aria-label]="'Borrar ' + hoja.nombre">
                  <i class="fa fa-trash" aria-hidden="true"></i>
                </button>
              }
            </li>
          }
        </ul>
        @if (conVisor && seleccionada?.url) {
          <div class="hojas-visor">
            <iframe [src]="urlVisor" [title]="seleccionada!.nombre"></iframe>
            <a class="hojas-pestana" [href]="seleccionada!.url" target="_blank" rel="noopener">
              <i class="fa fa-external-link" aria-hidden="true"></i> Abrir en otra pestaña
            </a>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
    .hojas-barra { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }
    .hojas-subir { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 32px; margin: 0; padding: 0 12px;
      border: 1px solid var(--accent, #f0640f); border-radius: var(--radius-sm, 7px); background: var(--accent, #f0640f); color: #fff;
      font-size: 13px; font-weight: 600; cursor: pointer; }
    .hojas-subir:hover { background: var(--accent-dark, #c24c08); border-color: var(--accent-dark, #c24c08); }
    .hojas-subir.is-busy { opacity: 0.7; cursor: default; }
    .hojas-subir input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .hojas-subir:focus-within { outline: 2px solid var(--accent-dark, #c24c08); outline-offset: 2px; }
    .hojas-meta { color: var(--muted, #7b8794); font-size: 12px; }
    .hojas-vacio { margin: 0; color: var(--muted, #7b8794); font-size: 13px; }
    .hojas-error { margin: 0; color: var(--danger, #c0392b); font-size: 13px; }
    .hojas-cuerpo { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
    .hojas-cuerpo.con-visor { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; flex: 1; }
    .hojas-lista { list-style: none; margin: 0; padding: 0; max-height: 60vh; overflow-y: auto; }
    .hojas-lista li { display: flex; align-items: center; gap: 2px; padding: 6px 0; border-top: 1px solid var(--line, #e4e7eb); }
    .hojas-lista li:first-child { border-top: 0; }
    .hojas-lista li.is-activa .hojas-nombre { color: var(--accent-dark, #c24c08); }
    .hojas-abrir { display: flex; align-items: flex-start; gap: 8px; flex: 1; min-width: 0; padding: 2px 4px; border: 0;
      background: transparent; color: var(--ink, #1f2933); font: inherit; text-align: left; cursor: pointer; }
    .hojas-abrir > .fa { margin-top: 3px; color: var(--muted, #7b8794); }
    .hojas-texto { display: flex; flex-direction: column; min-width: 0; }
    .hojas-nombre { overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .hojas-abrir:hover .hojas-nombre { text-decoration: underline; }
    .hojas-accion { display: inline-grid; place-items: center; flex: none; width: 30px; height: 30px; padding: 0; border: 0;
      border-radius: var(--radius-sm, 7px); background: transparent; color: var(--muted, #7b8794); text-decoration: none; cursor: pointer; }
    .hojas-accion:hover { color: var(--ink, #1f2933); background: var(--surface-2, #f5f7fa); }
    .hojas-borrar:hover:not(:disabled) { color: var(--danger, #c0392b); background: #fbeae7; }
    .hojas-visor { display: flex; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; }
    .hojas-visor iframe { width: 100%; height: 62vh; border: 1px solid var(--line, #e4e7eb); background: var(--surface-2, #f5f7fa); }
    .hojas-pestana { align-self: flex-end; color: var(--muted, #7b8794); font-size: 12px; text-decoration: none; }
    .hojas-pestana:hover { color: var(--ink, #1f2933); }
    @media (max-width: 760px) {
      .hojas-cuerpo.con-visor { display: flex; }
      .hojas-visor iframe { height: 55vh; }
    }
  `],
})
export class HojasIncidenciasComponent implements OnChanges, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly sanitizer = inject(DomSanitizer);

  @Input({ required: true }) proyectoId!: number;
  @Input() archivado = false;
  /** Con visor, la hoja elegida se ve al lado; sin él, «Ver» abre otra pestaña. */
  @Input() conVisor = true;
  /** La lista tras cada carga, subida o borrado (para el numero de la tarjeta). */
  @Output() cambio = new EventEmitter<HojaIncidencias[]>();

  hojas: HojaIncidencias[] = [];
  seleccionada: HojaIncidencias | null = null;
  urlVisor: SafeResourceUrl | null = null;
  cargando = false;
  subiendo = false;
  borrando = false;
  error = '';
  private carga?: Subscription;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['proyectoId'] && this.proyectoId) this.cargar();
  }

  ngOnDestroy(): void {
    this.carga?.unsubscribe();
  }

  cargar(): void {
    this.carga?.unsubscribe();
    this.cargando = true;
    this.error = '';
    this.carga = this.api.getHojasIncidencias(this.proyectoId).subscribe({
      next: hojas => this.poner(hojas, false),
      error: () => {
        this.cargando = false;
        this.error = 'No se han podido cargar las hojas.';
        this.cdr.markForCheck();
      },
    });
  }

  subir(event: Event): void {
    const input = event.target as HTMLInputElement;
    const archivos = Array.from(input.files ?? []);
    input.value = '';
    if (!archivos.length || this.subiendo) return;
    const noPdf = archivos.filter(a => !a.name.toLowerCase().endsWith('.pdf'));
    if (noPdf.length) {
      this.error = `Solo se pueden subir PDF: ${noPdf.map(a => a.name).join(', ')}.`;
      this.cdr.markForCheck();
      return;
    }
    this.subiendo = true;
    this.error = '';
    this.cdr.markForCheck();
    this.api.subirHojasIncidencias(this.proyectoId, archivos).subscribe({
      next: hojas => {
        this.subiendo = false;
        // Se ve la recien subida (la mas nueva va la primera).
        this.poner(hojas, true);
      },
      error: err => {
        this.subiendo = false;
        this.error = err?.error?.detail || 'No se han podido subir las hojas.';
        this.cdr.markForCheck();
      },
    });
  }

  ver(hoja: HojaIncidencias): void {
    if (!hoja.url) return;
    if (!this.conVisor) {
      window.open(hoja.url, '_blank', 'noopener');
      return;
    }
    this.elegir(hoja);
    this.cdr.markForCheck();
  }

  borrar(hoja: HojaIncidencias): void {
    if (this.borrando || !confirm(`¿Borrar «${hoja.nombre}»? No se puede deshacer.`)) return;
    this.borrando = true;
    this.error = '';
    this.api.borrarHojaIncidencias(this.proyectoId, hoja.id).subscribe({
      next: hojas => {
        this.borrando = false;
        this.poner(hojas, this.seleccionada?.id === hoja.id);
      },
      error: err => {
        this.borrando = false;
        this.error = err?.error?.detail || 'No se ha podido borrar la hoja.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Con espacio duro: la cifra y la unidad no se separan de linea. */
  tamano(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  private poner(hojas: HojaIncidencias[], elegirPrimera: boolean): void {
    this.hojas = hojas;
    this.cargando = false;
    const sigue = hojas.find(h => h.id === this.seleccionada?.id);
    this.elegir(elegirPrimera || !sigue ? hojas[0] ?? null : sigue);
    this.cambio.emit(hojas);
    this.cdr.markForCheck();
  }

  private elegir(hoja: HojaIncidencias | null): void {
    if (hoja?.id === this.seleccionada?.id && this.urlVisor) return;
    this.seleccionada = hoja;
    // Mismo origen: el PDF viaja con la cookie de /media/ y el servidor lo deja enmarcar.
    this.urlVisor = hoja?.url ? this.sanitizer.bypassSecurityTrustResourceUrl(hoja.url) : null;
  }
}
