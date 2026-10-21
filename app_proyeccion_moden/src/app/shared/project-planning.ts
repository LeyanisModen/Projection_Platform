import { PlanificacionProyecto, Proyecto } from '../services/api.service';

const ddmm = (iso?: string | null): string => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '';

function plan(projects: Proyecto[]): PlanificacionProyecto | undefined {
    return projects.find(p => p.planificacion?.ritmo_ferralla != null)?.planificacion;
}

/** Ritmo necesario hoy: modulos por dia laborable del tramo en curso. */
export function requiredDaily(projects: Proyecto[]): number {
    return plan(projects)?.ritmo_ferralla ?? 0;
}

const ritmo = (valor: number): string => Number.isInteger(valor) ? String(valor) : valor.toLocaleString('es-ES', { maximumFractionDigits: 1 });

/** "29 módulos/día hasta el 19/11 · después 21,3/día": los tramos que exigen los montajes. */
export function planningPace(projects: Proyecto[]): string {
    const tramos = plan(projects)?.tramos_ferralla ?? [];
    if (!tramos.length) return 'Sin montajes por delante';
    const [primero, ...resto] = tramos;
    const base = `${ritmo(primero.ritmo)} módulos/día hasta el ${ddmm(primero.hasta)}`;
    return resto.length ? `${base} · después ${ritmo(resto[0].ritmo)}/día` : base;
}

/** Forjados en la cola de las lineas por delante de otro que monta antes. */
export function queueOutOfOrder(projects: Proyecto[]): string[] {
    return plan(projects)?.cola_fuera_de_orden ?? [];
}

export function planningIssues(projects: Proyecto[]): number {
    return projects.filter(p => p.planificacion && !['PLANIFICADO','COMPLETADO','ARCHIVADO'].includes(p.planificacion.estado)).length;
}

export function planningMargin(margen: number | null | undefined): string {
    if (!margen) return 'sin holgura';
    return margen === 1 ? '1 día de holgura' : `${margen} días de holgura`;
}

/** "Fabricación 07/10 → 13/10" al ritmo que exigen los montajes. */
export function planningWindow(plan: PlanificacionProyecto): string {
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
                : `${planningWindow(plan)} · ${planningMargin(plan.margen_dias)}`;
            const previstos = plan.modulos_previstos || 0;
            const subidos = plan.modulos_subidos ?? 0;
            return previstos > subidos ? `${base} · ${subidos} de ${previstos} subidos` : base;
        }
        case 'COMPLETADO': return 'Fabricación completada';
        case 'ARCHIVADO': {
            const fecha = project.archivado_at ? new Date(project.archivado_at) : null;
            return fecha ? `Archivado el ${fecha.toLocaleDateString('es-ES', {day: '2-digit', month: '2-digit', year: 'numeric'})}` : 'Archivado';
        }
        case 'SIN_MODULOS': return 'Pendiente de cargar módulos';
        case 'SIN_FERRALLA': return 'Falta asignar una ferralla';
        case 'VENCIDO': return `Plazo vencido · ${plan.modulos_pendientes} pendientes`;
        case 'SIN_DIAS': return `Sin días disponibles · ${plan.modulos_pendientes} pendientes`;
        default: return 'Falta fecha de montaje';
    }
}
