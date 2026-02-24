import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface PagedResponse<T> {
    count: number;
    next: string | null;
    previous: string | null;
    results: T[];
}

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
        const token = localStorage.getItem('auth_token');
        let headers = new HttpHeaders();
        if (token) {
            headers = headers.set('Authorization', `Token ${token}`);
        }
        return headers;
    }

    getProyectos(): Observable<Proyecto[]> {
        return this.http.get<PagedResponse<Proyecto>>(this.apiUrl, { headers: this.getHeaders() })
            .pipe(map((response) => response.results));
    }

    getProyecto(id: number): Observable<Proyecto> {
        return this.http.get<Proyecto>(`${this.apiUrl}${id}/`, { headers: this.getHeaders() });
    }
}
