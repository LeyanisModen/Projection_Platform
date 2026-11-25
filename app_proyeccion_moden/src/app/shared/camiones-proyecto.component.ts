import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, Camion, CamionesProyecto } from '../services/api.service';

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const BASTIDORES_POR_CAMION = 4;

/** "vie 27/11" */
export function diaCorto(iso: string | null): string {
  if (!iso) return '';
  const [anio, mes, dia] = iso.split('-').map(Number);
  const fecha = new Date(anio, mes - 1, dia);
  return `${DIAS[fecha.getDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

function iso(fecha: Date): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
}

/** El dia de lunes a viernes anterior a ``dia``. */
export function laborableAntes(dia: string): string {
  const [anio, mes, d] = dia.split('-').map(Number);
  const fecha = new Date(anio, mes - 1, d - 1);
  while (fecha.getDay() === 0 || fecha.getDay() === 6) fecha.setDate(fecha.getDate() - 1);
  return iso(fecha);
}

/** "Salen del mié 25/11 al vie 27/11, como mucho 4 al día". */
export function textoEnvio(datos: CamionesProyecto): string | null {
  const envio = datos.envio;
  if (!envio?.desde || !envio.hasta) return null;
  const cuando = envio.desde === envio.hasta
    ? `Salen el ${diaCorto(envio.desde)}`
    : `Salen del ${diaCorto(envio.desde)} al ${diaCorto(envio.hasta)}`;
  if (datos.camiones.some(c => c.fecha_fija && !c.enviado)) return `${cuando}, a mano`;
  // Lo elegido nunca baja de los dias que hacen falta.
  return envio.dias_elegidos
    ? `${cuando}; el reparto, en ${Math.max(envio.dias_elegidos, envio.dias_minimos)} días elegidos en Planificación`
    : `${cuando}, como mucho ${datos.camiones_por_dia} al día`;
}

/** Un dia en que salen camiones del forjado. */
export interface DiaCamiones {
  fecha: string | null;
  camiones: number;
  enviado: boolean;
  /** Puesto a mano o ya enviado: no sigue el reparto. */
  fija: boolean;
}

/** Los camiones, juntos por dia (y enviados aparte), de antes a despues. */
export function diasDe(camiones: Camion[]): DiaCamiones[] {
  const ordenados = [...camiones].sort((a, b) => (a.fecha ?? '').localeCompare(b.fecha ?? '') || (a.orden ?? 0) - (b.orden ?? 0));
  const dias: DiaCamiones[] = [];
  for (const camion of ordenados) {
    const ultimo = dias[dias.length - 1];
    if (ultimo && ultimo.fecha === camion.fecha && ultimo.enviado === camion.enviado) {
      ultimo.camiones++;
      ultimo.fija = ultimo.fija || !!camion.fecha_fija;
    } else {
      dias.push({ fecha: camion.fecha, camiones: 1, enviado: camion.enviado, fija: !!camion.fecha_fija || camion.enviado });
    }
  }
  return dias;
}

/** Camiones que hacen falta para ``bastidores`` si el primero lleva ``primero``. */
export function camionesPara(bastidores: number, primero: number): number {
  if (bastidores <= 0) return 0;
  if (bastidores <= primero) return 1;
  return 1 + Math.ceil((bastidores - primero) / BASTIDORES_POR_CAMION);
}

/** Lo que lleva cada camion, en orden: el primero ``primero``, los demas 4 y el ultimo lo que quede. */
export function cargas(bastidores: number, primero: number): number[] {
  const lista: number[] = [];
  let quedan = bastidores;
  while (quedan > 0) {
    const lleva = Math.min(lista.length ? BASTIDORES_POR_CAMION : primero, quedan);
    lista.push(lleva);
    quedan -= lleva;
  }
  return lista;
}

/**
 * Deja ``total`` camiones entre los dias sin tocar el de ``fija`` (ni los
 * enviados): si sobran, se quitan de los dias mas tempranos (lo demas sale lo
 * mas tarde posible); si faltan, van en un dia nuevo, al final de la lista,
 * el laborable antes del primero (o sin dia, si ese ya ha pasado).
 */
export function ajustar(dias: DiaCamiones[], total: number, fija: number | null, hoy: string): DiaCamiones[] {
  const nuevos = dias.map(d => ({ ...d }));
  let sobran = nuevos.reduce((suma, d) => suma + d.camiones, 0) - total;
  const tempranos = nuevos.map((_d, i) => i)
    .filter(i => i !== fija && !nuevos[i].enviado)
    .sort((a, b) => (nuevos[a].fecha ?? '').localeCompare(nuevos[b].fecha ?? ''));
  for (const i of tempranos) {
    if (sobran <= 0) break;
    const quita = Math.min(nuevos[i].camiones, sobran);
    nuevos[i].camiones -= quita;
    sobran -= quita;
  }
  if (sobran > 0 && fija !== null) nuevos[fija].camiones = Math.max(1, nuevos[fija].camiones - sobran);
  const quedan = nuevos.filter((d, i) => d.camiones > 0 || i === fija);
  if (sobran < 0) {
    const fechas = quedan.filter(d => !d.enviado && d.fecha).map(d => d.fecha!).sort();
    const antes = fechas.length ? laborableAntes(fechas[0]) : null;
    quedan.push({ fecha: antes && antes >= hoy ? antes : null, camiones: -sobran, enviado: false, fija: true });
  }
  return quedan;
}

/**
 * Camiones de un forjado por dias: cada fila es un dia con los camiones que
 * salen (4 bastidores cada uno, salvo el ultimo o un primero que comparte con
 * la planta de antes). Por defecto, los dias justos antes del montaje con los
 * camiones al dia de la ferralla; aqui se cambia cuantos salen cada dia (la
 * diferencia va a otro dia) y que dia, nunca despues del montaje. Lo usa la
 * ficha del proyecto en el admin.
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
        · {{ total }} {{ total === 1 ? 'camión' : 'camiones' }}@if (ultimo; as lleva) {&ngsp;<span class="cam-meta">· el último lleva {{ lleva }}</span>}
      </p>
      @if (envio; as texto) { <p class="cam-meta cam-envio">{{ texto }}</p> }
      @if (dias.length) {
      <div class="cam-dia cam-cabecera" aria-hidden="true"><span>Día</span><span>Camiones</span><span></span></div>
      <ul class="cam-lista">
        @for (dia of dias; track $index; let i = $index) {
          <li class="cam-dia" [class.cam-defecto]="!dia.fija && !cambiado">
            <input type="date" class="field" [attr.max]="dia.enviado ? null : (datos.montaje ?? null)" [ngModel]="dia.fecha"
              (ngModelChange)="cambiarFecha(i, $event)" [disabled]="guardando || archivado" [attr.aria-label]="'Día ' + (i + 1)">
            <select class="field" [ngModel]="dia.camiones" (ngModelChange)="cambiarCamiones(i, +$event)"
              [disabled]="guardando || archivado || dia.enviado" [attr.aria-label]="'Camiones del día ' + (i + 1)">
              @for (n of opcionesDe(i); track n) { <option [ngValue]="n">{{ n }}</option> }
            </select>
            <label class="cam-enviado">
              <input type="checkbox" [ngModel]="dia.enviado" (ngModelChange)="cambiarEnviado(i, $event)" [disabled]="guardando || archivado">
              Enviado
            </label>
          </li>
        }
      </ul>
      @if (datos.bastidores > 4) {
      <label class="cam-primero">El primero lleva
        <select class="field" [ngModel]="primero" (ngModelChange)="cambiarPrimero(+$event)" [disabled]="guardando || archivado"
          aria-label="Bastidores del primer camión">
          @for (n of [1, 2, 3, 4]; track n) { <option [ngValue]="n">{{ n }}</option> }
        </select>
        bastidores
      </label>
      }
      } @else {
        <p class="cam-meta">Sin camiones: el forjado no tiene bastidores.</p>
      }
      @for (texto of avisos(); track texto) { <p class="cam-aviso" role="note">{{ texto }}</p> }
      @if (error) { <p class="cam-error" role="alert">{{ error }}</p> }
      @if (!archivado) {
      <div class="cam-acciones">
        @if (!datos.por_defecto || cambiado) {
          <button type="button" class="btn btn-sm" (click)="porDefecto()" [disabled]="guardando"
            title="Los días justos antes del montaje; lo enviado se queda">Por defecto</button>
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
  // Botones y campos del tema del admin.
  styleUrls: ['../admin/admin-theme.css'],
  styles: [`
    :host { display: flex; flex-direction: column; gap: 8px; }
    .cam-resumen, .cam-meta, .cam-aviso, .cam-error { margin: 0; font-size: 13px; }
    .cam-meta { color: var(--muted, #7b8794); }
    .cam-aviso { color: var(--warn, #b7791f); }
    .cam-error { color: var(--danger, #c0392b); }
    .cam-lista { list-style: none; margin: 0; padding: 0; }
    /* Una linea por dia: fecha, camiones y enviado (cabe en la columna lateral). */
    .cam-dia { display: grid; grid-template-columns: minmax(0, 1fr) 66px auto; align-items: center; gap: 6px; }
    .cam-lista li { padding: 5px 0; border-top: 1px solid var(--line, #e4e7eb); }
    .cam-lista li:first-child { border-top: 0; }
    .cam-cabecera { color: var(--muted, #7b8794); font-size: 12px; }
    .cam-lista .field, .cam-primero .field { min-width: 0; height: 30px; box-sizing: border-box; font-size: 13px; }
    .cam-lista .field { width: 100%; }
    .cam-lista select.field, .cam-primero select.field { padding: 0 4px; }
    .cam-lista li.cam-defecto .field { color: var(--muted, #7b8794); }
    .cam-enviado { display: inline-flex; align-items: center; gap: 4px; margin: 0; color: var(--text, #3e4c59); font-size: 12px; white-space: nowrap; }
    .cam-primero { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--text, #3e4c59); font-size: 13px; font-weight: 400; }
    .cam-primero .field { width: 52px; }
    .cam-acciones { display: flex; flex-wrap: wrap; gap: 6px; }
  `],
})
export class CamionesProyectoComponent implements OnChanges {
  private readonly api = inject(ApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) proyectoId!: number;
  @Input() archivado = false;
  @Output() cambio = new EventEmitter<CamionesProyecto>();

  datos: CamionesProyecto | null = null;
  dias: DiaCamiones[] = [];
  /** Bastidores del primer camion (menos de 4 si comparte con la planta de antes). */
  primero = BASTIDORES_POR_CAMION;
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

  get total(): number {
    return this.datos ? camionesPara(this.datos.bastidores, this.primero) : 0;
  }

  /** Lo que lleva el ultimo si no va lleno. */
  get ultimo(): number | null {
    const lista = this.datos ? cargas(this.datos.bastidores, this.primero) : [];
    const lleva = lista.length > 1 ? lista[lista.length - 1] : null;
    return lleva !== null && lleva < BASTIDORES_POR_CAMION ? lleva : null;
  }

  get envio(): string | null {
    return this.datos && !this.cambiado ? textoEnvio(this.datos) : null;
  }

  private get hoy(): string {
    return iso(new Date());
  }

  /** De 1 a lo que no esta ya enviado otro dia. */
  opcionesDe(indice: number): number[] {
    const enviados = this.dias.reduce((suma, d, i) => suma + (i !== indice && d.enviado ? d.camiones : 0), 0);
    const hasta = Math.max(this.dias[indice]?.camiones ?? 1, this.total - enviados);
    return Array.from({ length: hasta }, (_v, i) => i + 1);
  }

  /** Dias con mas camiones de los que saca la ferralla o despues del montaje. */
  avisos(): string[] {
    if (!this.datos) return [];
    const avisos: string[] = [];
    const porDia = this.datos.camiones_por_dia;
    for (const dia of this.dias) {
      if (dia.fecha && !dia.enviado && dia.camiones > porDia) {
        avisos.push(`El ${diaCorto(dia.fecha)} salen ${dia.camiones}: la ferralla saca ${porDia} al día.`);
      }
    }
    const montaje = this.datos.montaje;
    if (montaje && this.dias.some(d => d.fecha && !d.enviado && d.fecha > montaje)) {
      avisos.push(`El montaje es el ${diaCorto(montaje)}: ningún camión puede salir después.`);
    }
    return avisos;
  }

  cambiarCamiones(indice: number, cuantos: number): void {
    this.dias[indice] = { ...this.dias[indice], camiones: cuantos, fija: true };
    this.dias = ajustar(this.dias, this.total, indice, this.hoy);
    this.tocado();
  }

  cambiarFecha(indice: number, fecha: string): void {
    this.dias[indice] = { ...this.dias[indice], fecha: fecha || null, fija: true };
    this.dias = [...this.dias];
    this.tocado();
  }

  cambiarEnviado(indice: number, enviado: boolean): void {
    this.dias[indice] = { ...this.dias[indice], enviado, fija: true };
    this.dias = [...this.dias];
    this.tocado();
  }

  cambiarPrimero(bastidores: number): void {
    this.primero = bastidores;
    this.dias = ajustar(this.dias, this.total, null, this.hoy);
    this.tocado();
  }

  guardar(): void {
    if (this.guardando || !this.datos) return;
    if (!this.dias.length) {
      this.porDefecto();
      return;
    }
    if (this.dias.some(d => !d.fecha)) {
      this.error = 'Cada día necesita su fecha.';
      this.cdr.markForCheck();
      return;
    }
    const montaje = this.datos.montaje;
    if (montaje && this.dias.some(d => !d.enviado && d.fecha! > montaje)) {
      this.error = `Ningún camión puede salir después del montaje (${diaCorto(montaje)}).`;
      this.cdr.markForCheck();
      return;
    }
    // En orden de salida: el primero lleva los primeros bastidores. Al tocar algo, todos a mano.
    const lleva = cargas(this.datos.bastidores, this.primero);
    const camiones: Camion[] = [];
    for (const dia of [...this.dias].sort((a, b) => a.fecha!.localeCompare(b.fecha!))) {
      for (let n = 0; n < dia.camiones && camiones.length < lleva.length; n++) {
        camiones.push({ fecha: dia.fecha, fecha_fija: true, bastidores: lleva[camiones.length], enviado: dia.enviado });
      }
    }
    this.guardando = true;
    this.api.guardarCamiones(this.proyectoId, camiones).subscribe({
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

  private tocado(): void {
    this.cambiado = true;
    this.error = '';
    this.cdr.markForCheck();
  }

  private poner(datos: CamionesProyecto): void {
    this.datos = datos;
    const porOrden = [...datos.camiones].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
    this.primero = porOrden.length > 1 ? porOrden[0].bastidores : BASTIDORES_POR_CAMION;
    this.dias = diasDe(datos.camiones);
    this.cambiado = false;
    // Guardados con otra carga (el forjado cambio de bastidores): se rehacen y hay que guardar.
    const tienen = this.dias.reduce((suma, d) => suma + d.camiones, 0);
    if (tienen !== this.total) {
      this.dias = ajustar(this.dias, this.total, null, this.hoy);
      this.cambiado = true;
    }
    this.cargando = false;
    this.guardando = false;
    this.error = '';
    this.cambio.emit(datos);
    this.cdr.markForCheck();
  }
}
