import { PlanificacionProyecto, Proyecto } from '../services/api.service';
import { factoryCapacity, planningIssues, planningLabel, requiredDaily, tightProjects } from './project-planning';

describe('project planning', () => {
    const project = (state: string, extra: Partial<PlanificacionProyecto> = {}): Proyecto => ({
        planificacion: {estado: state, modulos_por_dia: 3, dias_disponibles: 3, modulos_pendientes: 9, ...extra},
    } as Proyecto);
    const plan = {ritmo_ferralla: 27, capacidad_ferralla: 35, fabricacion_inicio: '2026-10-07', fabricacion_fin: '2026-10-13', margen_dias: 4};

    it('takes the factory pace from its plan instead of summing its projects', () => {
        const projects = [project('PLANIFICADO', plan), project('PLANIFICADO', plan), project('COMPLETADO')];
        expect(requiredDaily(projects)).toBe(27);
        expect(factoryCapacity(projects)).toBe(35);
    });
    it('shows when each project is made and its margin, or how many modules it is short', () => {
        expect(planningLabel(project('PLANIFICADO', plan))).toBe('Fabricación 07/10 → 13/10 · 4 días de margen');
        expect(planningLabel(project('PLANIFICADO', {...plan, fabricacion_fin: '2026-10-07', margen_dias: 1}))).toBe('Fabricación 07/10 · 1 día de margen');
        const tight = project('PLANIFICADO', {...plan, modulos_extra: 19, ultimo_dia: '2026-10-14', modulos_subidos: 0, modulos_previstos: 64});
        expect(planningLabel(tight)).toBe('Aprieta: +19 módulos para el 14/10 · 0 de 64 subidos');
        expect(tightProjects([tight, project('PLANIFICADO', plan)])).toBe(1);
    });
    it('does not invent a pace for missing or expired deadlines', () => {
        const projects = [project('SIN_FECHA'), project('VENCIDO'), project('SIN_DIAS')];
        expect(requiredDaily(projects)).toBe(0);
        expect(planningIssues(projects)).toBe(3);
        expect(planningLabel(projects[1])).toContain('9 pendientes');
    });
    it('does not flag completed or archived projects as unplanned', () => {
        expect(planningIssues([project('COMPLETADO'), project('ARCHIVADO')])).toBe(0);
        const archived = {...project('ARCHIVADO'), archivado_at: '2026-10-08T10:00:00'} as Proyecto;
        expect(planningLabel(archived)).toBe('Archivado el 08/10/2026');
    });
});
