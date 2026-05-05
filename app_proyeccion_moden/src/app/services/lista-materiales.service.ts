import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export type OrigenCheck = 'PROYECTO' | 'GENERAL' | null;

export type GrupoMaterial = 'consumibles' | 'barras' | 'elementos';

export interface RenglonLista {
    clave: string;
    etiqueta: string;
    unidad: string;
    total: number;
    pendiente: number;
    informado: boolean;
    origen: OrigenCheck;
    agrupable: boolean;
    grupo: GrupoMaterial;
}

export interface ListaMaterialesProyecto {
    proyecto_id: number;
    proyecto_nombre: string;
    renglones: RenglonLista[];
}

export interface RenglonGeneralAgrupado {
    clave: string;
    etiqueta: string;
    unidad: string;
    grupo: GrupoMaterial;
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

export interface ListaMaterialesGeneral {
    agrupados: RenglonGeneralAgrupado[];
    por_proyecto: BloqueGeneralPorProyecto[];
}

@Injectable({ providedIn: 'root' })
export class ListaMaterialesService {
    private proyectoUrl = '/api/proyectos/';
    private generalUrl = '/api/lista-materiales/general/';

    constructor(private http: HttpClient) { }

    private getHeaders(): HttpHeaders {
        const token = localStorage.getItem('auth_token');
        let headers = new HttpHeaders();
        if (token) {
            headers = headers.set('Authorization', `Token ${token}`);
        }
        return headers;
    }

    getListaProyecto(proyectoId: number): Observable<ListaMaterialesProyecto> {
        return this.http.get<ListaMaterialesProyecto>(
            `${this.proyectoUrl}${proyectoId}/lista-materiales/`,
            { headers: this.getHeaders() },
        );
    }

    setInformadoProyecto(
        proyectoId: number,
        clave: string,
        informado: boolean,
    ): Observable<RenglonLista> {
        return this.http.patch<RenglonLista>(
            `${this.proyectoUrl}${proyectoId}/lista-materiales/${encodeURIComponent(clave)}/`,
            { informado },
            { headers: this.getHeaders() },
        );
    }

    getListaGeneral(): Observable<ListaMaterialesGeneral> {
        return this.http.get<ListaMaterialesGeneral>(
            this.generalUrl,
            { headers: this.getHeaders() },
        );
    }

    setInformadoGeneral(clave: string, informado: boolean): Observable<ListaMaterialesGeneral> {
        return this.http.patch<ListaMaterialesGeneral>(
            `${this.generalUrl}${encodeURIComponent(clave)}/`,
            { informado },
            { headers: this.getHeaders() },
        );
    }
}
