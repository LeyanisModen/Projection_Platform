import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService, CheckDefinition } from '../../services/api.service';

/**
 * Lista de control maestra. Todos los proyectos la siguen: anadir, editar,
 * reordenar o borrar un paso aqui se refleja en cada proyecto (que ademas
 * puede tener pasos propios). Al borrar, los pasos completados o con
 * documentos se conservan en su proyecto.
 */
@Component({
    selector: 'app-lista-control',
    imports: [CommonModule, FormsModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <header class="page-heading">
            <div>
                <h1>Lista de control</h1>
                <p>Todos los proyectos siguen esta lista.</p>
            </div>
        </header>

        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }

        <section>
            <form class="add-row" (ngSubmit)="add()">
                <label for="new-step" class="sr-only">Nuevo paso</label>
                <input id="new-step" name="newStep" maxlength="200" [ngModel]="newTitle()" (ngModelChange)="newTitle.set($event)"
                    placeholder="Ej.: Aprobación de planos de equivalencia" [disabled]="busy()" />
                <div class="flag-toggles" role="group" aria-label="Qué necesita el paso">
                    <button type="button" class="flag-toggle" [class.on]="newRequiereFecha()" [attr.aria-pressed]="newRequiereFecha()"
                        (click)="toggleNewFecha()" [disabled]="busy()"
                        title="Con fecha límite" aria-label="Con fecha límite"><i class="fa fa-calendar" aria-hidden="true"></i></button>
                    @if (newRequiereFecha()) {
                        <input type="number" class="days-input" name="newDias" min="0" max="365" placeholder="días"
                            title="Días antes del montaje (vacío: fecha a mano)" aria-label="Días antes del montaje"
                            [ngModel]="newDias()" (ngModelChange)="newDias.set($event)" [disabled]="busy()" />
                    }
                    <button type="button" class="flag-toggle" [class.on]="newRequiereDocumento()" [attr.aria-pressed]="newRequiereDocumento()"
                        (click)="newRequiereDocumento.set(!newRequiereDocumento())" [disabled]="busy()"
                        title="Con documento de confirmación" aria-label="Con documento de confirmación"><i class="fa fa-file-text-o" aria-hidden="true"></i></button>
                    <button type="button" class="flag-toggle" [class.on]="newBloquea()" [attr.aria-pressed]="newBloquea()"
                        (click)="newBloquea.set(!newBloquea())" [disabled]="busy()"
                        title="Bloquea producción" aria-label="Bloquea producción"><i class="fa fa-lock" aria-hidden="true"></i></button>
                </div>
                <button type="submit" class="btn btn-primary" [disabled]="busy() || !newTitle().trim()">Añadir paso</button>
            </form>

            @if (loading()) { <p>Cargando lista...</p> }
            @else if (!steps().length) {
                <p class="empty">Todavía no hay pasos.</p>
            }

            <ol class="steps">
                @for (step of steps(); track step.id; let i = $index; let first = $first; let last = $last) {
                    <li class="step" [class.editing]="editingId() === step.id">
                        <span class="position">{{ i + 1 }}</span>
                        @if (editingId() === step.id) {
                            <div class="edit-block">
                                <input class="title-input" [attr.aria-label]="'Título del paso ' + (i + 1)" maxlength="200"
                                    [ngModel]="editTitle()" (ngModelChange)="editTitle.set($event)"
                                    (keydown.enter)="saveEdit(step)" (keydown.escape)="cancelEdit()" [disabled]="busy()" />
                            </div>
                            <div class="flag-toggles" role="group" aria-label="Qué necesita el paso">
                                <button type="button" class="flag-toggle" [class.on]="editRequiereFecha()" [attr.aria-pressed]="editRequiereFecha()"
                                    (click)="toggleEditFecha()" [disabled]="busy()"
                                    title="Con fecha límite" aria-label="Con fecha límite"><i class="fa fa-calendar" aria-hidden="true"></i></button>
                                @if (editRequiereFecha()) {
                                    <input type="number" class="days-input" min="0" max="365" placeholder="días"
                                        title="Días antes del montaje (vacío: fecha a mano)" aria-label="Días antes del montaje"
                                        [ngModel]="editDias()" (ngModelChange)="editDias.set($event)" [disabled]="busy()" />
                                }
                                <button type="button" class="flag-toggle" [class.on]="editRequiereDocumento()" [attr.aria-pressed]="editRequiereDocumento()"
                                    (click)="editRequiereDocumento.set(!editRequiereDocumento())" [disabled]="busy()"
                                    title="Con documento de confirmación" aria-label="Con documento de confirmación"><i class="fa fa-file-text-o" aria-hidden="true"></i></button>
                                <button type="button" class="flag-toggle" [class.on]="editBloquea()" [attr.aria-pressed]="editBloquea()"
                                    (click)="editBloquea.set(!editBloquea())" [disabled]="busy()"
                                    title="Bloquea producción" aria-label="Bloquea producción"><i class="fa fa-lock" aria-hidden="true"></i></button>
                            </div>
                            <div class="row-actions">
                                <button type="button" class="primary" [disabled]="busy() || !editTitle().trim()" (click)="saveEdit(step)">Guardar</button>
                                <button type="button" [disabled]="busy()" (click)="cancelEdit()">Cancelar</button>
                            </div>
                            @if (otherSteps(step).length) {
                                <div class="requisitos" role="group" aria-label="Requiere antes">
                                    <span class="requisitos-label"><i class="fa fa-link" aria-hidden="true"></i> Requiere</span>
                                    @for (other of otherSteps(step); track other.id) {
                                        <button type="button" class="req-chip" [class.on]="editRequisitos().includes(other.id)"
                                            [attr.aria-pressed]="editRequisitos().includes(other.id)" [disabled]="busy()"
                                            (click)="toggleRequisito(other.id)">{{ other.titulo }}</button>
                                    }
                                </div>
                            }
                        } @else {
                            <span class="title">{{ step.titulo }}
                                @if (step.requiere_fecha || step.requiere_documento || step.bloquea_produccion) {
                                    <span class="flag-icons">
                                        @if (step.requiere_fecha) {
                                            <i class="fa fa-calendar" [title]="deadlineTitle(step)" [attr.aria-label]="deadlineTitle(step)"></i>
                                            @if (step.dias_antes_montaje !== null) { <span class="days-badge">D−{{ step.dias_antes_montaje }}</span> }
                                        }
                                        @if (step.requiere_documento) { <i class="fa fa-file-text-o" title="Con documento de confirmación" aria-label="Con documento de confirmación"></i> }
                                        @if (step.bloquea_produccion) { <i class="fa fa-lock" title="Bloquea producción" aria-label="Bloquea producción"></i> }
                                    </span>
                                }
                                @if (step.requisitos.length) {
                                    <span class="requisitos-hint"><i class="fa fa-link" aria-hidden="true"></i> {{ requisitosLabel(step) }}</span>
                                }
                            </span>
                            <div class="row-actions">
                                <button type="button" [disabled]="busy() || first" (click)="move(i, -1)" title="Subir" aria-label="Subir"><i class="fa fa-arrow-up" aria-hidden="true"></i></button>
                                <button type="button" [disabled]="busy() || last" (click)="move(i, 1)" title="Bajar" aria-label="Bajar"><i class="fa fa-arrow-down" aria-hidden="true"></i></button>
                                <button type="button" [disabled]="busy()" (click)="startEdit(step)" title="Editar" aria-label="Editar"><i class="fa fa-pencil" aria-hidden="true"></i></button>
                                <button type="button" class="danger" [disabled]="busy()" (click)="remove(step)" title="Eliminar" aria-label="Eliminar"><i class="fa fa-trash-o" aria-hidden="true"></i></button>
                            </div>
                        }
                    </li>
                }
            </ol>
        </section>
    `,
    styleUrls: ['../admin-theme.css'],
    styles: `
        :host{max-width:900px;margin:0 auto}
        *{box-sizing:border-box}
        .page-heading{margin-bottom:20px}
        .page-heading h1{margin:0;color:var(--ink);font-size:24px;font-weight:600;letter-spacing:-0.01em}
        .page-heading p{margin:2px 0 0;color:var(--muted);font-size:13px}
        .error{color:var(--danger)}.empty{margin:14px 0 4px;color:var(--muted)}
        .add-row{display:flex;gap:8px;align-items:stretch}
        .add-row>input{flex:1 1 auto;height:var(--control-h);padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);font:inherit;color:var(--ink)}
        .add-row>input::placeholder,.title-input::placeholder{color:var(--muted)}
        .add-row>input:focus,.title-input:focus,.days-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
        .edit-block{flex:1 1 auto;min-width:0;display:flex}
        .title-input{flex:1 1 auto;height:36px;padding:0 10px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);font:inherit;color:var(--ink)}
        .flag-toggles{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto}
        .flag-toggle{display:inline-grid;place-items:center;width:38px;min-width:38px;height:var(--control-h);padding:0;color:var(--muted);background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-sm);font-size:14px;cursor:pointer;transition:color .12s,background-color .12s,border-color .12s}
        .flag-toggle:hover:not(:disabled){color:var(--ink);background:var(--surface-2)}
        .flag-toggle.on{color:var(--ink);background:var(--surface-2);border-color:var(--ink)}
        .flag-toggle:disabled{opacity:.5;cursor:default}
        .step .flag-toggle{height:36px;width:34px;min-width:34px}
        .flag-icons{display:inline-flex;align-items:center;gap:8px;margin-left:10px;color:var(--muted);font-size:13px;vertical-align:middle}
        .days-input{width:64px;min-width:64px;height:var(--control-h);padding:0 8px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);font:inherit;text-align:right;color:var(--ink)}
        .step .days-input{height:36px}
        .days-badge{font-size:11px;font-weight:600;color:var(--text);background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:1px 7px}
        .requisitos-hint{display:block;margin-top:3px;color:var(--muted);font-size:12px}
        .requisitos{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-left:40px}
        .requisitos-label{color:var(--muted);font-size:12px;margin-right:2px}
        .req-chip{padding:4px 10px;font:inherit;font-size:12px;color:var(--muted);background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;cursor:pointer}
        .req-chip.on{color:var(--ink);background:var(--surface-2);border-color:var(--ink)}
        .steps{list-style:none;margin:20px 0 0;padding:0;border-top:1px solid var(--line-strong)}
        .step{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 8px;border-bottom:1px solid var(--line)}
        .position{flex:0 0 28px;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;text-align:right}
        .title{flex:1 1 auto;min-width:0;color:var(--ink);font-size:15px;font-weight:600;overflow-wrap:anywhere}
        .row-actions{display:flex;gap:4px}
        .row-actions button{display:inline-grid;place-items:center;min-width:32px;height:32px;padding:0 8px;color:var(--muted);background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s,color .12s}
        .row-actions button:hover:not(:disabled){background:var(--surface-2);color:var(--ink)}
        .row-actions button.danger:hover:not(:disabled){background:#fbeae7;color:var(--danger)}
        .row-actions button:disabled{opacity:.4;cursor:default}
        .row-actions .primary{color:var(--ink);border-color:var(--line-strong)}
        .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
        @media(max-width:600px){.row-actions{flex-basis:100%;justify-content:flex-end}.requisitos{padding-left:0}input{font-size:16px}}
    `,
})
export class ListaControlComponent {
    private readonly api = inject(ApiService);
    private readonly destroyRef = inject(DestroyRef);
    readonly steps = signal<CheckDefinition[]>([]);
    readonly loading = signal(true);
    readonly busy = signal(false);
    readonly error = signal('');
    readonly newTitle = signal('');
    readonly newRequiereFecha = signal(false);
    readonly newRequiereDocumento = signal(false);
    readonly newDias = signal<number | null>(null);
    readonly newBloquea = signal(false);
    readonly editingId = signal<number | null>(null);
    readonly editTitle = signal('');
    readonly editRequiereFecha = signal(false);
    readonly editRequiereDocumento = signal(false);
    readonly editDias = signal<number | null>(null);
    readonly editBloquea = signal(false);
    readonly editRequisitos = signal<number[]>([]);

    constructor() {
        this.load();
    }

    private load(): void {
        this.loading.set(true);
        this.api.getCheckDefinitions().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: rows => { this.steps.set(rows); this.loading.set(false); },
            error: () => { this.error.set('No se pudo cargar la lista de control.'); this.loading.set(false); },
        });
    }

    private run<T>(request: Observable<T>, onOk: (v: T) => void, message: string): void {
        if (this.busy()) return;
        this.busy.set(true); this.error.set('');
        request.subscribe({
            next: value => { onOk(value); this.busy.set(false); },
            error: () => { this.error.set(message); this.busy.set(false); },
        });
    }

    /** Días como número o null; el input de tipo number devuelve '' al vaciarlo. */
    private static days(value: number | string | null): number | null {
        if (value === null || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    }

    toggleNewFecha(): void {
        this.newRequiereFecha.set(!this.newRequiereFecha());
        if (!this.newRequiereFecha()) this.newDias.set(null);
    }

    toggleEditFecha(): void {
        this.editRequiereFecha.set(!this.editRequiereFecha());
        if (!this.editRequiereFecha()) this.editDias.set(null);
    }

    toggleRequisito(id: number): void {
        this.editRequisitos.update(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
    }

    otherSteps(step: CheckDefinition): CheckDefinition[] {
        return this.steps().filter(s => s.id !== step.id);
    }

    requisitosLabel(step: CheckDefinition): string {
        const byId = new Map(this.steps().map(s => [s.id, s.titulo]));
        return step.requisitos.map(id => byId.get(id)).filter(Boolean).join(', ');
    }

    deadlineTitle(step: CheckDefinition): string {
        return step.dias_antes_montaje === null
            ? 'Con fecha límite'
            : `Fecha límite: ${step.dias_antes_montaje} días antes del montaje`;
    }

    add(): void {
        const titulo = this.newTitle().trim();
        if (!titulo) return;
        this.run(this.api.saveCheckDefinition({
            titulo, requiere_fecha: this.newRequiereFecha(), requiere_documento: this.newRequiereDocumento(),
            dias_antes_montaje: this.newRequiereFecha() ? ListaControlComponent.days(this.newDias()) : null,
            bloquea_produccion: this.newBloquea(),
        }), row => {
            this.steps.update(rows => [...rows, row]);
            this.newTitle.set(''); this.newRequiereFecha.set(false); this.newRequiereDocumento.set(false);
            this.newDias.set(null); this.newBloquea.set(false);
        }, 'No se pudo añadir el paso.');
    }

    startEdit(step: CheckDefinition): void {
        this.editingId.set(step.id);
        this.editTitle.set(step.titulo);
        this.editRequiereFecha.set(step.requiere_fecha);
        this.editRequiereDocumento.set(step.requiere_documento);
        this.editDias.set(step.dias_antes_montaje);
        this.editBloquea.set(step.bloquea_produccion);
        this.editRequisitos.set([...step.requisitos]);
    }

    cancelEdit(): void {
        this.editingId.set(null);
        this.editTitle.set('');
    }

    saveEdit(step: CheckDefinition): void {
        const titulo = this.editTitle().trim();
        if (!titulo) return;
        const dias = this.editRequiereFecha() ? ListaControlComponent.days(this.editDias()) : null;
        const requisitos = [...this.editRequisitos()].sort((a, b) => a - b);
        const unchanged = titulo === step.titulo
            && this.editRequiereFecha() === step.requiere_fecha
            && this.editRequiereDocumento() === step.requiere_documento
            && dias === step.dias_antes_montaje
            && this.editBloquea() === step.bloquea_produccion
            && requisitos.join(',') === [...step.requisitos].sort((a, b) => a - b).join(',');
        if (unchanged) { this.cancelEdit(); return; }
        this.run(this.api.saveCheckDefinition({
            id: step.id, titulo,
            requiere_fecha: this.editRequiereFecha(), requiere_documento: this.editRequiereDocumento(),
            dias_antes_montaje: dias, bloquea_produccion: this.editBloquea(), requisitos,
        }), row => {
            this.steps.update(rows => rows.map(r => r.id === row.id ? row : r));
            this.cancelEdit();
        }, 'No se pudo guardar el paso.');
    }

    remove(step: CheckDefinition): void {
        if (!confirm(`Eliminar «${step.titulo}» de la lista de control?\n\nDesaparece de todos los proyectos donde siga pendiente. Donde esté completado o tenga documentos se conserva como paso propio del proyecto.`)) return;
        this.run(this.api.deleteCheckDefinition(step.id), () => {
            this.steps.update(rows => rows.filter(r => r.id !== step.id));
        }, 'No se pudo eliminar el paso.');
    }

    move(index: number, delta: number): void {
        const rows = [...this.steps()];
        const target = index + delta;
        if (target < 0 || target >= rows.length) return;
        [rows[index], rows[target]] = [rows[target], rows[index]];
        this.run(this.api.reorderCheckDefinitions(rows.map(r => r.id)), ordered => {
            this.steps.set(ordered);
        }, 'No se pudo reordenar la lista.');
    }
}
