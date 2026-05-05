import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

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

@Injectable({ providedIn: 'root' })
export class ListaCompraService {
    private proyectoUrl = '/api/proyectos/';
    private generalUrl = '/api/lista-compra/general/';

    constructor(private http: HttpClient) { }

    private getHeaders(): HttpHeaders {
        const token = localStorage.getItem('auth_token');
        let headers = new HttpHeaders();
        if (token) {
            headers = headers.set('Authorization', `Token ${token}`);
        }
        return headers;
    }

    getListaProyecto(proyectoId: number): Observable<ListaCompraProyecto> {
        return this.http.get<ListaCompraProyecto>(
            `${this.proyectoUrl}${proyectoId}/lista-compra/`,
            { headers: this.getHeaders() },
        );
    }

    setInformadoProyecto(
        proyectoId: number,
        clave: string,
        informado: boolean,
    ): Observable<RenglonLista> {
        return this.http.patch<RenglonLista>(
            `${this.proyectoUrl}${proyectoId}/lista-compra/${encodeURIComponent(clave)}/`,
            { informado },
            { headers: this.getHeaders() },
        );
    }

    getListaGeneral(): Observable<ListaCompraGeneral> {
        return this.http.get<ListaCompraGeneral>(
            this.generalUrl,
            { headers: this.getHeaders() },
        );
    }

    setInformadoGeneral(clave: string, informado: boolean): Observable<ListaCompraGeneral> {
        return this.http.patch<ListaCompraGeneral>(
            `${this.generalUrl}${encodeURIComponent(clave)}/`,
            { informado },
            { headers: this.getHeaders() },
        );
    }
}
