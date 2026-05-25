import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map, tap } from 'rxjs';

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

export interface User {
    id: number;
    url: string;
    username: string;
    first_name: string;
    last_name: string;
    email: string;
    groups: any[];
    telefono?: string;
    direccion?: string;
    coordinador?: string;
    password_texto_plano?: string;
    capacidad_diaria_modulos?: number;
}


export interface Proyecto {
    id: number;
    url: string;
    nombre: string;
    usuario: string;
    bastidor_longitud_cm: number;
    datos_tecnicos_importados: boolean;
    capacidad_diaria_usuario?: number;
    grupos_count?: number;
    modulos_count?: number;
    modulos_completados?: number;
    modulos_completados_hoy?: number;
}

export interface GrupoBastidorModulo {
    id: number;
    nombre: string;
    ancho_cm: string | null;
    estado: 'PENDIENTE' | 'EN_PROGRESO' | 'COMPLETADO' | 'CERRADO';
    inferior_hecho: boolean;
    superior_hecho: boolean;
    cerrado: boolean;
    fotos_count: number;
}

export interface GrupoBastidor {
    id: number;
    proyecto: number;
    indice: number;
    nombre: string;
    created_at: string;
    modulos: GrupoBastidorModulo[];
}

export interface Planta {
    id: number;
    nombre: string;
    proyecto: number;
    orden: number;
    modulos_count: number;
    plano_imagen?: string;
    fichero_corte?: string;
}

export interface Modulo {
    id: number;
    url: string;
    nombre: string;
    ancho_cm: string | null;
    planta: number | null;
    proyecto: string;
    grupo_bastidor: number | null;
    inferior_hecho: boolean;
    superior_hecho: boolean;
    estado: 'PENDIENTE' | 'EN_PROGRESO' | 'COMPLETADO' | 'CERRADO';
    cerrado: boolean;
    cerrado_at: string | null;
    cerrado_by: string | null;
    codigos_color: string;
    fotos_count: number;
    detalles_fase: DetalleModuloFase[];
}

export interface DetalleModuloFase {
    id: number;
    modulo: number;
    fase: 'INFERIOR' | 'SUPERIOR';
    espesor_cm: string | null;
    peso_malla_inicial_kg: string | null;
    peso_malla_final_kg: string | null;
    desperdicio_kg: string | null;
    cantidad_cortes: number | null;
    cantidad_refuerzos: number | null;
    peso_refuerzos_kg: string | null;
    cantidad_zunchos: number | null;
    peso_zunchos_kg: string | null;
    cantidad_separadores: number | null;
    peso_separadores_kg: string | null;
    cantidad_punzos: number | null;
    peso_punzos_kg: string | null;
    dificultad_fabricacion: string | null;
    observaciones: string | null;
    capacidad_bastidor: number | null;
    peso_total_kg: string | null;
    created_at: string;
    updated_at: string;
}

export interface FotoFabricacion {
    id: number;
    modulo: number;
    modulo_nombre: string;
    planta_nombre: string | null;
    proyecto_id: number | null;
    mesa: number | null;
    mesa_nombre: string | null;
    fase: 'INFERIOR' | 'SUPERIOR';
    fase_label: string;
    paso: number;
    imagen_referencia: number | null;
    url: string;
    capturada_at: string;
    filename_original: string | null;
    file_size: number | null;
}

export interface TechnicalImportStats {
    processed: number;
    created: number;
    updated: number;
    skipped: number;
    grupos_bastidor?: number;
    errors: string[];
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
    grupo: number | null;
    tipo: MesaTipo;
    indice: number;
    activa: boolean;
    imagen_actual: string | null;
    imagen: Imagen | null;
    ultima_actualizacion: string;
    locked: boolean;
    blackout: boolean;
    last_seen: string | null;
    is_linked: boolean;
    capture_service_online?: boolean | null;
    camera_sharpness?: 'ok' | 'warning' | 'blurry' | 'unknown' | null;
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
    mesa: number;
    mesa_nombre: string;
    modulo: number;
    modulo_nombre: string;
    modulo_planta_id?: number;
    modulo_proyecto_id?: number;
    fase: 'INFERIOR' | 'SUPERIOR';
    imagen?: number;
    imagen_url?: string;
    position: number;
    plan_group_index?: number | null;
    grupo_bastidor_indice?: number | null;
    grupo_bastidor_nombre?: string | null;
    status: 'EN_COLA' | 'MOSTRANDO' | 'HECHO';
    dificultad?: number | null;
    assigned_by: string | null;
    assigned_at: string;
    done_by: string | null;
    done_at: string | null;
}

