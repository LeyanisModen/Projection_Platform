import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService, CheckDefinition } from '../../services/api.service';

/**
 * Lista de control maestra. Es la plantilla que se copia a cada proyecto al
 * crearlo; cambiarla o borrar pasos aqui no toca los proyectos ya sembrados
 * (cada proyecto es dueno de su copia y puede anadir pasos propios).
 */
@Component({
    selector: 'app-lista-control',
    imports: [CommonModule, FormsModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <header class="page-heading">
            <div>
                <h1>Lista de control</h1>
                <p>Pasos que recibe cada proyecto nuevo.</p>
            </div>
        </header>

        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }

        <section class="card">
            <form class="add-row" (ngSubmit)="add()">
                <label for="new-step" class="sr-only">Nuevo paso</label>
                <input id="new-step" name="newStep" maxlength="200" [ngModel]="newTitle()" (ngModelChange)="newTitle.set($event)"
                    placeholder="Ej.: Aprobación de planos de equivalencia" [disabled]="busy()" />
                <div class="flag-toggles" role="group" aria-label="Qué necesita el paso">
                    <button type="button" class="flag-toggle" [class.on]="newRequiereFecha()" [attr.aria-pressed]="newRequiereFecha()"
                        (click)="newRequiereFecha.set(!newRequiereFecha())" [disabled]="busy()"
                        title="Con fecha límite" aria-label="Con fecha límite"><i class="fa fa-calendar" aria-hidden="true"></i></button>
                    <button type="button" class="flag-toggle" [class.on]="newRequiereDocumento()" [attr.aria-pressed]="newRequiereDocumento()"
                        (click)="newRequiereDocumento.set(!newRequiereDocumento())" [disabled]="busy()"
                        title="Con documento de confirmación" aria-label="Con documento de confirmación"><i class="fa fa-file-text-o" aria-hidden="true"></i></button>
                </div>
                <button type="submit" class="primary" [disabled]="busy() || !newTitle().trim()">Añadir paso</button>
            </form>

            @if (loading()) { <p>Cargando lista...</p> }
            @else if (!steps().length) {
                <p class="empty">Todavía no hay pasos. Los proyectos nuevos se crearán con la lista vacía.</p>
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
                                    (click)="editRequiereFecha.set(!editRequiereFecha())" [disabled]="busy()"
                                    title="Con fecha límite" aria-label="Con fecha límite"><i class="fa fa-calendar" aria-hidden="true"></i></button>
                                <button type="button" class="flag-toggle" [class.on]="editRequiereDocumento()" [attr.aria-pressed]="editRequiereDocumento()"
                                    (click)="editRequiereDocumento.set(!editRequiereDocumento())" [disabled]="busy()"
                                    title="Con documento de confirmación" aria-label="Con documento de confirmación"><i class="fa fa-file-text-o" aria-hidden="true"></i></button>
                            </div>
                            <div class="row-actions">
                                <button type="button" [disabled]="busy() || !editTitle().trim()" (click)="saveEdit(step)">Guardar</button>
                                <button type="button" [disabled]="busy()" (click)="cancelEdit()">Cancelar</button>
                            </div>
                        } @else {
                            <span class="title">{{ step.titulo }}
                                @if (step.requiere_fecha || step.requiere_documento) {
                                    <span class="flag-icons">
                                        @if (step.requiere_fecha) { <i class="fa fa-calendar" title="Con fecha límite" aria-label="Con fecha límite"></i> }
                                        @if (step.requiere_documento) { <i class="fa fa-file-text-o" title="Con documento de confirmación" aria-label="Con documento de confirmación"></i> }
                                    </span>
                                }
                            </span>
                            <div class="row-actions">
                                <button type="button" [disabled]="busy() || first" (click)="move(i, -1)" aria-label="Subir">&uarr;</button>
                                <button type="button" [disabled]="busy() || last" (click)="move(i, 1)" aria-label="Bajar">&darr;</button>
                                <button type="button" [disabled]="busy()" (click)="startEdit(step)">Editar</button>
                                <button type="button" class="danger" [disabled]="busy()" (click)="remove(step)">Eliminar</button>
                            </div>
                        }
                    </li>
                }
            </ol>
        </section>
    `,
    styles: `
        :host{display:block;max-width:900px;margin:0 auto;color:#27374a;--line:#dce3eb;--orange:#ed6a19;--muted:#62748a}
        *{box-sizing:border-box}
        .page-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:22px}
        h1{font-size:27px;margin:0}p{color:var(--muted);font-size:13px;line-height:1.5;max-width:70ch}
        .error{color:#b3341a}.empty{margin:14px 0 4px}
        .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px}
        button,input{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:7px;padding:9px 12px;background:#fff;color:inherit;min-width:0}
        button{cursor:pointer}button:disabled{opacity:.5;cursor:default}
        button:focus-visible,input:focus-visible{outline:2px solid var(--orange);outline-offset:2px}
        .primary{background:var(--orange);color:#fff;border-color:var(--orange)}
        .danger{color:#b3341a;border-color:#f1c9bf}
        .add-row{display:flex;gap:8px;align-items:stretch}.add-row input{flex:1 1 auto}
        .edit-block{flex:1 1 auto;min-width:0;display:flex}.edit-block input{flex:1 1 auto}
        .flag-toggles{display:inline-flex;gap:4px;flex:0 0 auto}.flag-toggle{display:inline-grid;place-items:center;width:38px;min-width:38px;min-height:36px;padding:0;color:#9aa6b4;background:#fff;border:1px solid #dce3eb;border-radius:7px;font-size:15px;cursor:pointer;transition:color .15s,background-color .15s,border-color .15s}.flag-toggle:hover:not(:disabled){color:#27374a}.flag-toggle.on{color:#fff;background:#ed6a19;border-color:#ed6a19}.flag-toggle:disabled{opacity:.5;cursor:default}.flag-icons{display:inline-flex;gap:6px;margin-left:8px;color:#c2570e;font-size:13px;vertical-align:middle}
        .steps{list-style:none;margin:16px 0 0;padding:0}
        .step{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid #edf0f4}
        .position{flex:0 0 28px;height:28px;display:grid;place-items:center;border-radius:50%;background:#fff0e3;color:#98440d;font-weight:700;font-size:12px}
        .title{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}.title-input{flex:1 1 auto}
        .row-actions{display:flex;gap:6px;flex-wrap:wrap}.row-actions button{padding:6px 9px;font-size:12px}
        .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
        @media(max-width:600px){.step{flex-wrap:wrap}.row-actions{flex-basis:100%;justify-content:flex-end}input{font-size:16px}button{min-height:40px}}
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
    readonly editingId = signal<number | null>(null);
    readonly editTitle = signal('');
    readonly editRequiereFecha = signal(false);
    readonly editRequiereDocumento = signal(false);

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

    add(): void {
        const titulo = this.newTitle().trim();
        if (!titulo) return;
        this.run(this.api.saveCheckDefinition({
            titulo, requiere_fecha: this.newRequiereFecha(), requiere_documento: this.newRequiereDocumento(),
        }), row => {
            this.steps.update(rows => [...rows, row]);
            this.newTitle.set(''); this.newRequiereFecha.set(false); this.newRequiereDocumento.set(false);
        }, 'No se pudo añadir el paso.');
    }

    startEdit(step: CheckDefinition): void {
        this.editingId.set(step.id);
        this.editTitle.set(step.titulo);
        this.editRequiereFecha.set(step.requiere_fecha);
        this.editRequiereDocumento.set(step.requiere_documento);
    }

    cancelEdit(): void {
        this.editingId.set(null);
        this.editTitle.set('');
    }

    saveEdit(step: CheckDefinition): void {
        const titulo = this.editTitle().trim();
        if (!titulo) return;
        const unchanged = titulo === step.titulo
            && this.editRequiereFecha() === step.requiere_fecha
            && this.editRequiereDocumento() === step.requiere_documento;
        if (unchanged) { this.cancelEdit(); return; }
        this.run(this.api.saveCheckDefinition({
            id: step.id, titulo,
            requiere_fecha: this.editRequiereFecha(), requiere_documento: this.editRequiereDocumento(),
        }), row => {
            this.steps.update(rows => rows.map(r => r.id === row.id ? row : r));
            this.cancelEdit();
        }, 'No se pudo guardar el paso.');
    }

    remove(step: CheckDefinition): void {
        if (!confirm(`Eliminar «${step.titulo}» de la lista maestra?\n\nLos proyectos que ya lo tienen lo conservan; solo dejará de copiarse a los proyectos nuevos.`)) return;
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
