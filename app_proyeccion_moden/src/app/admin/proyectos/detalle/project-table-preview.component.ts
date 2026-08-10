import {
    ChangeDetectionStrategy,
    Component,
    inject,
    input,
    resource,
    signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import {
    ApiService,
    ProyectoMesaPreviewModulo,
    ProyectoMesaPreviewQueue,
} from '../../../services/api.service';

@Component({
    selector: 'app-project-table-preview',
    imports: [FormsModule],
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

    setInferiores(value: number): void {
        this.setCount(value, this.inferiorOptions, this.inferiores);
    }

    setSuperiores(value: number): void {
        this.setCount(value, this.superiorOptions, this.superiores);
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
        value: number,
        allowed: number[],
        target: ReturnType<typeof signal<number>>,
    ): void {
        if (allowed.includes(value)) {
            target.set(value);
        }
    }
}
