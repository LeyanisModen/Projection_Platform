import { Imagen } from "./imagen";

export interface Modulo {
    id: number;
    nombre: string;
    planta: string;
    imagenes: Imagen[]
}
