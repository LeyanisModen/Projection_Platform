import {
    GrupoBastidorModulo,
    ModuloFase,
} from '../../../services/api.service';

export type ModuloPhaseAction = 'complete' | 'restart';

export function getModuloPhaseAction(
    modulo: GrupoBastidorModulo,
    fase: ModuloFase,
): ModuloPhaseAction {
    const completada = fase === 'INFERIOR'
        ? modulo.inferior_hecho
        : modulo.superior_hecho;
    const enCurso = fase === 'INFERIOR'
        ? modulo.inferior_en_curso
        : modulo.superior_en_curso;

    return completada || enCurso ? 'restart' : 'complete';
}
