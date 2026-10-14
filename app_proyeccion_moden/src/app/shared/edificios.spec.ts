import { Proyecto } from '../services/api.service';
import { agruparPorEdificio, ordenarPorEdificio } from './edificios';

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
});
