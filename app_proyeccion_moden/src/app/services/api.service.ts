import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map } from 'rxjs';

// =============================================================================
// INTERFACES
// =============================================================================

// DRF paginated response wrapper
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
    usuario: string;
}

export interface Planta {
    id: number;
    nombre: string;
    proyecto: number;
    orden: number;
    modulos_count: number;
}

export interface Modulo {
    id: number;
    url: string;
    nombre: string;
    planta: number | null;
    proyecto: string;
    inferior_hecho: boolean;
    superior_hecho: boolean;
    estado: 'PENDIENTE' | 'EN_PROGRESO' | 'COMPLETADO' | 'CERRADO';
    cerrado: boolean;
    cerrado_at: string | null;
    cerrado_by: string | null;
}

export interface Imagen {
    id: number;
    url: string;
    src: string;
    nombre: string;
    modulo: string;
    fase: 'INFERIOR' | 'SUPERIOR';
    orden: number;
    version: number;
    activo: boolean;
}

export interface Mesa {
    id: number;
    url: string;
    nombre: string;
    usuario: string;
    imagen_actual: string | null;
    imagen: Imagen | null;
    ultima_actualizacion: string;
    locked: boolean;
    blackout: boolean;
    last_seen: string | null;
}

export interface ModuloQueue {
    id: number;
    proyecto: string;
    created_at: string;
    created_by: string | null;
    activa: boolean;
}

export interface ModuloQueueItem {
    id: number;
    queue: string;
    modulo: string;
    modulo_nombre: string;
    modulo_planta: string;
    position: number;
    added_by: string | null;
    created_at: string;
}

export interface MesaQueueItem {
    id: number;
    mesa: string;
    mesa_nombre: string;
    modulo: string;
    modulo_nombre: string;
    fase: 'INFERIOR' | 'SUPERIOR';
    imagen: string;
    imagen_url: string;
    position: number;
    status: 'EN_COLA' | 'MOSTRANDO' | 'HECHO';
    assigned_by: string | null;
    assigned_at: string;
    done_by: string | null;
    done_at: string | null;
}


// =============================================================================
// API SERVICE
// =============================================================================
@Injectable({
    providedIn: 'root'
})
export class ApiService {
    private baseUrl = '/api';

    constructor(private http: HttpClient) { }

    private getHeaders(): HttpHeaders {
        // Hardcoded admin:admin for prototyping phase
        return new HttpHeaders({
            'Authorization': 'Basic YWRtaW46YWRtaW4=',
            'Content-Type': 'application/json'
        });
    }

    // =========================================================================
    // PROYECTOS (paginated)
    // =========================================================================
    getProyectos(): Observable<Proyecto[]> {
        return this.http.get<PagedResponse<Proyecto>>(`${this.baseUrl}/proyectos/`, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    getProyecto(id: number): Observable<Proyecto> {
        return this.http.get<Proyecto>(`${this.baseUrl}/proyectos/${id}/`, { headers: this.getHeaders() });
    }

    getProyectoModulos(id: number): Observable<Modulo[]> {
        return this.http.get<Modulo[]>(`${this.baseUrl}/proyectos/${id}/modulos/`, { headers: this.getHeaders() });
    }

    getProyectoQueueItems(id: number): Observable<ModuloQueueItem[]> {
        return this.http.get<ModuloQueueItem[]>(`${this.baseUrl}/proyectos/${id}/queue_items/`, { headers: this.getHeaders() });
    }

    // =========================================================================
    // PLANTAS
    // =========================================================================
    getPlantas(proyectoId: number): Observable<Planta[]> {
        return this.http.get<PagedResponse<Planta>>(`${this.baseUrl}/plantas/?proyecto=${proyectoId}`, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    // =========================================================================
    // MODULOS (paginated)
    // =========================================================================
    getModulos(plantaId?: number, proyectoId?: number): Observable<Modulo[]> {
        let url = `${this.baseUrl}/modulos/`;
        if (plantaId) {
            url += `?planta=${plantaId}`;
        } else if (proyectoId) {
            url += `?proyecto=${proyectoId}`;
        }
        return this.http.get<PagedResponse<Modulo>>(url, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    getModuloImagenes(id: number): Observable<Imagen[]> {
        return this.http.get<Imagen[]>(`${this.baseUrl}/modulos/${id}/imagenes/`, { headers: this.getHeaders() });
    }

    cerrarModulo(id: number): Observable<Modulo> {
        return this.http.post<Modulo>(`${this.baseUrl}/modulos/${id}/cerrar/`, {}, { headers: this.getHeaders() });
    }

    // =========================================================================
    // MESAS (paginated)
    // =========================================================================
    getMesas(): Observable<Mesa[]> {
        return this.http.get<PagedResponse<Mesa>>(`${this.baseUrl}/mesas/`, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    getMesa(id: number): Observable<Mesa> {
        return this.http.get<Mesa>(`${this.baseUrl}/mesas/${id}/`, { headers: this.getHeaders() });
    }

    getMesaQueueItems(id: number): Observable<MesaQueueItem[]> {
        return this.http.get<MesaQueueItem[]>(`${this.baseUrl}/mesas/${id}/queue_items/`, { headers: this.getHeaders() });
    }

    /**
     * Link a device to a Mesa using a pairing code.
     * This is used from the Dashboard to pair Mini-PCs showing a code.
     */
    pairDevice(mesaId: number, pairingCode: string): Observable<{ status: string }> {
        return this.http.post<{ status: string }>(`${this.baseUrl}/device/pair/`, {
            mesa_id: mesaId,
            pairing_code: pairingCode
        });
    }

    // =========================================================================
    // MODULO QUEUE ITEMS
    // =========================================================================
    addModuloToQueue(queueId: number, moduloId: number, position: number): Observable<ModuloQueueItem> {
        return this.http.post<ModuloQueueItem>(`${this.baseUrl}/modulo-queue-items/`, {
            queue: queueId,
            modulo: moduloId,
            position: position
        }, { headers: this.getHeaders() });
    }

    reorderModuloQueue(items: { id: number, position: number }[]): Observable<any> {
        return this.http.post(`${this.baseUrl}/modulo-queue-items/reorder/`, { items }, { headers: this.getHeaders() });
    }

    // =========================================================================
    // MESA QUEUE ITEMS
    // =========================================================================
    createMesaQueueItem(mesaId: number, moduloId: number, fase: string, imagenId: number, position: number): Observable<MesaQueueItem> {
        return this.http.post<MesaQueueItem>(`${this.baseUrl}/mesa-queue-items/`, {
            mesa: mesaId,
            modulo: moduloId,
            fase: fase,
            imagen: imagenId,
            position: position
        }, { headers: this.getHeaders() });
    }

    marcarMesaQueueItemHecho(id: number): Observable<MesaQueueItem> {
        return this.http.post<MesaQueueItem>(`${this.baseUrl}/mesa-queue-items/${id}/marcar_hecho/`, {}, { headers: this.getHeaders() });
    }

    mostrarMesaQueueItem(id: number): Observable<MesaQueueItem> {
        return this.http.post<MesaQueueItem>(`${this.baseUrl}/mesa-queue-items/${id}/mostrar/`, {}, { headers: this.getHeaders() });
    }

    reorderMesaQueue(items: { id: number, position: number }[]): Observable<any> {
        return this.http.post(`${this.baseUrl}/mesa-queue-items/reorder/`, { items }, { headers: this.getHeaders() });
    }

    deleteMesaQueueItem(id: number): Observable<void> {
        return this.http.delete<void>(`${this.baseUrl}/mesa-queue-items/${id}/`, { headers: this.getHeaders() });
    }
}