export type MesaTipo = 'INFERIOR' | 'SUPERIOR';

export interface GrupoMesaResumen {
    id: number;
    nombre: string;
    tipo: MesaTipo;
    indice: number;
    activa: boolean;
    is_linked: boolean;
    capture_service_online?: boolean | null;
    camera_sharpness?: 'ok' | 'warning' | 'blurry' | 'unknown' | null;
}

export interface GrupoMesasProyectoEntry {
    id: number;
    proyecto: number;
    proyecto_nombre: string;
    orden: number;
}

export interface GrupoMesas {
    id: number;
    nombre: string;
    usuario: number;
    proyecto_actual: number | null;
    proyectos_cola: GrupoMesasProyectoEntry[];
    activa: boolean;
    created_at: string;
    mesas: GrupoMesaResumen[];
}

export interface PlanMesaRef {
    id: number;
    nombre: string;
    tipo: MesaTipo;
    indice: number;
}

export interface GrupoPlanBastidor {
    group_index: number;
    target_mesa: PlanMesaRef;
    modules: string[];
}

export interface MesaQueuePayload {
    mesa_id: number;
    mesa_nombre: string;
    tipo: MesaTipo;
    indice: number;
    modulos: string[];
}

export interface GrupoPlanSummary {
    project_id: number;
    project_name: string;
    bastidor_groups: GrupoPlanBastidor[];
    queues: MesaQueuePayload[];
}

export interface PlanificarGrupoResponse {
    status: string;
    grupo: GrupoMesas;
    plan: GrupoPlanSummary;
}

export interface ProductionStatsBucket {
    fases_completadas: number;
    peso_malla_inicial_kg: number;
    peso_malla_final_kg: number;
    desperdicio_kg: number;
    cantidad_cortes: number;
    cantidad_refuerzos: number;
    cantidad_zunchos: number;
    cantidad_separadores: number;
    cantidad_punzos: number;
    dificultad_total: number;
}

export interface ProductionStatsMesa extends ProductionStatsBucket {
    mesa_id: number | null;
    mesa_nombre: string;
    tipo: MesaTipo;
    indice: number;
}

export interface ProductionStatsDay extends ProductionStatsBucket {
    fecha: string;
    modulos_completados: number;
}

export interface ProductionStatsHour extends ProductionStatsBucket {
    hora: string;
    modulos_completados: number;
}

export interface ProductionStatsResponse {
    range: { from: string; to: string; working_days: number };
    totals: ProductionStatsBucket & { modulos_completados: number };
    por_mesa: ProductionStatsMesa[];
    por_dia: ProductionStatsDay[];
    por_hora?: ProductionStatsHour[] | null;
    esperado: { capacidad_diaria_modulos: number; modulos_esperados: number };
}


import { environment } from '../../environments/environment';

// =============================================================================
// API SERVICE
// =============================================================================
@Injectable({
    providedIn: 'root'
})
export class ApiService {
    private baseUrl = environment.apiUrl;

    constructor(private http: HttpClient) { }


    // =========================================================================
    // AUTHENTICATION
    // =========================================================================
    login(credentials: { username: string, password: string }): Observable<{ token: string, is_staff: boolean, is_superuser: boolean }> {
        return this.http.post<{ token: string, is_staff: boolean, is_superuser: boolean }>(`${this.baseUrl}/token-auth/`, credentials).pipe(
            tap(response => {
                localStorage.setItem('auth_username', credentials.username);
                localStorage.setItem('is_staff', String(response.is_staff));
                localStorage.setItem('is_superuser', String(response.is_superuser));
            })
        );
    }

    logout(): void {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_username');
    }

    getUsername(): string | null {
        return localStorage.getItem('auth_username');
    }

    isLoggedIn(): boolean {
        return !!localStorage.getItem('auth_token');
    }

    private getHeaders(): HttpHeaders {
        const token = localStorage.getItem('auth_token');
        let headers = new HttpHeaders({
            'Content-Type': 'application/json'
        });
        if (token) {
            headers = headers.set('Authorization', `Token ${token}`);
        }
        return headers;
    }

