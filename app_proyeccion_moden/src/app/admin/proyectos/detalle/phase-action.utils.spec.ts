import { GrupoBastidorModulo } from '../../../services/api.service';
import { getModuloPhaseAction } from './phase-action.utils';

function modulo(overrides: Partial<GrupoBastidorModulo> = {}): GrupoBastidorModulo {
    return {
        id: 1,
        nombre: 'A01',
        ancho_cm: '18',
        tipo_modulo: 'CENTRAL',
        estado: 'PENDIENTE',
        completado_at: null,
        inferior_hecho: false,
        superior_hecho: false,
        cerrado: false,
        fotos_count: 0,
        tiene_sd: false,
        ...overrides,
    };
}

describe('getModuloPhaseAction', () => {
    it('completa una fase realmente pendiente', () => {
        expect(getModuloPhaseAction(modulo(), 'INFERIOR')).toBe('complete');
    });

    it('reinicia directamente una fase en curso', () => {
        const item = modulo({ inferior_en_curso: true });

        expect(getModuloPhaseAction(item, 'INFERIOR')).toBe('restart');
        expect(getModuloPhaseAction(item, 'SUPERIOR')).toBe('complete');
    });

    it('reinicia una fase terminada', () => {
        const item = modulo({ superior_hecho: true });

        expect(getModuloPhaseAction(item, 'SUPERIOR')).toBe('restart');
    });
});
