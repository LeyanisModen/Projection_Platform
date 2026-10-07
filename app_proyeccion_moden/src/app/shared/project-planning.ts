import { PlanificacionProyecto, Proyecto } from '../services/api.service';

const ddmm = (iso?: string | null): string => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '';

function plan(projects: Proyecto[]): PlanificacionProyecto | undefined {
    return projects.find(p => p.planificacion?.ritmo_ferralla != null)?.planificacion;
}

/** Ritmo necesario de la ferralla: sus pendientes entre los dias hasta el ultimo montaje. */
export function requiredDaily(projects: Proyecto[]): number {
    return plan(projects)?.ritmo_ferralla ?? 0;
}

/** Modulos por dia que se espera que saque la ferralla. */
export function factoryCapacity(projects: Proyecto[]): number | null {
    return plan(projects)?.capacidad_ferralla ?? null;
}

/** Proyectos que no salen a la capacidad de la ferralla. */
export function tightProjects(projects: Proyecto[]): number {
    return projects.filter(planningTight).length;
}

export function planningTight(project: Proyecto): boolean {
    return (project.planificacion?.modulos_extra || 0) > 0;
}

export function planningIssues(projects: Proyecto[]): number {
    return projects.filter(p => p.planificacion && !['PLANIFICADO','COMPLETADO'].includes(p.planificacion.estado)).length;
}

export function planningMargin(margen: number | null | undefined): string {
    if (!margen) return 'sin margen';
    return margen === 1 ? '1 día de margen' : `${margen} días de margen`;
}

/** "Fabricación 07/10 → 13/10" o, si no llega, cuanto le falta y para cuando. */
export function planningWindow(plan: PlanificacionProyecto): string {
    if (plan.modulos_extra) return `Aprieta: +${plan.modulos_extra} módulos para el ${ddmm(plan.ultimo_dia)}`;
    const inicio = ddmm(plan.fabricacion_inicio);
    const fin = ddmm(plan.fabricacion_fin);
    return fin && fin !== inicio ? `Fabricación ${inicio} → ${fin}` : `Fabricación ${inicio}`;
}

export function planningLabel(project: Proyecto): string {
    const plan = project.planificacion;
    if (!plan) return 'Sin planificación';
    switch (plan.estado) {
        case 'PLANIFICADO': {
            const base = !plan.fabricacion_inicio
                ? `${plan.modulos_por_dia} módulos/día · ${plan.dias_disponibles} días disponibles`
                : plan.modulos_extra
                    ? planningWindow(plan)
                    : `${planningWindow(plan)} · ${planningMargin(plan.margen_dias)}`;
            const previstos = plan.modulos_previstos || 0;
            const subidos = plan.modulos_subidos ?? 0;
            return previstos > subidos ? `${base} · ${subidos} de ${previstos} subidos` : base;
        }
        case 'COMPLETADO': return 'Fabricación completada';
        case 'SIN_MODULOS': return 'Pendiente de cargar módulos';
        case 'SIN_FERRALLA': return 'Falta asignar una ferralla';
        case 'VENCIDO': return `Plazo vencido · ${plan.modulos_pendientes} pendientes`;
        case 'SIN_DIAS': return `Sin días disponibles · ${plan.modulos_pendientes} pendientes`;
        default: return 'Falta fecha de montaje';
    }
}
