import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { delay, map, take } from 'rxjs/operators';

export type OrigenCheck = 'PROYECTO' | 'GENERAL' | null;

export interface RenglonLista {
    clave: string;
    etiqueta: string;
    unidad: string;
    total: number;
    pendiente: number;
    informado: boolean;
    origen: OrigenCheck;
    agrupable: boolean;
}

export interface ListaCompraProyecto {
    proyecto_id: number;
    proyecto_nombre: string;
    renglones: RenglonLista[];
}

export interface RenglonGeneralAgrupado {
    clave: string;
    etiqueta: string;
    unidad: string;
    total: number;
    pendiente: number;
    informado_total: number;
    proyectos_count: number;
    todos_marcados: boolean;
}

export interface BloqueGeneralPorProyecto {
    proyecto_id: number;
    proyecto_nombre: string;
    renglones: RenglonLista[];
}

export interface ListaCompraGeneral {
    agrupados: RenglonGeneralAgrupado[];
    por_proyecto: BloqueGeneralPorProyecto[];
}

interface MockRenglonProyecto {
    proyectoId: number;
    proyectoNombre: string;
    clave: string;
    etiqueta: string;
    unidad: string;
    total: number;
    pendiente: number;
    informado: boolean;
    origen: OrigenCheck;
    agrupable: boolean;
}

const MOCK_LATENCY_MS = 200;

const COLORES: Array<{ clave: string; etiqueta: string }> = [
    { clave: 'yellow', etiqueta: 'amarilla' },
    { clave: 'green', etiqueta: 'verde' },
    { clave: 'cyan', etiqueta: 'cian' },
    { clave: 'violet', etiqueta: 'violeta' },
    { clave: 'magenta', etiqueta: 'magenta' },
    { clave: 'orange', etiqueta: 'naranja' },
];

@Injectable({ providedIn: 'root' })
export class ListaCompraService {
    private estado$ = new BehaviorSubject<MockRenglonProyecto[]>([]);
    private proyectosRegistrados = new Set<number>();

    /**
     * El dashboard llama aquí con los proyectos cargados del usuario logueado.
     * Para cada proyecto nuevo, se generan renglones sintéticos pero estables
     * (deterministas por id) que viven sólo en memoria del cliente. Al conectar
     * el backend real este método desaparece y los datos vienen del endpoint.
     */
    registerProyectos(proyectos: Array<{ id: number; nombre: string }>): void {
        const rows = [...this.estado$.value];
        let dirty = false;
        for (const p of proyectos) {
            if (this.proyectosRegistrados.has(p.id)) continue;
            this.proyectosRegistrados.add(p.id);
            rows.push(...this.generateRowsForProject(p.id, p.nombre));
            dirty = true;
        }
        if (dirty) {
            this.estado$.next(rows);
        }
    }

    getListaProyecto(proyectoId: number): Observable<ListaCompraProyecto> {
        return this.estado$.pipe(
            take(1),
            map((rows) => {
                const propios = rows.filter((r) => r.proyectoId === proyectoId);
                const nombre = propios[0]?.proyectoNombre ?? `Proyecto ${proyectoId}`;
                return {
                    proyecto_id: proyectoId,
                    proyecto_nombre: nombre,
                    renglones: propios.map((r) => this.toRenglon(r)),
                };
            }),
            delay(MOCK_LATENCY_MS),
        );
    }

    setInformadoProyecto(
        proyectoId: number,
        clave: string,
        informado: boolean,
    ): Observable<RenglonLista> {
        const rows = [...this.estado$.value];
        const idx = rows.findIndex((r) => r.proyectoId === proyectoId && r.clave === clave);
        if (idx === -1) {
            return of(null as unknown as RenglonLista).pipe(delay(MOCK_LATENCY_MS));
        }
        rows[idx] = {
            ...rows[idx],
            informado,
            origen: informado ? 'PROYECTO' : null,
        };
        this.estado$.next(rows);
        return of(this.toRenglon(rows[idx])).pipe(delay(MOCK_LATENCY_MS));
    }

    getListaGeneral(): Observable<ListaCompraGeneral> {
        return this.estado$.pipe(
            take(1),
            map((rows) => this.buildGeneral(rows)),
            delay(MOCK_LATENCY_MS),
        );
    }

    setInformadoGeneral(clave: string, informado: boolean): Observable<ListaCompraGeneral> {
        const rows = this.estado$.value.map((r) => {
            if (r.clave !== clave || !r.agrupable) {
                return r;
            }
            if (informado) {
                if (r.informado) {
                    return r;
                }
                return { ...r, informado: true, origen: 'GENERAL' as OrigenCheck };
            }
            if (r.origen === 'GENERAL') {
                return { ...r, informado: false, origen: null as OrigenCheck };
            }
            return r;
        });
        this.estado$.next(rows);
        return of(this.buildGeneral(rows)).pipe(delay(MOCK_LATENCY_MS));
    }

