import {
    filterCompletedPreviewGroups,
    previewIndexToBastidorIndex,
} from './project-table-preview.component';
import {
    ProyectoMesaPreviewModulo,
    ProyectoMesaPreviewQueue,
} from '../../../services/api.service';

describe('previewIndexToBastidorIndex', () => {
    it('convierte el primer hueco visible en el final del orden interno', () => {
        expect(previewIndexToBastidorIndex(2, 0)).toBe(2);
    });

    it('convierte el ultimo hueco visible en el inicio del orden interno', () => {
        expect(previewIndexToBastidorIndex(2, 2)).toBe(0);
    });

    it('limita indices fuera del rango del bastidor', () => {
        expect(previewIndexToBastidorIndex(3, -4)).toBe(3);
        expect(previewIndexToBastidorIndex(3, 20)).toBe(0);
    });
});

describe('filterCompletedPreviewGroups', () => {
    const modulo = (
        id: number,
        groupId: number,
        estado: ProyectoMesaPreviewModulo['estado'],
    ): ProyectoMesaPreviewModulo => ({
        id,
        nombre: `M-${id}`,
        tipo_modulo: 'CENTRAL',
        estado,
        tiene_sd: false,
        position: id,
        group_id: groupId,
        group_index: groupId,
        group_name: `Grupo ${groupId}`,
    });

    const completed = modulo(1, 1, 'COMPLETADO');
    const closed = modulo(2, 1, 'CERRADO');
    const completedInsidePendingGroup = modulo(3, 2, 'COMPLETADO');
    const pending = modulo(4, 2, 'PENDIENTE');
    const queues: ProyectoMesaPreviewQueue[] = [
        {
            key: 'INF-1',
            nombre: 'Mesa inferior 1',
            tipo: 'INFERIOR',
            indice: 1,
            modulos: [completed, closed, completedInsidePendingGroup, pending],
        },
        {
            key: 'SUP-1',
            nombre: 'Mesa superior 1',
            tipo: 'SUPERIOR',
            indice: 1,
            modulos: [completed, closed, completedInsidePendingGroup, pending],
        },
    ];

    it('keeps every group when the checkbox is enabled', () => {
        expect(filterCompletedPreviewGroups(queues, true)).toBe(queues);
    });

    it('hides only fully completed groups in both phases', () => {
        const filtered = filterCompletedPreviewGroups(queues, false);

        expect(filtered[0].modulos.map(item => item.id)).toEqual([3, 4]);
        expect(filtered[1].modulos.map(item => item.id)).toEqual([3, 4]);
    });
});
