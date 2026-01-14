import { Imagen } from "./imagen";

export interface Mesa {
    id: number;
    nombre: string;
    tipo: string;
    imagenes: Imagen[];
}
