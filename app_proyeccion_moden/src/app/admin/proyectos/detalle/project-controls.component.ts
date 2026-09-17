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
            @if (deadlineMessage()) { <p role="status">{{ deadlineMessage() }}</p> }
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
                            <li class="check-row" [class.is-done]="check.completado" [class.is-overdue]="isOverdue(check)">
                                <input type="checkbox" [id]="'check-' + check.id" [checked]="check.completado"
                                    [disabled]="busyCheck() !== null" (change)="toggleCheck(check, $event)" />
                                <div class="check-body">
                                    <label [for]="'check-' + check.id">
                                        <span class="check-title">{{ check.titulo }}</span>
                                        @if (check.origen === 'MANUAL') { <span class="origin">añadido en este proyecto</span> }
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
                                            @else if (!check.completado && !check.fecha_limite) { <span class="hint">Sin fecha</span> }
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
                            <button type="submit" [disabled]="busyCheck() !== null || !newTitle().trim()">Añadir</button>
                        </div>
                        <div class="flags" role="group" aria-label="Qué necesita el paso">
                            <label class="flag"><input type="checkbox" name="newDate" [ngModel]="newRequiereFecha()" (ngModelChange)="newRequiereFecha.set($event)" [disabled]="busyCheck() !== null" /> Con fecha límite</label>
                            <label class="flag"><input type="checkbox" name="newDoc" [ngModel]="newRequiereDocumento()" (ngModelChange)="newRequiereDocumento.set($event)" [disabled]="busyCheck() !== null" /> Con documento de confirmación</label>
                        </div>
                    </form>

                    <footer class="checklist-footer">
                        <button type="button" class="text-button" [disabled]="busyCheck() !== null" (click)="seedFromMaster()">
                            Traer los pasos de la lista maestra que falten
                        </button>
                        @if (seedMessage()) { <span role="status">{{ seedMessage() }}</span> }
                    </footer>
                    @if (checkError()) { <p role="alert" class="urgent">{{ checkError() }}</p> }
                </div>
            </div>
        }
    `,
    styles: `
        :host{display:block;min-width:0}.control-card{background:#fff;border:1px solid #dfe4ea;border-radius:10px;padding:18px;margin-bottom:16px;color:#243446}
        h3{font-size:16px;margin:0 0 12px}p,small{font-size:12px;color:#67758a}label{font-size:13px;display:block}
        input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;border:1px solid #cfd7e1;border-radius:6px;padding:9px;font:inherit;margin:6px 0 10px}
        button{border:1px solid #ccd6df;background:#fff;border-radius:6px;padding:8px 10px;cursor:pointer;color:inherit;font:inherit;font-size:12px}button:disabled{opacity:.5;cursor:default}
        button:focus-visible,input:focus-visible{outline:2px solid #e9691d;outline-offset:2px}
        .primary{background:#fff1e6;border-color:#ed894a;color:#a74508}.secondary{width:100%;margin-top:12px}
        .deadline-row{display:flex;gap:8px;align-items:stretch}.deadline-row input{flex:1 1 auto;margin:0}.deadline-row .primary{flex:0 0 auto;padding:8px 16px}
        .demand{display:grid;gap:4px;padding:12px;background:#f3f6f8;border-radius:6px;margin:12px 0}.demand span{font-size:12px}.urgent{color:#b3341a}
        .progress-row{display:flex;align-items:center;gap:12px}
        .progress{flex:1 1 auto;height:10px;background:#edf0f4;border-radius:999px;overflow:hidden}
        .progress-fill{height:100%;background:#ef6815;border-radius:999px;transition:width .25s ease}.progress-fill.done{background:#2f9e5b}
        .progress-label{font-size:14px;white-space:nowrap}.next-step{margin:8px 0 0}
        .checklist-backdrop{position:fixed;inset:0;background:rgba(20,28,40,.45);display:grid;place-items:center;padding:16px;z-index:1000}
        .checklist-dialog{background:#fff;border-radius:12px;width:min(640px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.25);color:#243446}
        .checklist-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}.checklist-header h3{margin:0 0 4px}.checklist-header p{margin:0}
        .dialog-close{font-size:20px;line-height:1;padding:4px 10px}
        .check-list{list-style:none;margin:14px 0 0;padding:0}
        .check-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f4}
        .check-row>input[type=checkbox]{width:18px;height:18px;flex-shrink:0;margin-top:2px;accent-color:#ef6815}
        .check-body{flex:1 1 auto;min-width:0;display:grid;gap:6px}
        .check-row label{min-width:0;cursor:pointer;overflow-wrap:anywhere}.check-row.is-done .check-title{color:#67758a;text-decoration:line-through}
        .check-row.is-overdue:not(.is-done) .check-title{color:#b3341a}
        .check-date{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.check-date label{font-size:12px;color:#67758a;cursor:default}
        .check-date input[type=date]{width:auto;margin:0;padding:5px 8px;font-size:12px}
        .warn{font-size:11px;font-weight:700;color:#b3341a;background:#fdecea;border-radius:10px;padding:2px 8px}.hint{font-size:11px;color:#98440d;background:#fff0e3;border-radius:10px;padding:2px 8px}
        .check-docs{display:grid;gap:4px}.doc{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
        .doc a{color:#243446;text-decoration:none;overflow-wrap:anywhere}.doc a:hover{text-decoration:underline}.doc small{margin:0}
        .doc-remove{padding:0 6px;font-size:14px}
        .attach{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#af4a13;cursor:pointer;width:fit-content}.attach input{display:none}.attach.is-busy{opacity:.6;cursor:progress}
        .flags{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px}.flag{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#67758a;cursor:pointer}
        .flag input{width:15px;height:15px;margin:0;accent-color:#ef6815}
        .check-title{display:block;font-size:13px}.origin{display:inline-block;margin-top:3px;font-size:11px;color:#98440d;background:#fff0e3;border-radius:10px;padding:1px 7px}
        .check-row small{display:block;margin-top:4px}.check-empty{padding:12px 0;font-size:13px;color:#67758a}
        .remove{flex:0 0 auto;padding:2px 8px;font-size:16px;line-height:1;color:#8a96a3}.remove:hover:not(:disabled){color:#b3341a;border-color:#f1c9bf}
        .add-check{margin-top:16px}.add-check-row{display:flex;gap:8px;align-items:flex-start}.add-check-row input{margin-bottom:0}
        .checklist-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}.checklist-footer span{font-size:12px;color:#67758a}
        .text-button{border:0;padding:6px 0;color:#af4a13}
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
    readonly seedMessage = signal('');
    readonly completed = computed(() => this.checks().filter(c => c.completado).length);
    readonly percent = computed(() => this.checks().length ? Math.round(this.completed() / this.checks().length * 100) : 0);
    readonly nextPending = computed(() => this.checks().find(c => !c.completado) ?? null);
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
            next: project => { this.saved.emit(project); this.saving.set(false); this.deadlineMessage.set('Guardado.'); },
            error: () => { this.saving.set(false); this.deadlineMessage.set('No se pudo guardar el plazo.'); },
        });
    }
    openList(): void { this.checkError.set(''); this.seedMessage.set(''); this.listOpen.set(true); }
    closeList(): void { this.listOpen.set(false); }

    private mutate(request: Observable<ProjectCheck[]>, busyId: number, message: string, after?: () => void): void {
        if (this.busyCheck() !== null) return;
        this.busyCheck.set(busyId); this.checkError.set('');
        request.subscribe({
            next: rows => { this.checks.set(rows); this.busyCheck.set(null); this.uploadingFor.set(null); after?.(); },
            error: () => { this.checkError.set(message); this.busyCheck.set(null); this.uploadingFor.set(null); },
        });
    }
    toggleCheck(check: ProjectCheck, event: Event): void {
        const input = event.target as HTMLInputElement;
        input.checked = check.completado;
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
    seedFromMaster(): void {
        if (this.busyCheck() !== null) return;
        this.busyCheck.set(-2); this.checkError.set(''); this.seedMessage.set('');
        this.api.seedProjectChecklist(this.project().id).subscribe({
            next: result => {
                this.checks.set(result.checks); this.busyCheck.set(null);
                this.seedMessage.set(result.creados ? `${result.creados} paso(s) añadido(s).` : 'Este proyecto ya tiene todos los pasos de la lista maestra.');
            },
            error: () => { this.checkError.set('No se pudo traer la lista maestra.'); this.busyCheck.set(null); },
        });
    }
}
