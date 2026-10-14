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
