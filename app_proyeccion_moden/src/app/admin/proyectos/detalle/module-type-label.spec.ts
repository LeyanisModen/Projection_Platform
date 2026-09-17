import { describe, expect, it } from 'vitest';

import { ProyectoDetailComponent } from './detalle.component';
import { TipoModulo } from '../../../services/api.service';

/**
 * Abreviatura del tipo de modulo tal como se muestra junto al nombre en el
 * detalle del proyecto. 'CENTRAL_GIRADO' usa 'G' a secas: ningun otro tipo
 * empieza por G.
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

    it.each(ESPERADO)('abrevia %s como "%s"', (tipo, esperado) => {
        expect(detalle.tipoModuloLabel(tipo)).toBe(esperado);
    });

    it('ninguna abreviatura que no sea la de girado empieza por G', () => {
        const otras = ESPERADO
            .filter(([tipo]) => tipo !== 'CENTRAL_GIRADO')
            .map(([, abreviatura]) => abreviatura);
        expect(otras.some(a => a.startsWith('G'))).toBe(false);
    });

    it('expone el nombre completo para el tooltip', () => {
        expect(detalle.tipoModuloFullLabel('CENTRAL_GIRADO')).toBe('Central girado');
        expect(detalle.tipoModuloFullLabel('')).toBe('Sin tipo');
    });
});