    private buildGeneral(rows: MockRenglonProyecto[]): ListaCompraGeneral {
        const agrupablesByClave = new Map<string, MockRenglonProyecto[]>();
        const especificosByProyecto = new Map<number, MockRenglonProyecto[]>();

        for (const r of rows) {
            if (r.agrupable) {
                const list = agrupablesByClave.get(r.clave) ?? [];
                list.push(r);
                agrupablesByClave.set(r.clave, list);
            } else {
                const list = especificosByProyecto.get(r.proyectoId) ?? [];
                list.push(r);
                especificosByProyecto.set(r.proyectoId, list);
            }
        }

        const agrupados: RenglonGeneralAgrupado[] = [];
        for (const [clave, list] of agrupablesByClave) {
            const total = list.reduce((acc, r) => acc + r.total, 0);
            const pendiente = list.reduce((acc, r) => acc + r.pendiente, 0);
            const informadoTotal = list
                .filter((r) => r.informado)
                .reduce((acc, r) => acc + r.total, 0);
            agrupados.push({
                clave,
                etiqueta: list[0].etiqueta,
                unidad: list[0].unidad,
                total,
                pendiente,
                informado_total: informadoTotal,
                proyectos_count: list.length,
                todos_marcados: list.every((r) => r.informado),
            });
        }
        agrupados.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));

        const por_proyecto: BloqueGeneralPorProyecto[] = [];
        for (const [proyectoId, list] of especificosByProyecto) {
            por_proyecto.push({
                proyecto_id: proyectoId,
                proyecto_nombre: list[0].proyectoNombre,
                renglones: list.map((r) => this.toRenglon(r)),
            });
        }
        por_proyecto.sort((a, b) => a.proyecto_nombre.localeCompare(b.proyecto_nombre));

        return { agrupados, por_proyecto };
    }

    private toRenglon(r: MockRenglonProyecto): RenglonLista {
        return {
            clave: r.clave,
            etiqueta: r.etiqueta,
            unidad: r.unidad,
            total: r.total,
            pendiente: r.pendiente,
            informado: r.informado,
            origen: r.origen,
            agrupable: r.agrupable,
        };
    }

    private generateRowsForProject(
        proyectoId: number,
        proyectoNombre: string,
    ): MockRenglonProyecto[] {
        const seed = hashStr(`p${proyectoId}`);
        const rng = mulberry32(seed);
        const nModulos = 8 + Math.floor(rng() * 20); // 8..27 módulos

        const rows: MockRenglonProyecto[] = [];
        const push = (
            clave: string,
            etiqueta: string,
            unidad: string,
            total: number,
            agrupable: boolean,
        ) => {
            const pendienteRatio = 0.5 + rng() * 0.5; // 50%–100% pendiente
            const pendiente = round2(total * pendienteRatio);
            rows.push({
                proyectoId,
                proyectoNombre,
                clave,
                etiqueta,
                unidad,
                total: round2(total),
                pendiente,
                informado: false,
                origen: null,
                agrupable,
            });
        };

        // Refuerzos por diámetro (agrupable)
        push('refuerzo_d8', 'Refuerzo Ø8', 'm', nModulos * (10 + rng() * 8), true);
        push('refuerzo_d10', 'Refuerzo Ø10', 'm', nModulos * (12 + rng() * 10), true);
        if (rng() > 0.4) {
            push('refuerzo_d12', 'Refuerzo Ø12', 'm', nModulos * (6 + rng() * 6), true);
        }

        // Separadores por ancho (agrupable, genéricos)
        const anchos = [15, 20, 25].filter(() => rng() > 0.3);
        const anchosFinal = anchos.length > 0 ? anchos : [20];
        for (const ancho of anchosFinal) {
            push(`separador_a${ancho}`, `Separador ancho ${ancho}`, 'ud', nModulos * (3 + rng() * 5), true);
        }

        // Mallazos (constantes: 1 por fase)
        push('mallazo_inf', 'Mallazo inferior', 'ud', nModulos, true);
        push('mallazo_sup', 'Mallazo superior', 'ud', nModulos, true);

        // Piezas bastidor (constantes: 4 por fase)
        push('pieza_bastidor_inf', 'Pieza bastidor inferior', 'ud', nModulos * 4, true);
        push('pieza_bastidor_sup', 'Pieza bastidor superior', 'ud', nModulos * 4, true);

        // Cintas de color (sólo SUP, 0.25 m por marca; aprox 1-3 colores por proyecto)
        const numColores = 1 + Math.floor(rng() * 3);
        const coloresMezclados = [...COLORES].sort(() => rng() - 0.5).slice(0, numColores);
        for (const color of coloresMezclados) {
            push(
                `cinta_${color.clave}`,
                `Cinta ${color.etiqueta}`,
                'm',
                nModulos * 0.25 * (1 + Math.floor(rng() * 4)), // 1-4 marcas por módulo
                true,
            );
        }

        // Zunchos (específicos por proyecto, no agrupables)
        const tiposZuncho = ['z1', 'z25'];
        if (rng() > 0.5) tiposZuncho.push('z3');
        for (const tipo of tiposZuncho) {
            push(`zuncho_${tipo}`, `Zuncho ${tipo.toUpperCase()}`, 'm', nModulos * (3 + rng() * 4), false);
        }

        // Punzos (específicos por proyecto, no agrupables)
        const tiposPunzo = rng() > 0.5 ? ['p1'] : ['p1', 'p2'];
        for (const tipo of tiposPunzo) {
            push(`punzo_${tipo}`, `Punzo ${tipo.toUpperCase()}`, 'ud', nModulos * (1 + rng() * 2), false);
        }

        return rows;
    }
}

function hashStr(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
