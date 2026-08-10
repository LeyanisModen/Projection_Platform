import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    resource,
    signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
    ApiService,
    ProyectoMesaPreviewModulo,
    ProyectoMesaPreviewQueue,
} from '../../../services/api.service';

@Component({
    selector: 'app-project-table-preview',
    templateUrl: './project-table-preview.component.html',
    styleUrls: ['./project-table-preview.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectTablePreviewComponent {
    private readonly api = inject(ApiService);

    readonly projectId = input.required<number>();
    readonly refreshKey = input(0);

    readonly inferiores = signal(2);
    readonly superiores = signal(1);
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

    readonly inferiorQueues = computed(() =>
        (this.previewResource.value()?.queues ?? []).filter(
            queue => queue.tipo === 'INFERIOR',
        ),
    );

    readonly superiorQueues = computed(() =>
        (this.previewResource.value()?.queues ?? []).filter(
            queue => queue.tipo === 'SUPERIOR',
        ),
    );

    setInferiores(event: Event): void {
        this.setCount(event, this.inferiorOptions, this.inferiores);
    }

    setSuperiores(event: Event): void {
        this.setCount(event, this.superiorOptions, this.superiores);
    }

    reload(): void {
        this.previewResource.reload();
    }

    isGroupStart(queue: ProyectoMesaPreviewQueue, index: number): boolean {
        return index === 0
            || queue.modulos[index - 1].group_index !== queue.modulos[index].group_index;
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
        event: Event,
        allowed: number[],
        target: ReturnType<typeof signal<number>>,
    ): void {
        const value = Number((event.target as HTMLSelectElement).value);
        if (allowed.includes(value)) {
            target.set(value);
        }
    }
}
