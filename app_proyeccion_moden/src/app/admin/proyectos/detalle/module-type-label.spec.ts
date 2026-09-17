import { describe, expect, it } from 'vitest';

import { ProyectoDetailComponent } from './detalle.component';
import { ProjectTablePreviewComponent } from './project-table-preview.component';
import { ProyectoMesaPreviewModulo, TipoModulo } from '../../../services/api.service';

/**
 * La abreviatura del tipo de modulo se muestra en dos sitios (detalle y
 * simulador de mesas) y tiene que coincidir en ambos. 'CENTRAL_GIRADO' usa
 * 'G' a secas: ningun otro tipo empieza por G.
 */
const ESPERADO: Array<[TipoModulo, string]> = [
    ['CENTRAL', 'C'],
    ['CENTRAL_GIRADO', 'G'],
    ['LADO_LARGO', 'LL'],
    ['LADO_CORTO', 'LC'],
    ['ESQUINA', 'E'],
    ['', ''],
];

describe('abreviatura del tipo de modulo', () => {
    const detalle = Object.create(ProyectoDetailComponent.prototype) as ProyectoDetailComponent;
    const preview = Object.create(ProjectTablePreviewComponent.prototype) as ProjectTablePreviewComponent;
    const asModulo = (tipo: TipoModulo) => ({ tipo_modulo: tipo } as ProyectoMesaPreviewModulo);

    it.each(ESPERADO)('el detalle abrevia %s como "%s"', (tipo, esperado) => {
        expect(detalle.tipoModuloLabel(tipo)).toBe(esperado);
    });

    it.each(ESPERADO)('el simulador abrevia %s como "%s"', (tipo, esperado) => {
        expect(preview.tipoModuloLabel(asModulo(tipo))).toBe(esperado);
    });

    it('ninguna abreviatura que no sea la de girado empieza por G', () => {
        const otras = ESPERADO
            .filter(([tipo]) => tipo !== 'CENTRAL_GIRADO')
            .map(([, abreviatura]) => abreviatura);
        expect(otras.some(a => a.startsWith('G'))).toBe(false);
    });

    it('el simulador expone el nombre completo para el tooltip', () => {
        expect(preview.tipoModuloFullLabel(asModulo('CENTRAL_GIRADO'))).toBe('Central girado');
        expect(detalle.tipoModuloFullLabel('CENTRAL_GIRADO')).toBe('Central girado');
    });
});
