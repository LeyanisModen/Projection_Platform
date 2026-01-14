import { Modulo } from "./modulo";

export interface Proyecto {
    id: number;
    nombre: string;
    modulos: Modulo[]
}
