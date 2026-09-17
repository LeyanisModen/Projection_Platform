import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { A11yModule } from '@angular/cdk/a11y';
import { Observable } from 'rxjs';
import { ApiService, Proyecto, ProjectCheck } from '../../../services/api.service';

@Component({
    selector: 'app-project-controls',
    imports: [CommonModule, FormsModule, A11yModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <section class="control-card">
            <h3>Plazo de montaje</h3>
            <p>La fabricación debe quedar lista antes del día de montaje.</p>
            <label for="mounting-date">Fecha de montaje</label>
            <input id="mounting-date" type="date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
            <p class="factory-schedule">Jornada de la ferralla: <strong>{{ workingDaysLabel() }}</strong>.<br>
                Los días se modifican en «Horario y cámaras» de la ferralla, no en este proyecto.</p>
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
            <button type="button" class="primary" [disabled]="saving()" (click)="saveDeadline()">Guardar plazo</button>
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
            <div class="modal-backdrop" (click)="closeList()">
                <div class="modal" role="dialog" aria-modal="true" aria-labelledby="checklist-title"
                    cdkTrapFocus cdkTrapFocusAutoCapture (click)="$event.stopPropagation()" (keydown.escape)="closeList()">
                    <header class="modal-header">
                        <div>
                            <h3 id="checklist-title">Lista de control · {{ project().nombre }}</h3>
                            <p>{{ completed() }} de {{ checks().length }} pasos completados</p>
                        </div>
                        <button type="button" class="close" (click)="closeList()" aria-label="Cerrar">&times;</button>
                    </header>

                    @if (checks().length) {
                        <div class="progress" aria-hidden="true">
                            <div class="progress-fill" [class.done]="completed() === checks().length" [style.width.%]="percent()"></div>
                        </div>
                    }

                    <ol class="check-list">
                        @for (check of checks(); track check.id) {
                            <li class="check-row" [class.is-done]="check.completado">
                                <input type="checkbox" [id]="'check-' + check.id" [checked]="check.completado"
                                    [disabled]="busyCheck() !== null" (change)="toggleCheck(check, $event)" />
                                <label [for]="'check-' + check.id">
                                    <span class="check-title">{{ check.titulo }}</span>
                                    @if (check.origen === 'MANUAL') { <span class="origin">añadido en este proyecto</span> }
                                    @if (check.completado && check.completado_at) {
                                        <small>{{ check.completado_at | date:'dd/MM/yy HH:mm' }} · {{ check.completado_por }}</small>
                                    }
                                </label>
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
                    </form>

                    <footer class="modal-footer">
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
        .primary{background:#fff1e6;border-color:#ed894a;color:#a74508;width:100%}.secondary{width:100%;margin-top:12px}
        .factory-schedule{line-height:1.6}
        .demand{display:grid;gap:4px;padding:12px;background:#f3f6f8;border-radius:6px;margin:12px 0}.demand span{font-size:12px}.urgent{color:#b3341a}
        .progress-row{display:flex;align-items:center;gap:12px}
        .progress{flex:1 1 auto;height:10px;background:#edf0f4;border-radius:999px;overflow:hidden}
        .progress-fill{height:100%;background:#ef6815;border-radius:999px;transition:width .25s ease}.progress-fill.done{background:#2f9e5b}
        .progress-label{font-size:14px;white-space:nowrap}.next-step{margin:8px 0 0}
        .modal-backdrop{position:fixed;inset:0;background:rgba(20,28,40,.45);display:grid;place-items:center;padding:16px;z-index:1000}
        .modal{background:#fff;border-radius:12px;width:min(640px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.25);color:#243446}
        .modal-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}.modal-header h3{margin:0 0 4px}.modal-header p{margin:0}
        .close{font-size:20px;line-height:1;padding:4px 10px}
        .check-list{list-style:none;margin:14px 0 0;padding:0}
        .check-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f4}
        .check-row input{width:18px;height:18px;flex-shrink:0;margin-top:2px;accent-color:#ef6815}
        .check-row label{flex:1 1 auto;min-width:0;cursor:pointer;overflow-wrap:anywhere}.check-row.is-done .check-title{color:#67758a;text-decoration:line-through}
        .check-title{display:block;font-size:13px}.origin{display:inline-block;margin-top:3px;font-size:11px;color:#98440d;background:#fff0e3;border-radius:10px;padding:1px 7px}
        .check-row small{display:block;margin-top:4px}.check-empty{padding:12px 0;font-size:13px;color:#67758a}
        .remove{flex:0 0 auto;padding:2px 8px;font-size:16px;line-height:1;color:#8a96a3}.remove:hover:not(:disabled){color:#b3341a;border-color:#f1c9bf}
        .add-check{margin-top:16px}.add-check-row{display:flex;gap:8px;align-items:flex-start}.add-check-row input{margin-bottom:0}
        .modal-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}.modal-footer span{font-size:12px;color:#67758a}
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
    readonly listOpen = signal(false);
    readonly seedMessage = signal('');
    readonly completed = computed(() => this.checks().filter(c => c.completado).length);
    readonly percent = computed(() => this.checks().length ? Math.round(this.completed() / this.checks().length * 100) : 0);
    readonly nextPending = computed(() => this.checks().find(c => !c.completado) ?? null);
    readonly workingDaysLabel = computed(() => {
        if (this.project().planificacion?.estado === 'SIN_FERRALLA') return 'sin ferralla asignada';
        const labels: Record<string, string> = {
            MON:'lunes', TUE:'martes', WED:'miércoles', THU:'jueves', FRI:'viernes', SAT:'sábado', SUN:'domingo',
        };
        return (this.project().planificacion?.dias_produccion || []).map(day => labels[day] || day).join(', ') || 'sin días configurados';
    });
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
            next: project => { this.saved.emit(project); this.saving.set(false); this.deadlineMessage.set('Plazo guardado.'); },
            error: () => { this.saving.set(false); this.deadlineMessage.set('No se pudo guardar el plazo.'); },
        });
    }
    openList(): void { this.checkError.set(''); this.seedMessage.set(''); this.listOpen.set(true); }
    closeList(): void { this.listOpen.set(false); }

    private mutate(request: Observable<ProjectCheck[]>, busyId: number, message: string, after?: () => void): void {
        if (this.busyCheck() !== null) return;
        this.busyCheck.set(busyId); this.checkError.set('');
        request.subscribe({
            next: rows => { this.checks.set(rows); this.busyCheck.set(null); after?.(); },
            error: () => { this.checkError.set(message); this.busyCheck.set(null); },
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
        this.mutate(this.api.addProjectCheck(this.project().id, titulo), -1, 'No se pudo añadir el paso. Comprueba que no exista ya.', () => this.newTitle.set(''));
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
