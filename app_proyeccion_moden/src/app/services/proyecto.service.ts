import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Proyecto {
    id: number;
    url: string;
    nombre: string;
    usuario_id: string;
}

@Injectable({
    providedIn: 'root'
})
export class ProyectoService {
    private apiUrl = '/api/proyectos/';

    constructor(private http: HttpClient) { }

    private getHeaders(): HttpHeaders {
        // No auth required
        return new HttpHeaders({});
    }

    getProyectos(): Observable<Proyecto[]> {
        return this.http.get<Proyecto[]>(this.apiUrl, { headers: this.getHeaders() });
    }

    getProyecto(id: number): Observable<Proyecto> {
        return this.http.get<Proyecto>(`${this.apiUrl}${id}/`, { headers: this.getHeaders() });
    }
}
