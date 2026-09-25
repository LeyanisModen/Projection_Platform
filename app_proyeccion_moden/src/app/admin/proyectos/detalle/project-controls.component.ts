import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { A11yModule } from '@angular/cdk/a11y';
import { Observable } from 'rxjs';
import { ApiService, Proyecto, ProjectCheck, ProjectCheckAttachment } from '../../../services/api.service';

@Component({
    selector: 'app-project-controls',
    imports: [CommonModule, FormsModule, A11yModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <section class="control-card">
            <h3>Plazo de montaje</h3>
            <div class="deadline-row">
                <input id="mounting-date" type="date" aria-label="Fecha de montaje" [ngModel]="date()" (ngModelChange)="date.set($event)"
                    (keydown.enter)="saveDeadline()" />
                <button type="button" class="primary" [disabled]="saving() || date() === (project().fecha_montaje || '')" (click)="saveDeadline()">Guardar</button>
            </div>
            @if (project().planificacion; as plan) {
                <div class="demand" [class.urgent]="plan.estado === 'VENCIDO' || plan.estado === 'SIN_DIAS'">
                    @if (plan.estado === 'PLANIFICADO') {
                        <strong>{{ plan.modulos_por_dia }} módulos / día</strong>
                        <span>{{ plan.modulos_pendientes }} pendientes · {{ plan.dias_disponibles }} días disponibles</span>
                    } @else if (plan.estado === 'COMPLETADO') { <strong>Fabricación completada</strong>
                    } @else if (plan.estado === 'VENCIDO') {
                        <strong>Plazo agotado: {{ plan.modulos_pendientes }} pendientes</strong>
                    } @else if (plan.estado === 'SIN_DIAS') {
                        <strong>Sin días de trabajo disponibles antes del montaje: {{ plan.modulos_pendientes }} pendientes</strong>
                    } @else if (plan.estado === 'SIN_FERRALLA') { <span>Asigna una ferralla para calcular el objetivo.</span>
                    } @else if (plan.estado === 'SIN_MODULOS') { <span>Importa módulos para calcular el objetivo.</span>
                    } @else { <span>Falta la fecha de montaje.</span> }
                </div>
            }
            @if (deadlineMessage()) { <p role="alert" class="urgent">{{ deadlineMessage() }}</p> }
        </section>

        <section class="control-card">
            <h3>Control del proyecto</h3>
            @if (loadingChecks()) {
                <p>Cargando lista de control...</p>
            } @else if (!checks().length) {
                <p>Este proyecto no tiene pasos de control.</p>
            } @else {
                <div class="progress-row">
                    <div class="progress" role="progressbar" [attr.aria-valuenow]="completed()" aria-valuemin="0"
                        [attr.aria-valuemax]="checks().length" [attr.aria-label]="'Control del proyecto: ' + completed() + ' de ' + checks().length">
                        <div class="progress-fill" [class.done]="completed() === checks().length" [style.width.%]="percent()"></div>
                    </div>
                    <strong class="progress-label">{{ completed() }} / {{ checks().length }}</strong>
                </div>
                @if (nextPending(); as next) { <p class="next-step">Siguiente: {{ next.titulo }}</p> }
                @if (blocking().length) {
                    <p class="blocked" role="status"><i class="fa fa-lock" aria-hidden="true"></i>
                        Sin producción hasta completar: {{ blockingTitles() }}</p>
                }
            }
            <button type="button" class="secondary" [disabled]="loadingChecks()" (click)="openList()">Ver lista de control</button>
            @if (checkError() && !listOpen()) { <p role="alert" class="urgent">{{ checkError() }}</p> }
        </section>

        @if (listOpen()) {
            <div class="checklist-backdrop" (click)="closeList()">
                <div class="checklist-dialog" role="dialog" aria-modal="true" aria-labelledby="checklist-title"
                    cdkTrapFocus cdkTrapFocusAutoCapture (click)="$event.stopPropagation()" (keydown.escape)="closeList()">
                    <header class="checklist-header">
                        <div>
                            <h3 id="checklist-title">Lista de control · {{ project().nombre }}</h3>
                            <p>{{ completed() }} de {{ checks().length }} pasos completados</p>
                        </div>
                        <button type="button" class="dialog-close" (click)="closeList()" aria-label="Cerrar">&times;</button>
                    </header>

                    @if (checks().length) {
                        <div class="progress" aria-hidden="true">
                            <div class="progress-fill" [class.done]="completed() === checks().length" [style.width.%]="percent()"></div>
                        </div>
                    }

                    <ol class="check-list">
                        @for (check of checks(); track check.id) {
                            <li class="check-row" [class.is-done]="check.completado" [class.is-overdue]="isOverdue(check)"
                                [class.is-waiting]="isWaiting(check)">
                                <input type="checkbox" [id]="'check-' + check.id" [checked]="check.completado"
                                    [disabled]="busyCheck() !== null || isWaiting(check)" (change)="toggleCheck(check, $event)"
                                    [title]="isWaiting(check) ? 'Antes: ' + check.requisitos_pendientes.join(', ') : ''" />
                                <div class="check-body">
                                    <label [for]="'check-' + check.id">
                                        <span class="check-title">{{ check.titulo }}
                                            @if (check.bloquea_produccion) {
                                                <i class="fa fa-lock lock-icon" title="Bloquea producción" aria-label="Bloquea producción"></i>
                                            }
                                        </span>
                                        @if (check.origen === 'MANUAL') { <span class="origin">añadido en este proyecto</span> }
                                        @if (isWaiting(check)) {
                                            <small class="waiting"><i class="fa fa-link" aria-hidden="true"></i> Antes: {{ check.requisitos_pendientes.join(', ') }}</small>
                                        }
                                        @if (check.completado && check.completado_at) {
                                            <small>{{ check.completado_at | date:'dd/MM/yy HH:mm' }}@if (check.completado_por) { · {{ check.completado_por }}}</small>
                                        }
                                    </label>

                                    @if (check.requiere_fecha) {
                                        <div class="check-date">
                                            <label [for]="'deadline-' + check.id">Fecha límite</label>
                                            <input type="date" [id]="'deadline-' + check.id" [value]="check.fecha_limite || ''"
                                                [disabled]="busyCheck() !== null" (change)="setDeadline(check, $event)" />
                                            @if (!check.completado && isOverdue(check)) { <span class="warn">Vencido</span> }
                                            @else if (!check.completado && !check.fecha_limite) {
                                                <span class="hint">{{ check.dias_antes_montaje !== null ? 'D−' + check.dias_antes_montaje + ' · sin fecha de montaje' : 'Sin fecha' }}</span>
                                            }
                                            @else if (check.dias_antes_montaje !== null) { <span class="hint">D−{{ check.dias_antes_montaje }}</span> }
                                        </div>
                                    }

                                    @if (check.requiere_documento) {
                                        <div class="check-docs">
                                            @for (doc of check.adjuntos; track doc.id) {
                                                <div class="doc">
                                                    <a [href]="doc.url" target="_blank" rel="noopener" [title]="'Abrir ' + doc.nombre_original">
                                                        <i class="fa fa-paperclip" aria-hidden="true"></i> {{ doc.nombre_original }}
                                                    </a>
                                                    <small>{{ formatSize(doc.tamano) }} · {{ doc.subido_at | date:'dd/MM/yy' }}@if (doc.subido_por) { · {{ doc.subido_por }}}</small>
                                                    <button type="button" class="remove doc-remove" [disabled]="busyCheck() !== null"
                                                        (click)="removeAttachment(check, doc)" [attr.aria-label]="'Quitar ' + doc.nombre_original">&times;</button>
                                                </div>
                                            }
                                            <label class="attach" [class.is-busy]="uploadingFor() === check.id">
                                                <input type="file" [disabled]="busyCheck() !== null" (change)="attach(check, $event)" />
                                                <i class="fa fa-upload" aria-hidden="true"></i>
                                                {{ uploadingFor() === check.id ? 'Subiendo…' : (check.adjuntos.length ? 'Adjuntar otro documento' : 'Adjuntar documento de confirmación') }}
                                            </label>
                                            @if (check.completado && !check.adjuntos.length) { <span class="warn">Completado sin documento</span> }
                                        </div>
                                    }
                                </div>
                                <button type="button" class="remove" [disabled]="busyCheck() !== null"
                                    (click)="removeCheck(check)" [attr.aria-label]="'Eliminar ' + check.titulo">&times;</button>
                            </li>
                        } @empty {
                            <li class="check-empty">Sin pasos. Añade uno o trae los de la lista maestra.</li>
                        }
                    </ol>

                    <form (ngSubmit)="addCheck()" class="add-check">
                        <label for="new-project-check">Añadir paso a este proyecto</label>
                        <div class="add-check-row">
                            <input id="new-project-check" name="newCheck" maxlength="200" [ngModel]="newTitle()" (ngModelChange)="newTitle.set($event)"
                                placeholder="Ej.: Acta de inicio firmada" [disabled]="busyCheck() !== null" />
                            <div class="flag-toggles" role="group" aria-label="Qué necesita el paso">
                                <button type="button" class="flag-toggle" [class.on]="newRequiereFecha()" [attr.aria-pressed]="newRequiereFecha()"
                                    (click)="newRequiereFecha.set(!newRequiereFecha())" [disabled]="busyCheck() !== null"
                                    title="Con fecha límite" aria-label="Con fecha límite"><i class="fa fa-calendar" aria-hidden="true"></i></button>
                                <button type="button" class="flag-toggle" [class.on]="newRequiereDocumento()" [attr.aria-pressed]="newRequiereDocumento()"
                                    (click)="newRequiereDocumento.set(!newRequiereDocumento())" [disabled]="busyCheck() !== null"
                                    title="Con documento de confirmación" aria-label="Con documento de confirmación"><i class="fa fa-file-text-o" aria-hidden="true"></i></button>
                            </div>
                            <button type="submit" [disabled]="busyCheck() !== null || !newTitle().trim()">Añadir</button>
                        </div>
                    </form>

                    @if (checkError()) { <p role="alert" class="urgent">{{ checkError() }}</p> }
                </div>
            </div>
        }
    `,
    styleUrls: ['../../admin-theme.css'],
    styles: `
        :host{display:block;min-width:0}.control-card{padding:0 0 18px;margin-bottom:18px;border-bottom:1px solid var(--line-strong)}
        h3{margin:0 0 8px;color:var(--text);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}p,small{font-size:12px;color:var(--muted)}label{font-size:13px;display:block}
        input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;height:var(--control-h);border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:0 12px;font:inherit;color:var(--ink);margin:0 0 10px}
        input:not([type=checkbox]):focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
        button{height:var(--control-h);border:1px solid var(--line-strong);background:var(--surface);border-radius:var(--radius-sm);padding:0 12px;cursor:pointer;color:var(--ink);font:inherit;font-size:13px;font-weight:500}
        button:hover:not(:disabled){background:var(--surface-2)}button:disabled{opacity:.5;cursor:default}
        button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
        .primary{background:var(--accent);border-color:var(--accent);color:#fff}.primary:hover:not(:disabled){background:var(--accent-dark);border-color:var(--accent-dark)}
        .secondary{width:100%;margin-top:10px}
        .deadline-row{display:flex;gap:8px;align-items:stretch}.deadline-row input{flex:1 1 auto;margin:0}.deadline-row .primary{flex:0 0 auto;padding:0 16px}
        .demand{display:grid;gap:2px;padding:10px 12px;background:var(--surface-2);margin:10px 0 0}.demand span{font-size:12px}.urgent{color:var(--danger)}
        .progress-row{display:flex;align-items:center;gap:12px}
        .progress{flex:1 1 auto;height:6px;background:var(--line);border-radius:999px;overflow:hidden}
        .progress-fill{height:100%;background:var(--accent);border-radius:999px;transition:width .25s ease}.progress-fill.done{background:var(--ok)}
        .progress-label{font-size:13px;color:var(--ink);white-space:nowrap;font-variant-numeric:tabular-nums}.next-step{margin:6px 0 0}
        .blocked{margin:6px 0 0;color:var(--danger);font-weight:600}.blocked i{margin-right:4px}
        .lock-icon{margin-left:6px;color:var(--muted);font-size:12px}
        .check-row.is-waiting>input[type=checkbox]{cursor:not-allowed}.waiting{color:var(--muted)}.waiting i{margin-right:3px}
        .checklist-backdrop{position:fixed;inset:0;background:rgba(31,41,51,.5);display:grid;place-items:center;padding:16px;z-index:1000}
        .checklist-dialog{background:var(--surface);border:1px solid var(--line);width:min(640px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.2);color:var(--text)}
        .checklist-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}.checklist-header h3{margin:0 0 4px;font-size:17px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ink)}.checklist-header p{margin:0}
        .dialog-close{width:34px;padding:0;font-size:18px;line-height:1;border-color:transparent;color:var(--muted)}
        .check-list{list-style:none;margin:14px 0 0;padding:0;border-top:1px solid var(--line-strong)}
        .check-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}
        .check-row>input[type=checkbox]{width:18px;height:18px;flex-shrink:0;margin-top:2px;accent-color:var(--ink)}
        .check-body{flex:1 1 auto;min-width:0;display:grid;gap:6px}
        .check-row label{min-width:0;cursor:pointer;overflow-wrap:anywhere}.check-row.is-done .check-title{color:var(--muted);text-decoration:line-through}
        .check-row.is-overdue:not(.is-done) .check-title{color:var(--danger)}
        .check-date{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.check-date label{font-size:12px;color:var(--muted);cursor:default}
        .check-date input[type=date]{width:auto;height:32px;margin:0;padding:0 8px;font-size:12px}
        .warn{font-size:11px;font-weight:600;color:var(--danger)}.hint{font-size:11px;color:var(--muted)}
        .check-docs{display:grid;gap:4px}.doc{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
        .doc a{color:var(--ink);text-decoration:none;overflow-wrap:anywhere}.doc a:hover{text-decoration:underline}.doc small{margin:0}
        .doc-remove{height:26px;padding:0 6px;font-size:14px;border-color:transparent;color:var(--muted)}.doc-remove:hover:not(:disabled){color:var(--danger)}
        .attach{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text);cursor:pointer;width:fit-content;text-decoration:underline;text-underline-offset:2px}.attach input{display:none}.attach.is-busy{opacity:.6;cursor:progress}
        .flag-toggles{display:inline-flex;gap:4px;flex:0 0 auto}.flag-toggle{display:inline-grid;place-items:center;width:38px;min-width:38px;height:var(--control-h);padding:0;color:var(--muted);background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-sm);font-size:14px;cursor:pointer}.flag-toggle:hover:not(:disabled){color:var(--ink);background:var(--surface-2)}.flag-toggle.on{color:var(--ink);background:var(--surface-2);border-color:var(--ink)}.flag-toggle:disabled{opacity:.5;cursor:default}.flag-icons{display:inline-flex;gap:6px;margin-left:8px;color:var(--muted);font-size:13px;vertical-align:middle}
        .check-title{display:block;font-size:13px;color:var(--ink)}.origin{display:inline-block;margin-top:3px;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:1px 7px}
        .check-row small{display:block;margin-top:4px}.check-empty{padding:12px 0;font-size:13px;color:var(--muted)}
        .remove{flex:0 0 auto;width:28px;height:28px;padding:0;font-size:16px;line-height:1;color:var(--muted);border-color:transparent}.remove:hover:not(:disabled){color:var(--danger);background:#fbeae7}
        .add-check{margin-top:16px}.add-check-row{display:flex;gap:8px;align-items:stretch;margin-top:6px}.add-check-row input{margin-bottom:0}
        .checklist-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}.checklist-footer span{font-size:12px;color:var(--muted)}
        @media(max-width:600px){input:not([type=checkbox]){font-size:16px}button{min-height:42px}.remove{min-height:32px}}
    `,
})
export class ProjectControlsComponent {
    readonly project = input.required<Proyecto>();
    readonly saved = output<Proyecto>();
    private readonly api = inject(ApiService);
    readonly date = signal('');
    readonly saving = signal(false);
    readonly deadlineMessage = signal('');
    readonly checks = signal<ProjectCheck[]>([]);
    readonly loadingChecks = signal(false);
    readonly busyCheck = signal<number | null>(null);
    readonly checkError = signal('');
    readonly newTitle = signal('');
    readonly newRequiereFecha = signal(false);
    readonly newRequiereDocumento = signal(false);
    readonly uploadingFor = signal<number | null>(null);
    readonly listOpen = signal(false);
    readonly completed = computed(() => this.checks().filter(c => c.completado).length);
    readonly percent = computed(() => this.checks().length ? Math.round(this.completed() / this.checks().length * 100) : 0);
    readonly nextPending = computed(() => this.checks().find(c => !c.completado) ?? null);
    readonly blocking = computed(() => this.checks().filter(c => c.bloquea_produccion && !c.completado));
    readonly blockingTitles = computed(() => this.blocking().map(c => c.titulo).join(', '));
    constructor() {
        effect(() => {
            const project = this.project();
            this.date.set(project.fecha_montaje || '');
        });
        effect(onCleanup => {
            const id = this.project().id;
            this.loadingChecks.set(true);
            const sub = this.api.getProjectChecklist(id).subscribe({
                next: rows => { this.checks.set(rows); this.loadingChecks.set(false); },
                error: () => { this.checkError.set('No se pudo cargar el control del proyecto.'); this.loadingChecks.set(false); },
            });
            onCleanup(() => sub.unsubscribe());
        });
    }
    saveDeadline(): void {
        if (this.saving()) return;
        this.saving.set(true); this.deadlineMessage.set('');
        this.api.updateProyecto(this.project().id, {fecha_montaje:this.date() || null}).subscribe({
            next: project => { this.saved.emit(project); this.saving.set(false); },
            error: () => { this.saving.set(false); this.deadlineMessage.set('No se pudo guardar el plazo.'); },
        });
    }
    openList(): void { this.checkError.set(''); this.listOpen.set(true); }
    closeList(): void { this.listOpen.set(false); }

    private mutate(request: Observable<ProjectCheck[]>, busyId: number, message: string, after?: () => void): void {
        if (this.busyCheck() !== null) return;
        this.busyCheck.set(busyId); this.checkError.set('');
        request.subscribe({
            next: rows => { this.checks.set(rows); this.busyCheck.set(null); this.uploadingFor.set(null); after?.(); },
            error: () => { this.checkError.set(message); this.busyCheck.set(null); this.uploadingFor.set(null); },
        });
    }
    /** Pendiente de otros pasos: no se puede marcar hasta que estén completos. */
    isWaiting(check: ProjectCheck): boolean {
        return !check.completado && check.requisitos_pendientes.length > 0;
    }
    toggleCheck(check: ProjectCheck, event: Event): void {
        const input = event.target as HTMLInputElement;
        input.checked = check.completado;
        if (this.isWaiting(check)) return;
        this.mutate(
            this.api.updateProjectCheck(this.project().id, check.id, { completado: !check.completado }),
            check.id, 'No se pudo guardar el paso.',
        );
    }
    addCheck(): void {
        const titulo = this.newTitle().trim();
        if (!titulo) return;
        this.mutate(this.api.addProjectCheck(this.project().id, {
            titulo, requiere_fecha: this.newRequiereFecha(), requiere_documento: this.newRequiereDocumento(),
        }), -1, 'No se pudo añadir el paso. Comprueba que no exista ya.', () => {
            this.newTitle.set(''); this.newRequiereFecha.set(false); this.newRequiereDocumento.set(false);
        });
    }
    isOverdue(check: ProjectCheck): boolean {
        if (!check.fecha_limite || check.completado) return false;
        const today = new Date();
        const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        return check.fecha_limite < local;
    }
    setDeadline(check: ProjectCheck, event: Event): void {
        const value = (event.target as HTMLInputElement).value || null;
        if (value === check.fecha_limite) return;
        this.mutate(this.api.updateProjectCheck(this.project().id, check.id, { fecha_limite: value }), check.id, 'No se pudo guardar la fecha límite.');
    }
    attach(check: ProjectCheck, event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file || this.busyCheck() !== null) return;
        if (file.size > 20 * 1024 * 1024) { this.checkError.set('El documento supera los 20 MB.'); return; }
        this.uploadingFor.set(check.id);
        this.mutate(this.api.uploadProjectCheckAttachment(this.project().id, check.id, file), check.id, 'No se pudo subir el documento.', () => this.uploadingFor.set(null));
    }
    removeAttachment(check: ProjectCheck, doc: ProjectCheckAttachment): void {
        if (!confirm(`Quitar «${doc.nombre_original}» de este paso?`)) return;
        this.mutate(this.api.deleteProjectCheckAttachment(this.project().id, check.id, doc.id), check.id, 'No se pudo quitar el documento.');
    }
    formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    removeCheck(check: ProjectCheck): void {
        const detail = check.completado ? ' Se perderá la marca de completado.' : '';
        if (!confirm(`Eliminar «${check.titulo}» de este proyecto?${detail}`)) return;
        this.mutate(this.api.deleteProjectCheck(this.project().id, check.id), check.id, 'No se pudo eliminar el paso.');
    }
}
