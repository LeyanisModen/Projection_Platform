import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CaptureDay, HorarioDia, TurnoConfig } from '../services/api.service';
import { DIAS, cruzaMedianoche, nuevoTurno, ordenarHorario } from './turnos';

/**
 * Turnos de una ferralla, cada uno con su jornada por dia. Cambia la lista
 * que recibe y avisa con (cambio). Lo usan la ficha de la ferralla (Moden)
 * y las estadisticas del cliente.
 */
@Component({
  selector: 'app-turnos-editor',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (turno of turnos; track $index; let i = $index) {
      <section class="turno" [class.is-off]="!turno.activo" [attr.aria-label]="'Turno ' + turno.nombre">
        <div class="turno-cabecera">
          <input type="text" class="turno-nombre" maxlength="40" [attr.aria-label]="'Nombre del turno ' + (i + 1)"
            [ngModel]="turno.nombre" (ngModelChange)="turno.nombre = $event; cambio.emit()"
            [ngModelOptions]="{ standalone: true }" [disabled]="disabled">
          <label class="turno-activo" title="Un turno a demanda se apaga sin borrarlo">
            <input type="checkbox" [ngModel]="turno.activo" (ngModelChange)="turno.activo = $event; cambio.emit()"
              [ngModelOptions]="{ standalone: true }" [disabled]="disabled">
            Activo
          </label>
          @if (turnos.length > 1) {
            <button type="button" class="turno-quitar" (click)="quitar(i)" [disabled]="disabled"
              [attr.aria-label]="'Quitar el turno ' + turno.nombre" title="Quitar turno">
              <i class="fa fa-trash" aria-hidden="true"></i>
            </button>
          }
        </div>
        <div class="turno-dias" role="group" [attr.aria-label]="'Jornada del turno ' + turno.nombre">
          @for (dia of dias; track dia.code) {
            @let tramo = tramoDe(turno, dia.code);
            <div class="turno-dia" [class.is-off]="!tramo">
              <button type="button" class="turno-dia-toggle" [class.active]="!!tramo" [disabled]="disabled"
                (click)="toggleDia(turno, dia.code)" [attr.aria-pressed]="!!tramo"
                [attr.aria-label]="turno.nombre + ': trabajar el ' + dia.nombre">{{ dia.label }}</button>
              <input type="time" [attr.aria-label]="turno.nombre + ', inicio del ' + dia.nombre"
                [ngModel]="tramo?.start_time" (ngModelChange)="setHora(turno, dia.code, 'start_time', $event)"
                [ngModelOptions]="{ standalone: true }" [disabled]="disabled || !tramo">
              <span class="turno-dia-sep">a</span>
              <input type="time" [attr.aria-label]="turno.nombre + ', fin del ' + dia.nombre"
                [ngModel]="tramo?.end_time" (ngModelChange)="setHora(turno, dia.code, 'end_time', $event)"
                [ngModelOptions]="{ standalone: true }" [disabled]="disabled || !tramo">
              @if (tramo && cruza(tramo)) { <small class="turno-siguiente" title="Acaba al día siguiente">+1</small> }
              @if (tramo && turno.horario.length > 1) {
                <button type="button" class="turno-copiar" (click)="copiarA(turno, dia.code)" [disabled]="disabled"
                  title="Poner esta jornada en los demás días del turno"
                  [attr.aria-label]="turno.nombre + ': copiar la jornada del ' + dia.nombre + ' a los demás días'">
                  <i class="fa fa-clone" aria-hidden="true"></i>
                </button>
              }
            </div>
          }
        </div>
      </section>
    }
    <button type="button" class="turno-anadir" (click)="anadir()" [disabled]="disabled">
      <i class="fa fa-plus" aria-hidden="true"></i> Añadir turno
    </button>
  `,
  styles: [`
    :host { display: grid; gap: 10px; width: 100%; }
    .turno { display: grid; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--line, #e5e7eb); }
    .turno.is-off .turno-dias { opacity: 0.45; }
    .turno-cabecera { display: flex; align-items: center; gap: 10px; }
    .turno-nombre { width: 160px; height: 30px; padding: 0 8px; border: 1px solid var(--line-strong, #d1d5db); border-radius: var(--radius-sm, 6px); background: var(--surface, #fff); color: var(--ink, #111827); font: inherit; font-size: 13px; font-weight: 600; }
    .turno-activo { display: inline-flex; align-items: center; gap: 6px; margin: 0; color: var(--muted, #6b7280); font-size: 12px; cursor: pointer; }
    .turno-quitar { width: 30px; height: 30px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-sm, 6px); background: transparent; color: var(--muted, #6b7280); cursor: pointer; }
    .turno-quitar:hover:not(:disabled) { color: var(--danger, #b91c1c); background: var(--surface-2, #f3f4f6); }
    .turno-dias { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 4px 14px; }
    .turno-dia { display: flex; align-items: center; gap: 6px; }
    .turno-dia.is-off input, .turno-dia.is-off .turno-dia-sep { opacity: 0.35; }
    .turno-dia input { width: 96px; height: 30px; padding: 0 6px; border: 1px solid var(--line-strong, #d1d5db); border-radius: var(--radius-sm, 6px); background: var(--surface, #fff); color: var(--ink, #111827); font: inherit; font-size: 13px; }
    .turno-dia-sep { color: var(--muted, #6b7280); font-size: 12px; }
    .turno-dia-toggle { width: 28px; height: 28px; padding: 0; border: 1px solid var(--line-strong, #d1d5db); border-radius: var(--radius-sm, 6px); background: var(--surface, #fff); color: var(--muted, #6b7280); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .turno-dia-toggle:hover:not(:disabled) { color: var(--ink, #111827); background: var(--surface-2, #f3f4f6); }
    .turno-dia-toggle.active { color: #fff; background: var(--ink, #111827); border-color: var(--ink, #111827); }
    .turno-copiar { width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--radius-sm, 6px); background: transparent; color: var(--muted, #6b7280); cursor: pointer; }
    .turno-copiar:hover:not(:disabled) { color: var(--ink, #111827); background: var(--surface-2, #f3f4f6); }
    .turno-siguiente { color: var(--muted, #6b7280); font-size: 11px; font-weight: 600; }
    .turno-anadir { justify-self: start; height: 30px; padding: 0 10px; border: 1px solid var(--line-strong, #d1d5db); border-radius: var(--radius-sm, 6px); background: var(--surface, #fff); color: var(--ink, #111827); font: inherit; font-size: 12px; cursor: pointer; }
    .turno-anadir:hover:not(:disabled) { background: var(--surface-2, #f3f4f6); }
    button:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class TurnosEditorComponent {
  @Input({ required: true }) turnos!: TurnoConfig[];
  @Input() disabled = false;
  @Output() readonly cambio = new EventEmitter<void>();
  readonly dias = DIAS;

  tramoDe(turno: TurnoConfig, day: CaptureDay): HorarioDia | undefined {
    return turno.horario.find(dia => dia.day === day);
  }

  cruza(tramo: HorarioDia): boolean {
    return cruzaMedianoche(tramo);
  }

  setHora(turno: TurnoConfig, day: CaptureDay, campo: 'start_time' | 'end_time', valor: string): void {
    const tramo = this.tramoDe(turno, day);
    if (!tramo) return;
    tramo[campo] = valor;
    this.cambio.emit();
  }

  toggleDia(turno: TurnoConfig, day: CaptureDay): void {
    if (this.tramoDe(turno, day)) {
      turno.horario = turno.horario.filter(dia => dia.day !== day);
    } else {
      // Un dia nuevo hereda la jornada del primero del turno.
      const referencia = turno.horario[0] || { start_time: '06:00', end_time: '14:00' };
      turno.horario = ordenarHorario([...turno.horario, { day, start_time: referencia.start_time, end_time: referencia.end_time }]);
    }
    this.cambio.emit();
  }

  /** Copia la jornada de un dia a los demas dias del turno. */
  copiarA(turno: TurnoConfig, day: CaptureDay): void {
    const origen = this.tramoDe(turno, day);
    if (!origen) return;
    turno.horario.forEach(dia => {
      dia.start_time = origen.start_time;
      dia.end_time = origen.end_time;
    });
    this.cambio.emit();
  }

  anadir(): void {
    this.turnos.push(nuevoTurno(this.turnos));
    this.cambio.emit();
  }

  quitar(indice: number): void {
    if (this.turnos.length <= 1) return;
    this.turnos.splice(indice, 1);
    this.cambio.emit();
  }
}
