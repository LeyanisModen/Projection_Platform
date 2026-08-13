import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    output,
    resource,
    signal,
} from '@angular/core';
import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import {
    ApiService,
    GrupoBastidor,
    ProyectoMesaPreviewModulo,
    ProyectoMesaPreviewQueue,
} from '../../../services/api.service';

interface ProyectoMesaPreviewGroup {
    key: string;
    group_id: number | null;
    group_index: number | null;
    group_name: string;
    modulos: ProyectoMesaPreviewModulo[];
}

interface ProyectoMesaPreviewQueueView extends ProyectoMesaPreviewQueue {
    groups: ProyectoMesaPreviewGroup[];
}

export function previewIndexToBastidorIndex(
    moduleCountAfterRemoval: number,
    previewIndex: number,
): number {
    const count = Math.max(0, Math.trunc(moduleCountAfterRemoval));
    const safePreviewIndex = Math.min(Math.max(0, Math.trunc(previewIndex)), count);
    return count - safePreviewIndex;
}

function previewGroupIdentity(modulo: ProyectoMesaPreviewModulo): string {
    if (modulo.group_id !== null) {
        return `id-${modulo.group_id}`;
    }
    return `virtual-${modulo.group_index ?? modulo.group_name}`;
}

export function filterCompletedPreviewGroups(
    queues: ProyectoMesaPreviewQueue[],
    showCompletedGroups: boolean,
): ProyectoMesaPreviewQueue[] {
    if (showCompletedGroups) {
        return queues;
    }

    const modulesByGroup = new Map<string, Map<number, ProyectoMesaPreviewModulo>>();
    for (const queue of queues) {
        for (const modulo of queue.modulos) {
            const groupKey = previewGroupIdentity(modulo);
            const groupModules = modulesByGroup.get(groupKey) ?? new Map();
            groupModules.set(modulo.id, modulo);
            modulesByGroup.set(groupKey, groupModules);
        }
    }

    const completedGroups = new Set(
        [...modulesByGroup.entries()]
            .filter(([, modules]) =>
                modules.size > 0
                && [...modules.values()].every(modulo =>
                    modulo.estado === 'COMPLETADO' || modulo.estado === 'CERRADO',
                ),
            )
            .map(([groupKey]) => groupKey),
    );

    return queues.map(queue => ({
        ...queue,
        modulos: queue.modulos.filter(
            modulo => !completedGroups.has(previewGroupIdentity(modulo)),
        ),
    }));
}

