import { PlanificacionProyecto, Proyecto } from '../services/api.service';
import { planningIssues, planningLabel, planningPace, queueOutOfOrder, requiredDaily } from './project-planning';

describe('project planning', () => {
    const project = (state: string, extra: Partial<PlanificacionProyecto> = {}): Proyecto => ({
        planificacion: {estado: state, modulos_por_dia: 3, dias_disponibles: 3, modulos_pendientes: 9, ...extra},
    } as Proyecto);
    const plan = {
        ritmo_ferralla: 29, tramos_ferralla: [{hasta: '2026-11-19', ritmo: 29}, {hasta: '2026-11-27', ritmo: 21.3}],
        cola_fuera_de_orden: ['ESNABIDE_27_P3'], fabricacion_inicio: '2026-10-07', fabricacion_fin: '2026-10-13', margen_dias: 4,
    };

    it('takes the factory pace from the tramos that the mountings demand', () => {
        const projects = [project('PLANIFICADO', plan), project('PLANIFICADO', plan), project('COMPLETADO')];
        expect(requiredDaily(projects)).toBe(29);
        expect(planningPace(projects)).toBe('29 módulos/día hasta el 19/11 · después 21,3/día');
        expect(planningPace([project('PLANIFICADO', {...plan, tramos_ferralla: [{hasta: '2026-11-19', ritmo: 12.5}]})])).toBe('12,5 módulos/día hasta el 19/11');
        expect(planningPace([project('COMPLETADO')])).toBe('Sin montajes por delante');
        expect(queueOutOfOrder(projects)).toEqual(['ESNABIDE_27_P3']);
    });
    it('shows when each project is made and its slack', () => {
        expect(planningLabel(project('PLANIFICADO', plan))).toBe('Fabricación 07/10 → 13/10 · 4 días de holgura');
        expect(planningLabel(project('PLANIFICADO', {...plan, fabricacion_fin: '2026-10-07', margen_dias: 1}))).toBe('Fabricación 07/10 · 1 día de holgura');
        const sinHolgura = project('PLANIFICADO', {...plan, margen_dias: 0, modulos_subidos: 0, modulos_previstos: 64});
        expect(planningLabel(sinHolgura)).toBe('Fabricación 07/10 → 13/10 · sin holgura · 0 de 64 subidos');
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
