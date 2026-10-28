import { Proyecto } from '../services/api.service';
import { agruparPorEdificio, avisoOrdenDePlantas, ordenarPorEdificio } from './edificios';

describe('edificios', () => {
    const p = (id: number, nombre: string, edificio?: number, edificioNombre?: string, orden?: number) =>
        ({ id, nombre, edificio: edificio ?? null, edificio_nombre: edificioNombre ?? null, orden_planta: orden } as Proyecto);

    it('agrupa por edificio y ordena los forjados de abajo arriba; sin edificio al final', () => {
        const proyectos = [
            p(1, 'ESN27_P1', 7, 'ESNABIDE_27', 4001), p(2, 'Suelto', undefined), p(3, 'ESN27_PB', 7, 'ESNABIDE_27', 2000),
            p(4, 'RIP_BI_P2', 9, 'RIPAGAINA108_BI', 4002), p(5, 'ESN27_S1', 7, 'ESNABIDE_27', 499),
            p(6, 'RIP_BH_P10', 8, 'RIPAGAINA108_BH', 4010), p(7, 'RIP_BH_P2', 8, 'RIPAGAINA108_BH', 4002),
        ];
        const grupos = agruparPorEdificio(proyectos);
        expect(grupos.map(g => [g.nombre, g.proyectos.map(x => x.nombre)])).toEqual([
            ['ESNABIDE_27', ['ESN27_S1', 'ESN27_PB', 'ESN27_P1']],
            ['RIPAGAINA108_BH', ['RIP_BH_P2', 'RIP_BH_P10']],
            ['RIPAGAINA108_BI', ['RIP_BI_P2']],
            ['Otros proyectos', ['Suelto']],
        ]);
        expect(grupos.at(-1)?.id).toBeNull();
        expect(ordenarPorEdificio(proyectos).map(x => x.id)).toEqual([5, 3, 1, 7, 6, 4, 2]);
    });

    it('sin edificios deja la lista como llega', () => {
        const proyectos = [p(2, 'B'), p(1, 'A')];
        expect(ordenarPorEdificio(proyectos).map(x => x.id)).toEqual([2, 1]);
    });

    describe('avisoOrdenDePlantas', () => {
        const planta = (id: number, n: number, obra: string | null, orientativa: string | null, edificio = 8) =>
            ({ id, nombre: `RIP_BH_P0${n}`, edificio, orden_planta: 4000 + n, planta_etiqueta: `P${n}`,
               fecha_montaje_obra: obra, fecha_montaje: orientativa } as Proyecto);
        // Como RIPAGAINA108_BH: la P5 y la P6 aun con la orientativa.
        const p4 = planta(4, 4, '2026-11-11', '2026-11-11');
        const p5 = planta(5, 5, null, '2026-11-19');
        const p6 = planta(6, 6, null, '2026-11-27');
        const p7 = planta(7, 7, null, '2026-12-11');
        const otroEdificio = planta(9, 2, '2026-12-30', '2026-12-30', 9);
        const todos = [p4, p5, p6, p7, otroEdificio];

        it('avisa si una planta se montaria antes que la de debajo (la errata de la P7)', () => {
            expect(avisoOrdenDePlantas(p7, '2026-11-10', todos))
                .toBe('La P7 se montaría el 10/11, antes que la P6 (27/11, orientativa), que va debajo.');
        });

        it('y si se montaria despues que una de encima', () => {
            expect(avisoOrdenDePlantas(p4, '2026-11-20', todos))
                .toBe('La P4 se montaría el 20/11, después de la P5 (19/11, orientativa), que va encima.');
        });

        it('calla si encaja, el mismo dia o sin edificio o planta', () => {
            expect(avisoOrdenDePlantas(p7, '2026-12-11', todos)).toBeNull();
            expect(avisoOrdenDePlantas(p5, '2026-11-27', todos)).toBeNull();
            expect(avisoOrdenDePlantas({ ...p7, edificio: null }, '2026-11-10', todos)).toBeNull();
            expect(avisoOrdenDePlantas({ ...p7, orden_planta: 9999 }, '2026-11-10', todos)).toBeNull();
        });
    });
});
