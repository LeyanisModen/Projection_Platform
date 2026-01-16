import { Imagen } from "./imagen";

export interface Mesa {
    id: number;
    url: string;
    nombre: string;
    usuario_id: string;
    imagen_actual: string | null;
    imagen?: Imagen;
    ultima_actualizacion: string;
}
