import { previewIndexToBastidorIndex } from './project-table-preview.component';

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
