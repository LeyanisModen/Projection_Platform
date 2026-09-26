import { Proyecto } from '../services/api.service';

export function requiredDaily(projects: Proyecto[]): number {
    return projects.reduce((sum, p) => sum + (p.planificacion?.modulos_por_dia || 0), 0);
}

export function planningIssues(projects: Proyecto[]): number {
    return projects.filter(p => p.planificacion && !['PLANIFICADO','COMPLETADO'].includes(p.planificacion.estado)).length;
}

export function planningLabel(project: Proyecto): string {
    const plan = project.planificacion;
    if (!plan) return 'Sin planificación';
    switch (plan.estado) {
        case 'PLANIFICADO': {
            const base = `${plan.modulos_por_dia} módulos/día · ${plan.dias_disponibles} días disponibles`;
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
