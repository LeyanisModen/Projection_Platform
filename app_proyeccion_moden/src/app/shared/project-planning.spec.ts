import { Proyecto } from '../services/api.service';
import { planningIssues, planningLabel, requiredDaily } from './project-planning';

describe('project planning', () => {
    const project = (state: string, daily: number | null): Proyecto => ({
        planificacion: {estado:state, modulos_por_dia:daily, dias_disponibles:3, modulos_pendientes:9},
    } as Proyecto);
    it('sums every assigned project rather than only the first', () => {
        expect(requiredDaily([project('PLANIFICADO', 3), project('PLANIFICADO', 5), project('COMPLETADO', 0)])).toBe(8);
    });
    it('does not invent a nominal capacity for missing or expired deadlines', () => {
        const projects = [project('SIN_FECHA', null), project('VENCIDO', null), project('SIN_DIAS', null)];
        expect(requiredDaily(projects)).toBe(0);
        expect(planningIssues(projects)).toBe(3);
        expect(planningLabel(projects[1])).toContain('9 pendientes');
    });
    it('does not flag completed projects as unplanned', () => {
        expect(planningIssues([project('COMPLETADO', 0)])).toBe(0);
    });
});
