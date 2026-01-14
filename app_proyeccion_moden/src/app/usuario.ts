import { Mesa } from "./mesa";
import { Proyecto } from "./proyecto";

export interface Usuario {
    id: number;
    nombre: string;
    mesa: Mesa;
    proyectos: Proyecto[];
}