    private getAuthHeaders(): HttpHeaders {
        const token = localStorage.getItem('auth_token');
        let headers = new HttpHeaders();
        if (token) {
            headers = headers.set('Authorization', `Token ${token}`);
        }
        return headers;
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

    createProyecto(data: any): Observable<Proyecto> {
        return this.http.post<Proyecto>(`${this.baseUrl}/proyectos/`, data, { headers: this.getHeaders() });
    }

    deleteProyecto(id: number): Observable<void> {
        return this.http.delete<void>(`${this.baseUrl}/proyectos/${id}/`, { headers: this.getHeaders() });
    }

    updateProyecto(id: number, data: any): Observable<Proyecto> {
        return this.http.patch<Proyecto>(`${this.baseUrl}/proyectos/${id}/`, data, { headers: this.getHeaders() });
    }

    /**
     * Import project structure with images from folder.
     * @param proyectoId - The project ID to import into
     * @param formData - FormData containing 'plantas' JSON and image files
     */
    importProjectStructure(proyectoId: number, formData: FormData): Observable<{
        status: string;
        proyecto_id: number;
        stats: {
            plantas: number;
            modulos: number;
            imagenes: number;
            detalles_fase: number;
            plano_cargado?: boolean;
            planilla_cargada?: boolean;
            errors: string[];
        };
    }> {
        // Don't use Content-Type header - let browser set it with boundary for multipart
        return this.http.post<any>(`${this.baseUrl}/proyectos/${proyectoId}/import-structure/`, formData, {
            headers: this.getAuthHeaders()
        });
    }

    importProjectTechnicalData(proyectoId: number, formData: FormData): Observable<{
        status: string;
        proyecto_id: number;
        stats: TechnicalImportStats;
    }> {
        return this.http.post<any>(`${this.baseUrl}/proyectos/${proyectoId}/import-technical-data/`, formData, {
            headers: this.getAuthHeaders()
        });
    }

    // =========================================================================
    // USERS (Ferrallas)
    // =========================================================================
    getUsers(): Observable<User[]> {
        return this.http.get<PagedResponse<User>>(`${this.baseUrl}/users/`, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    createUser(data: any): Observable<User> {
        return this.http.post<User>(`${this.baseUrl}/users/`, data, { headers: this.getHeaders() });
    }

    updateUser(id: number, data: any): Observable<User> {
        return this.http.patch<User>(`${this.baseUrl}/users/${id}/`, data, { headers: this.getHeaders() });
    }

    deleteUser(id: number): Observable<void> {
        return this.http.delete<void>(`${this.baseUrl}/users/${id}/`, { headers: this.getHeaders() });
    }

    // =========================================================================
    // PLANTAS
    // =========================================================================
    getPlantas(proyectoId: number): Observable<Planta[]> {
        return this.http.get<PagedResponse<Planta>>(`${this.baseUrl}/plantas/?proyecto=${proyectoId}`, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    createPlanta(data: any): Observable<Planta> {
        return this.http.post<Planta>(`${this.baseUrl}/plantas/`, data, { headers: this.getHeaders() });
    }

    updatePlanta(id: number, data: any): Observable<Planta> {
        return this.http.patch<Planta>(`${this.baseUrl}/plantas/${id}/`, data, { headers: this.getHeaders() });
    }

    deletePlanta(id: number): Observable<void> {
        return this.http.delete<void>(`${this.baseUrl}/plantas/${id}/`, { headers: this.getHeaders() });
    }

    updatePlantaFiles(id: number, formData: FormData): Observable<Planta> {
        return this.http.patch<Planta>(`${this.baseUrl}/plantas/${id}/`, formData, {
            headers: this.getAuthHeaders()
        });
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

    createModulo(data: any): Observable<Modulo> {
        return this.http.post<Modulo>(`${this.baseUrl}/modulos/`, data, { headers: this.getHeaders() });
    }

    getModuloImagenes(id: number): Observable<Imagen[]> {
        return this.http.get<Imagen[]>(`${this.baseUrl}/modulos/${id}/imagenes/`, { headers: this.getHeaders() });
    }

    cerrarModulo(id: number): Observable<Modulo> {
        return this.http.post<Modulo>(`${this.baseUrl}/modulos/${id}/cerrar/`, {}, { headers: this.getHeaders() });
    }

    markMesaQueueItemDone(itemId: number): Observable<MesaQueueItem> {
        return this.http.post<MesaQueueItem>(
            `${this.baseUrl}/mesa-queue-items/${itemId}/mark_done/`,
            {},
            { headers: this.getHeaders() }
        );
    }

    getProductionStats(params: { from?: string; to?: string; proyecto?: number } = {}): Observable<ProductionStatsResponse> {
        const query = new URLSearchParams();
        if (params.from) query.set('from', params.from);
        if (params.to) query.set('to', params.to);
        if (params.proyecto != null) query.set('proyecto', String(params.proyecto));
        const qs = query.toString();
        const url = `${this.baseUrl}/stats/production/${qs ? '?' + qs : ''}`;
        return this.http.get<ProductionStatsResponse>(url, { headers: this.getHeaders() });
    }

    reiniciarModulo(id: number): Observable<Modulo> {
        return this.http.post<Modulo>(`${this.baseUrl}/modulos/${id}/reiniciar/`, {}, { headers: this.getHeaders() });
    }

    completarModulo(id: number): Observable<Modulo> {
        return this.http.post<Modulo>(`${this.baseUrl}/modulos/${id}/completar/`, {}, { headers: this.getHeaders() });
    }

    getGruposBastidor(proyectoId: number): Observable<GrupoBastidor[]> {
        return this.http.get<GrupoBastidor[]>(
            `${this.baseUrl}/grupos-bastidor/?proyecto=${proyectoId}`,
            { headers: this.getHeaders() }
        );
    }

    updateGrupoBastidor(id: number, data: { nombre: string }): Observable<GrupoBastidor> {
        return this.http.patch<GrupoBastidor>(
            `${this.baseUrl}/grupos-bastidor/${id}/`,
            data,
            { headers: this.getHeaders() }
        );
    }

    updateModulo(id: number, data: any): Observable<Modulo> {
        return this.http.patch<Modulo>(`${this.baseUrl}/modulos/${id}/`, data, { headers: this.getHeaders() });
    }

    // =========================================================================
    // MESAS (paginated)
    // =========================================================================
    getMesas(usuarioId?: number): Observable<Mesa[]> {
        let url = `${this.baseUrl}/mesas/`;
        if (usuarioId) {
            url += `?usuario=${usuarioId}`;
        }
        return this.http.get<PagedResponse<Mesa>>(url, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    getGruposMesas(usuarioId?: number): Observable<GrupoMesas[]> {
        let url = `${this.baseUrl}/grupos-mesas/`;
        if (usuarioId) {
            url += `?usuario=${usuarioId}`;
        }
        return this.http.get<PagedResponse<GrupoMesas>>(url, { headers: this.getHeaders() })
            .pipe(map(response => response.results));
    }

    createGrupoMesas(data: Partial<GrupoMesas>): Observable<GrupoMesas> {
        return this.http.post<GrupoMesas>(`${this.baseUrl}/grupos-mesas/`, data, { headers: this.getHeaders() });
    }

    updateGrupoMesas(id: number, data: Partial<GrupoMesas>): Observable<GrupoMesas> {
        return this.http.patch<GrupoMesas>(`${this.baseUrl}/grupos-mesas/${id}/`, data, { headers: this.getHeaders() });
    }

    deleteGrupoMesas(id: number): Observable<void> {
        return this.http.delete<void>(`${this.baseUrl}/grupos-mesas/${id}/`, { headers: this.getHeaders() });
    }

    cambiarTiposMesa(
        grupoId: number,
        cambios: { mesa_id: number; tipo: 'INFERIOR' | 'SUPERIOR' }[],
    ): Observable<PlanificarGrupoResponse> {
        return this.http.post<PlanificarGrupoResponse>(
            `${this.baseUrl}/grupos-mesas/${grupoId}/cambiar-tipos/`,
            { cambios },
            { headers: this.getHeaders() }
        );
    }

    planificarGrupoMesas(grupoId: number, proyectoId: number): Observable<PlanificarGrupoResponse> {
        return this.http.post<PlanificarGrupoResponse>(
            `${this.baseUrl}/grupos-mesas/${grupoId}/planificar/`,
            { proyecto_id: proyectoId },
            { headers: this.getHeaders() }
        );
    }

    colaGrupoMesasAdd(grupoId: number, proyectoId: number): Observable<GrupoMesas> {
        return this.http.post<GrupoMesas>(
            `${this.baseUrl}/grupos-mesas/${grupoId}/cola/add/`,
            { proyecto: proyectoId },
            { headers: this.getHeaders() }
        );
    }

    colaGrupoMesasRemove(grupoId: number, proyectoId: number): Observable<GrupoMesas> {
        return this.http.post<GrupoMesas>(
            `${this.baseUrl}/grupos-mesas/${grupoId}/cola/remove/`,
            { proyecto: proyectoId },
            { headers: this.getHeaders() }
        );
    }

    colaGrupoMesasReorder(grupoId: number, proyectoIds: number[]): Observable<GrupoMesas> {
        return this.http.post<GrupoMesas>(
            `${this.baseUrl}/grupos-mesas/${grupoId}/cola/reorder/`,
            { proyecto_ids: proyectoIds },
            { headers: this.getHeaders() }
        );
    }

    createMesa(data: any): Observable<Mesa> {
        return this.http.post<Mesa>(`${this.baseUrl}/mesas/`, data, { headers: this.getHeaders() });
    }

    deleteMesa(id: number, force = false): Observable<void> {
        const url = force
            ? `${this.baseUrl}/mesas/${id}/?force=true`
            : `${this.baseUrl}/mesas/${id}/`;
        return this.http.delete<void>(url, { headers: this.getHeaders() });
    }

    addMesaToGrupo(grupoId: number, tipo: MesaTipo): Observable<GrupoMesaResumen> {
        return this.http.post<GrupoMesaResumen>(
            `${this.baseUrl}/grupos-mesas/${grupoId}/mesas/`,
            { tipo },
            { headers: this.getHeaders() }
        );
    }

    setMesaActiva(mesaId: number, activa: boolean): Observable<Mesa> {
        const action = activa ? 'reactivar' : 'desactivar';
        return this.http.post<Mesa>(
            `${this.baseUrl}/mesas/${mesaId}/${action}/`,
            {},
            { headers: this.getHeaders() }
        );
    }

    updateMesa(id: number, data: any): Observable<Mesa> {
        return this.http.patch<Mesa>(`${this.baseUrl}/mesas/${id}/`, data, { headers: this.getHeaders() });
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
        }, { headers: this.getHeaders() });
    }

    /**
     * Unbind a device from a Mesa.
     */
    unbindDevice(mesaId: number): Observable<{ status: string }> {
        return this.http.post<{ status: string }>(`${this.baseUrl}/device/unbind/`, {
            mesa_id: mesaId
        }, { headers: this.getHeaders() });
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
    createMesaQueueItem(mesaId: number, moduloId: number, fase: string, imagenId: number | null, position: number): Observable<MesaQueueItem> {
        return this.http.post<MesaQueueItem>(`${this.baseUrl}/mesa-queue-items/`, {
            mesa: mesaId,
            modulo: moduloId,
            fase: fase,
            imagen: imagenId,
            position: position
        }, { headers: this.getHeaders() });
    }

    updateMesaQueueItem(id: number, data: any): Observable<MesaQueueItem> {
        return this.http.patch<MesaQueueItem>(`${this.baseUrl}/mesa-queue-items/${id}/`, data, { headers: this.getHeaders() });
    }

    moveMesaQueueItem(id: number, mesaId: number, position: number): Observable<MesaQueueItem> {
        return this.http.post<MesaQueueItem>(`${this.baseUrl}/mesa-queue-items/${id}/move/`, {
            mesa: mesaId,
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

    // =========================================================================
    // FOTOS FABRICACION
    // =========================================================================
    getFotos(params: { modulo?: number; planta?: number; proyecto?: number }): Observable<FotoFabricacion[]> {
        let url = `${this.baseUrl}/fotos/`;
        const queryParts: string[] = [];
        if (params.modulo) queryParts.push(`modulo=${params.modulo}`);
        if (params.planta) queryParts.push(`planta=${params.planta}`);
        if (params.proyecto) queryParts.push(`proyecto=${params.proyecto}`);
        if (queryParts.length) url += '?' + queryParts.join('&');
        return this.http.get<FotoFabricacion[]>(url, { headers: this.getHeaders() });
    }

    downloadFotosZip(params: { modulo?: number; planta?: number; proyecto?: number }): Observable<Blob> {
        let url = `${this.baseUrl}/fotos/download_zip/`;
        const queryParts: string[] = [];
        if (params.modulo) queryParts.push(`modulo=${params.modulo}`);
        if (params.planta) queryParts.push(`planta=${params.planta}`);
        if (params.proyecto) queryParts.push(`proyecto=${params.proyecto}`);
        if (queryParts.length) url += '?' + queryParts.join('&');
        return this.http.get(url, {
            headers: this.getAuthHeaders(),
            responseType: 'blob'
        });
    }
}
