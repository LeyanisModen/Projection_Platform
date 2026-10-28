import { Proyecto } from '../services/api.service';

export interface GrupoEdificio {
    clave: string;
    /** null: proyectos sin edificio. */
    id: number | null;
    nombre: string;
    proyectos: Proyecto[];
}

const porNombre = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/**
 * Proyectos agrupados por edificio: los edificios por nombre y sus forjados
 * de abajo arriba (sotanos, baja, plantas, cubierta, casetones). Los que no
 * tienen edificio van al final, en el orden en que llegan.
 */
export function agruparPorEdificio(proyectos: Proyecto[]): GrupoEdificio[] {
    const grupos = new Map<number, GrupoEdificio>();
    const sueltos: Proyecto[] = [];
    for (const proyecto of proyectos) {
        if (proyecto.edificio == null) { sueltos.push(proyecto); continue; }
        let grupo = grupos.get(proyecto.edificio);
        if (!grupo) {
            grupo = { clave: `e${proyecto.edificio}`, id: proyecto.edificio, nombre: proyecto.edificio_nombre || 'Edificio', proyectos: [] };
            grupos.set(proyecto.edificio, grupo);
        }
        grupo.proyectos.push(proyecto);
    }
    const lista = [...grupos.values()].sort((a, b) => porNombre.compare(a.nombre, b.nombre));
    for (const grupo of lista) {
        grupo.proyectos.sort((a, b) => (a.orden_planta ?? 9999) - (b.orden_planta ?? 9999) || porNombre.compare(a.nombre, b.nombre));
    }
    if (sueltos.length) lista.push({ clave: 'sueltos', id: null, nombre: 'Otros proyectos', proyectos: sueltos });
    return lista;
}

export function ordenarPorEdificio(proyectos: Proyecto[]): Proyecto[] {
    return agruparPorEdificio(proyectos).flatMap(grupo => grupo.proyectos);
}

const SIN_PLANTA = 9999;
const diaMes = (iso: string) => { const [, mes, dia] = iso.split('-'); return `${dia}/${mes}`; };

/**
 * Un edificio se monta de abajo arriba. Si con ``fecha`` el forjado se
 * montaria antes que una planta de debajo o despues que una de encima, el
 * aviso con la mas cercana (suele ser una errata); null si encaja. De las
 * otras plantas cuenta la fecha que manda: la de montaje en obra o, sin
 * ella, la orientativa.
 */
export function avisoOrdenDePlantas(proyecto: Proyecto, fecha: string, otros: Proyecto[]): string | null {
    const orden = proyecto.orden_planta ?? SIN_PLANTA;
    if (proyecto.edificio == null || orden >= SIN_PLANTA) return null;
    let choque: { otro: Proyecto; fecha: string; distancia: number } | null = null;
    for (const otro of otros) {
        const otroOrden = otro.orden_planta ?? SIN_PLANTA;
        const otraFecha = otro.fecha_montaje_obra || otro.fecha_montaje;
        if (otro.id === proyecto.id || otro.edificio !== proyecto.edificio || otroOrden >= SIN_PLANTA || !otraFecha) continue;
        const fuera = otroOrden < orden ? otraFecha > fecha : otroOrden > orden && otraFecha < fecha;
        const distancia = Math.abs(otroOrden - orden);
        if (fuera && (!choque || distancia < choque.distancia)) choque = { otro, fecha: otraFecha, distancia };
    }
    if (!choque) return null;
    const debajo = (choque.otro.orden_planta ?? SIN_PLANTA) < orden;
    const otraEtiqueta = choque.otro.planta_etiqueta || choque.otro.nombre;
    const orientativa = choque.otro.fecha_montaje_obra ? '' : ', orientativa';
    return `La ${proyecto.planta_etiqueta || proyecto.nombre} se montaría el ${diaMes(fecha)}, `
        + `${debajo ? 'antes que' : 'después de'} la ${otraEtiqueta} (${diaMes(choque.fecha)}${orientativa}), `
        + `que va ${debajo ? 'debajo' : 'encima'}.`;
}
