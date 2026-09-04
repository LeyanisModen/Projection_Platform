import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, Proyecto, ProjectCheck, CheckDefinition } from '../../../services/api.service';

@Component({
    selector: 'app-project-controls',
    imports: [CommonModule, FormsModule],
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
            <h3>Control del proyecto <small>{{ completed() }} / {{ checks().length }}</small></h3>
            @if (loadingChecks()) { <p>Cargando controles...</p> }
            @for (check of checks(); track check.id) {
                <label class="check-row">
                    <input type="checkbox" [checked]="check.completado" [disabled]="busyCheck() !== null"
                        (change)="toggleCheck(check, $event)" />
                    <span>{{ check.titulo }}
                        @if (check.actualizado_at) { <small>{{ check.actualizado_at | date:'dd/MM/yy HH:mm' }} · {{ check.actualizado_por }}</small> }
                    </span>
                </label>
            } @empty { @if (!loadingChecks()) { <p>Añade el primer paso de control.</p> } }
            <form (ngSubmit)="addCheck()" class="add-check">
                <label for="new-project-check">Nuevo paso para todos los proyectos</label>
                <input id="new-project-check" name="newCheck" maxlength="200" [ngModel]="newTitle()" (ngModelChange)="newTitle.set($event)" placeholder="Ej.: Planos entregados" />
                <button type="submit" [disabled]="busyCheck() !== null || !newTitle().trim()">Añadir check</button>
            </form>
            <button class="text-button" type="button" (click)="manageDefinitions()">Editar lista común</button>
            @if (definitionsOpen()) {
                <p>Los títulos y pasos activos se comparten con todos los proyectos.</p>
                @for (definition of definitions(); track definition.id) {
                    <div class="definition">
                        <input [attr.aria-label]="'Título del paso ' + definition.id" [(ngModel)]="definition.titulo" maxlength="200" />
                        <button type="button" [disabled]="busyCheck() !== null || !definition.titulo.trim()" (click)="saveDefinition(definition)">Guardar</button>
                        <button type="button" [disabled]="busyCheck() !== null" (click)="setDefinitionActive(definition)">{{ definition.activo ? 'Archivar' : 'Recuperar' }}</button>
                    </div>
                }
                <button type="button" (click)="definitionsOpen.set(false)">Cerrar edición</button>
            }
            @if (checkError()) { <p role="alert" class="urgent">{{ checkError() }}</p> }
        </section>
    `,
    styles: `
        :host{display:block;min-width:0}.control-card{background:#fff;border:1px solid #dfe4ea;border-radius:10px;padding:18px;margin-bottom:16px;color:#243446}
        h3{font-size:16px;margin:0 0 12px}p,small{font-size:12px;color:#67758a}h3 small{float:right}label{font-size:13px;display:block}
        input:not([type=checkbox]){box-sizing:border-box;width:100%;min-width:0;border:1px solid #cfd7e1;border-radius:6px;padding:9px;font:inherit;margin:6px 0 10px}
        button{border:1px solid #ccd6df;background:#fff;border-radius:6px;padding:8px 10px;cursor:pointer;color:inherit;font:inherit;font-size:12px}button:disabled{opacity:.5;cursor:default}
        button:focus-visible,input:focus-visible{outline:2px solid #e9691d;outline-offset:2px}.primary{background:#fff1e6;border-color:#ed894a;color:#a74508;width:100%}.factory-schedule{line-height:1.6}
        .demand{display:grid;gap:4px;padding:12px;background:#f3f6f8;border-radius:6px;margin:12px 0}.demand span{font-size:12px}.urgent{color:#b3341a}
        .check-row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f4;cursor:pointer;overflow-wrap:anywhere}.check-row input{width:18px;height:18px;flex-shrink:0;accent-color:#ef6815}.check-row small{display:block;margin-top:4px}
        .add-check{margin-top:16px}.text-button{border:0;margin-top:10px;color:#af4a13}.definition{display:flex;flex-wrap:wrap;gap:5px;margin:12px 0}.definition input{flex-basis:100%}
        @media(max-width:600px){input:not([type=checkbox]){font-size:16px}button{min-height:42px}}
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
    readonly definitions = signal<CheckDefinition[]>([]);
    readonly definitionsOpen = signal(false);
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
    completed(): number { return this.checks().filter(c => c.completado).length; }
    saveDeadline(): void {
        if (this.saving()) return;
        this.saving.set(true); this.deadlineMessage.set('');
        this.api.updateProyecto(this.project().id, {fecha_montaje:this.date() || null}).subscribe({
            next: project => { this.saved.emit(project); this.saving.set(false); this.deadlineMessage.set('Plazo guardado.'); },
            error: () => { this.saving.set(false); this.deadlineMessage.set('No se pudo guardar el plazo.'); },
        });
    }
    private reloadChecks(): void {
        this.api.getProjectChecklist(this.project().id).subscribe({
            next: rows => this.checks.set(rows), error: () => this.checkError.set('No se pudo actualizar la lista.'),
        });
    }
    toggleCheck(check: ProjectCheck, event: Event): void {
        const input = event.target as HTMLInputElement;
        input.checked = check.completado;
        if (this.busyCheck() !== null) return;
        this.busyCheck.set(check.id); this.checkError.set('');
        this.api.setProjectCheck(this.project().id, check.id, !check.completado).subscribe({
            next: rows => { this.checks.set(rows); this.busyCheck.set(null); },
            error: () => { this.checkError.set('No se pudo guardar el check.'); this.busyCheck.set(null); },
        });
    }
    addCheck(): void {
        if (!this.newTitle().trim() || this.busyCheck() !== null) return;
        this.saveDefinition({titulo:this.newTitle().trim(), activo:true, orden:0});
    }
    manageDefinitions(): void {
        this.api.getCheckDefinitions().subscribe({
            next: rows => { this.definitions.set(rows); this.definitionsOpen.set(true); },
            error: () => this.checkError.set('No se pudo cargar la lista común.'),
        });
    }
    setDefinitionActive(definition: CheckDefinition): void {
        if (!confirm(`${definition.activo ? 'Archivar' : 'Recuperar'} este paso en todos los proyectos? Las marcas anteriores se conservarán.`)) return;
        this.saveDefinition({...definition, activo:!definition.activo});
    }
    saveDefinition(definition: Partial<CheckDefinition>): void {
        this.busyCheck.set(-1); this.checkError.set('');
        this.api.saveCheckDefinition(definition).subscribe({
            next: () => { this.busyCheck.set(null); this.newTitle.set(''); this.reloadChecks(); if (this.definitionsOpen()) this.manageDefinitions(); },
            error: () => { this.busyCheck.set(null); this.checkError.set('No se pudo guardar el paso.'); },
        });
    }
}