@Component({
    selector: 'app-project-table-preview',
    imports: [DragDropModule, FormsModule],
    templateUrl: './project-table-preview.component.html',
    styleUrls: ['./project-table-preview.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectTablePreviewComponent {
    private readonly api = inject(ApiService);

    readonly projectId = input.required<number>();
    readonly refreshKey = input(0);
    readonly groupsChanged = output<GrupoBastidor[]>();

    readonly inferiores = signal(2);
    readonly superiores = signal(1);
    readonly mostrarBastidoresCompletados = signal(true);
    readonly movingModuloId = signal<number | null>(null);
    readonly moveError = signal('');
    readonly inferiorOptions = [1, 2, 3, 4];
    readonly superiorOptions = [1, 2];

    readonly previewResource = resource({
        params: () => ({
            projectId: this.projectId(),
            inferiores: this.inferiores(),
            superiores: this.superiores(),
            refreshKey: this.refreshKey(),
        }),
        loader: ({ params }) => firstValueFrom(
            this.api.getProyectoMesasPreview(
                params.projectId,
                params.inferiores,
                params.superiores,
            ),
        ),
    });

    readonly filteredQueues = computed(() => filterCompletedPreviewGroups(
        this.previewResource.value()?.queues ?? [],
        this.mostrarBastidoresCompletados(),
    ));

    readonly queueViews = computed<ProyectoMesaPreviewQueueView[]>(() =>
        this.filteredQueues().map(queue => ({
            ...queue,
            groups: queue.tipo === 'INFERIOR' ? this.buildInferiorGroups(queue) : [],
        })),
    );

    readonly visibleModuleCount = computed(() => new Set(
        this.filteredQueues().flatMap(queue => queue.modulos.map(modulo => modulo.id)),
    ).size);

    readonly inferiorDropListIds = computed(() =>
        this.queueViews()
            .flatMap(queue => queue.groups)
            .filter(group => group.group_id !== null)
            .map(group => this.dropListId(group)),
    );

    setInferiores(value: number): void {
        this.setCount(value, this.inferiorOptions, this.inferiores);
    }

    setSuperiores(value: number): void {
        this.setCount(value, this.superiorOptions, this.superiores);
    }

    setMostrarBastidoresCompletados(value: boolean): void {
        this.mostrarBastidoresCompletados.set(value);
    }

    dropListId(group: ProyectoMesaPreviewGroup): string {
        return `preview-bastidor-${group.key}`;
    }

    connectedDropListIds(group: ProyectoMesaPreviewGroup): string[] {
        const ownId = this.dropListId(group);
        return this.inferiorDropListIds().filter(id => id !== ownId);
    }

    isModuloMovible(modulo: ProyectoMesaPreviewModulo): boolean {
        return !this.isModuloLocked(modulo)
            && this.movingModuloId() === null;
    }

    isModuloLocked(modulo: ProyectoMesaPreviewModulo): boolean {
        const productionLocked = !(modulo.movible ?? (modulo.estado === 'PENDIENTE'));
        return productionLocked || modulo.group_id === null;
    }

    moduloBloqueoTitle(modulo: ProyectoMesaPreviewModulo): string {
        if (modulo.group_id === null) {
            return 'Este modulo aun no tiene bastidor persistido';
        }
        return modulo.motivo_bloqueo || 'Este modulo ya no se puede reordenar';
    }

    readonly previewSortPredicate = (
        index: number,
        drag: { data: ProyectoMesaPreviewModulo },
        drop: { data: ProyectoMesaPreviewGroup },
    ): boolean => {
        if (!this.isModuloMovible(drag.data) || drop.data.group_id === null) {
            return false;
        }

        const destinationModules = drop.data.modulos.filter(
            modulo => modulo.id !== drag.data.id,
        );
        const firstLockedIndex = destinationModules.findIndex(
            modulo => this.isModuloLocked(modulo),
        );
        return firstLockedIndex === -1 || index <= firstLockedIndex;
    };

    onModuloDrop(event: CdkDragDrop<ProyectoMesaPreviewGroup>): void {
        const modulo = event.item.data as ProyectoMesaPreviewModulo;
        const destination = event.container.data;

        if (
            this.movingModuloId() !== null
            || !this.isModuloMovible(modulo)
            || destination.group_id === null
        ) {
            return;
        }
        if (
            event.previousContainer === event.container
            && event.previousIndex === event.currentIndex
        ) {
            return;
        }

        // El planificador muestra cada bastidor en orden inverso durante INF.
        // Convertimos la posicion visible a orden_intra antes de persistirla.
        const destinationCount = destination.modulos.filter(
            candidate => candidate.id !== modulo.id,
        ).length;
        const destinationIndex = previewIndexToBastidorIndex(
            destinationCount,
            event.currentIndex,
        );

        this.moveError.set('');
        this.movingModuloId.set(modulo.id);
        this.api.moveModuloEntreBastidores(
            modulo.id,
            destination.group_id,
            destinationIndex,
        ).subscribe({
            next: grupos => {
                this.movingModuloId.set(null);
                this.groupsChanged.emit(grupos);
            },
            error: error => {
                this.movingModuloId.set(null);
                this.moveError.set(
                    error?.error?.detail || `No se pudo mover el modulo ${modulo.nombre}.`,
                );
            },
        });
    }

    tipoModuloLabel(modulo: ProyectoMesaPreviewModulo): string {
        switch (modulo.tipo_modulo) {
            case 'CENTRAL': return 'C';
            case 'CENTRAL_GIRADO': return 'CG';
            case 'LADO_LARGO': return 'LL';
            case 'LADO_CORTO': return 'LC';
            case 'ESQUINA': return 'E';
            default: return '';
        }
    }

    errorMessage(): string {
        const error = this.previewResource.error() as {
            error?: { detail?: string };
            message?: string;
        } | undefined;
        return error?.error?.detail || error?.message || 'No se pudo calcular la simulación.';
    }

    private setCount(
        value: number,
        allowed: number[],
        target: ReturnType<typeof signal<number>>,
    ): void {
        if (allowed.includes(value)) {
            target.set(value);
        }
    }

    private buildInferiorGroups(
        queue: ProyectoMesaPreviewQueue,
    ): ProyectoMesaPreviewGroup[] {
        const groups = new Map<string, ProyectoMesaPreviewGroup>();

        for (const modulo of queue.modulos) {
            const identity = previewGroupIdentity(modulo);
            let group = groups.get(identity);
            if (!group) {
                group = {
                    key: `${queue.key}-${identity}`,
                    group_id: modulo.group_id,
                    group_index: modulo.group_index,
                    group_name: modulo.group_name,
                    modulos: [],
                };
                groups.set(identity, group);
            }
            group.modulos.push(modulo);
        }

        return [...groups.values()];
    }
}
