import { Component, OnInit, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import {
    CdkDragDrop,
    DragDropModule,
    moveItemInArray,
    transferArrayItem,
} from '@angular/cdk/drag-drop';
import {
    ApiService, Proyecto, Planta, Modulo, User, FotoFabricacion,
    DetalleModuloFase, TechnicalImportStats, GrupoBastidor, GrupoBastidorModulo,
    EstrategiaBastidor
} from '../../../services/api.service';
import { switchMap, forkJoin, of } from 'rxjs';
import { environment } from '../../../../environments/environment';

@Component({
    selector: 'app-proyecto-detalle',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterModule, DragDropModule],
    templateUrl: './detalle.component.html',
    styleUrls: ['./detalle.component.css']
})
export class ProyectoDetailComponent implements OnInit {
    proyectoId: number | null = null;
    proyecto: Proyecto | null = null;
    plantas: Planta[] = [];
    selectedPlanta: Planta | null = null;
    modulos: Modulo[] = [];
    grupos: GrupoBastidor[] = [];
    users: User[] = [];

    loading = false;
    showPlantaForm = false;
    showModuloForm = false;

    newPlanta: Partial<Planta> = { nombre: '', orden: 1 };

    // Bulk Creation State
    bulkModulo = {
        prefix: 'MOD-',
        start: 1,
        count: 10
    };
    loadingBulk = false;

    // Module status options
    statusOptions = ['PENDIENTE', 'EN_PROGRESO', 'COMPLETADO'];

    // Import State
    importing = false;
    importProgress = '';
    uploadingPlantaId: number | null = null;
    updatingSubmoduleId: number | null = null;
    showPlantaFilesModal = false;
    plantaFilesTarget: Planta | null = null;
    checkingPlantaFiles = false;
    plantaFileExists = { plano: false, corte: false };
    dropdownOpen = false;
    savingProjectConfig = false;
    technicalImporting = false;
    technicalImportStats: TechnicalImportStats | null = null;

    // Photo Gallery State
    showFotosModal = false;
    fotosTarget: { id: number; nombre: string } | null = null;
    fotos: FotoFabricacion[] = [];
    loadingFotos = false;
    downloadingZip = false;
    selectedFotoIndex = 0;

    constructor(
        private route: ActivatedRoute,
        private api: ApiService,
        private cdr: ChangeDetectorRef
    ) { }

    @HostListener('document:click', ['$event'])
    onDocumentClick(event: MouseEvent) {
        const target = event.target as HTMLElement;
        if (!target.closest('.custom-dropdown')) {
            this.dropdownOpen = false;
        }
    }

    ngOnInit(): void {
        this.route.params.subscribe(params => {
            if (params['id']) {
                this.proyectoId = +params['id'];
                this.loadData();
            }
        });
    }

    loadData() {
        if (!this.proyectoId) return;
        this.loading = true;
        forkJoin({
            proyecto: this.api.getProyecto(this.proyectoId),
            plantas: this.api.getPlantas(this.proyectoId),
            users: this.api.getUsers(),
            modulos: this.api.getModulos(undefined, this.proyectoId),
            grupos: this.api.getGruposBastidor(this.proyectoId)
        }).subscribe({
            next: (data) => {
                if (data && data.proyecto) {
                    this.proyecto = data.proyecto;
                    this.plantas = data.plantas?.sort((a: Planta, b: Planta) => a.orden - b.orden) || [];
                    this.users = data.users || [];
                    this.modulos = data.modulos || [];
                    this.grupos = (data.grupos || []).sort((a, b) => a.indice - b.indice);

                    // Auto-create default planta if none exist (for backend compatibility)
                    if (this.plantas.length === 0) {
                        this.api.createPlanta({ nombre: 'General', orden: 1, proyecto: this.proyectoId }).subscribe({
                            next: (p) => {
                                this.plantas = [p];
                                this.selectedPlanta = p;
                                this.loading = false;
                                this.cdr.detectChanges();
                            },
                            error: () => {
                                this.loading = false;
                                this.cdr.detectChanges();
                            }
                        });
                        return;
                    }

                    // Set selectedPlanta for file management compatibility
                    if (this.plantas.length > 0 && !this.selectedPlanta) {
                        this.selectedPlanta = this.plantas[0];
                    }
                    this.loading = false;
                    this.cdr.detectChanges();
                } else {
                    this.loading = false;
                    this.cdr.detectChanges();
                }
            },
            error: (err: any) => {
                console.error('Error loading project', err);
                this.loading = false;
                this.cdr.detectChanges();
            }
        });
    }

    // =========================================================================
    // DRAG & DROP de modulos entre bastidores + reorder de bastidores
    // =========================================================================
    isDraggingModulo = false;
    /** Id del bastidor desde el que se esta arrastrando un modulo. Permite
     *  habilitar el sort visual solo dentro del bastidor de origen y
     *  evitar que en los demas se vea un placeholder mentiroso en mitad
     *  de la lista (el orden destino lo decide el natural-sort por nombre). */
    isDraggingModuloFrom: number | null = null;
    isDraggingBastidor = false;
    movingModulo = false;
    recalculatingBastidores = false;

    /** ID DOM unico para cada cdkDropList del bastidor (se inyecta a connectedTo). */
    bastidorDropListId(grupo: GrupoBastidor): string {
        return `bastidor-drop-${grupo.id}`;
    }

    /** Lista de IDs a los que cada bastidor se conecta (todos los demas + el slot "nuevo"). */
    connectedDropListIds(currentGrupoId: number): string[] {
        const ids = this.grupos
            .filter(g => g.id !== currentGrupoId)
            .map(g => this.bastidorDropListId(g));
        ids.push('bastidor-drop-new');
        return ids;
    }

    isModuloMovible(modulo: GrupoBastidorModulo): boolean {
        return modulo.estado === 'PENDIENTE';
    }

    onModuloDragStarted(grupo: GrupoBastidor): void {
        this.isDraggingModulo = true;
        this.isDraggingModuloFrom = grupo.id;
    }

    onModuloDragEnded(): void {
        this.isDraggingModulo = false;
        this.isDraggingModuloFrom = null;
    }

    onBastidorDragStarted(): void {
        this.isDraggingBastidor = true;
    }

    onBastidorDragEnded(): void {
        this.isDraggingBastidor = false;
    }

    /** Comparador natural (A01 < A2 < A10) usado para resortear localmente. */
    private _naturalCompare(a: string, b: string): number {
        return (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' });
    }

    /** Drop de un modulo en otro bastidor existente. */
    onModuloDropInBastidor(event: CdkDragDrop<GrupoBastidor>): void {
        const modulo = event.item.data as GrupoBastidorModulo;
        const destino = event.container.data as GrupoBastidor;
        const origen = event.previousContainer.data as GrupoBastidor;

        if (event.previousContainer === event.container) {
            // Intra-bastidor: el orden interno siempre se normaliza por nombre
            // (lo que usa la cola operativa). No persistimos posicion manual.
            return;
        }

        if (!this.isModuloMovible(modulo)) {
            alert(`No se puede mover "${modulo.nombre}": estado ${modulo.estado}.`);
            return;
        }

        // Update optimista: transfer + resort por nombre natural para que
        // el modulo "salte" inmediatamente a su posicion final y no parezca
        // que se va al final del todo cuando el backend devuelve la lista.
        transferArrayItem(origen.modulos, destino.modulos, event.previousIndex, event.currentIndex);
        destino.modulos.sort((a, b) => this._naturalCompare(a.nombre, b.nombre));
        this.movingModulo = true;
        this.api.moveModuloEntreBastidores(modulo.id, destino.id).subscribe({
            next: (grupos) => {
                this.grupos = grupos.sort((a, b) => a.indice - b.indice);
                this.movingModulo = false;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error moviendo modulo', err);
                const detail = err?.error?.detail || 'No se pudo mover el modulo.';
                alert(detail);
                this.movingModulo = false;
                this.loadData();
            }
        });
    }

    /** Drop sobre el card "+" => crear bastidor nuevo. */
    onModuloDropInNewBastidor(event: CdkDragDrop<null>): void {
        const modulo = event.item.data as GrupoBastidorModulo;
        if (!this.isModuloMovible(modulo)) {
            alert(`No se puede mover "${modulo.nombre}": estado ${modulo.estado}.`);
            return;
        }
        this.movingModulo = true;
        this.api.moveModuloEntreBastidores(modulo.id, null).subscribe({
            next: (grupos) => {
                this.grupos = grupos.sort((a, b) => a.indice - b.indice);
                this.movingModulo = false;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error creando bastidor nuevo', err);
                alert(err?.error?.detail || 'No se pudo crear el bastidor.');
                this.movingModulo = false;
                this.loadData();
            }
        });
    }

    /** Drop de reordenamiento del listado de bastidores. */
    onBastidorDrop(event: CdkDragDrop<GrupoBastidor[]>): void {
        if (event.previousIndex === event.currentIndex) return;
        moveItemInArray(this.grupos, event.previousIndex, event.currentIndex);
        this.cdr.detectChanges();
        if (!this.proyectoId) return;
        const orden = this.grupos.map(g => g.id);
        this.api.reorderBastidores(this.proyectoId, orden).subscribe({
            next: (grupos) => {
                this.grupos = grupos.sort((a, b) => a.indice - b.indice);
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error reordenando bastidores', err);
                alert(err?.error?.detail || 'No se pudo guardar el orden.');
                this.loadData();
            }
        });
    }

    /** Switch de estrategia. Recalcula bastidores en backend. */
    onEstrategiaToggle(nueva: EstrategiaBastidor): void {
        if (!this.proyecto || !this.proyectoId) return;
        if (nueva === this.proyecto.estrategia_bastidor) return;

        const aviso = nueva === 'AISLAR_CENTRAL_GIRADO'
            ? 'Esto rehara los bastidores separando los CENTRAL GIRADO del resto. Los movimientos manuales actuales se perderan. Continuar?'
            : 'Esto rehara los bastidores en orden secuencial. Los movimientos manuales actuales se perderan. Continuar?';
        if (!confirm(aviso)) return;

        this.recalculatingBastidores = true;
        this.api.recalcularBastidores(this.proyectoId, nueva).subscribe({
            next: (res) => {
                if (this.proyecto) {
                    this.proyecto.estrategia_bastidor = res.estrategia;
                }
                this.grupos = res.grupos.sort((a, b) => a.indice - b.indice);
                this.recalculatingBastidores = false;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error recalculando bastidores', err);
                const data = err?.error;
                if (data?.modulos_bloqueantes?.length) {
                    const lista = data.modulos_bloqueantes.slice(0, 10).join(', ');
                    const extra = data.total_bloqueantes > 10
                        ? ` (+${data.total_bloqueantes - 10} mas)` : '';
                    alert(`${data.detail}\n\nBloqueantes: ${lista}${extra}`);
                } else {
                    alert(data?.detail || 'No se pudieron recalcular los bastidores.');
                }
                this.recalculatingBastidores = false;
                this.cdr.detectChanges();
            }
        });
    }

    tipoModuloLabel(tipo: GrupoBastidorModulo['tipo_modulo']): string {
        switch (tipo) {
            case 'CENTRAL': return 'C';
            case 'CENTRAL_GIRADO': return 'CG';
            case 'LADO_LARGO': return 'LL';
            case 'LADO_CORTO': return 'LC';
            case 'ESQUINA': return 'E';
            default: return '';
        }
    }

    tipoModuloFullLabel(tipo: GrupoBastidorModulo['tipo_modulo']): string {
        switch (tipo) {
            case 'CENTRAL': return 'Central';
            case 'CENTRAL_GIRADO': return 'Central girado';
            case 'LADO_LARGO': return 'Lado largo';
            case 'LADO_CORTO': return 'Lado corto';
            case 'ESQUINA': return 'Esquina';
            default: return 'Sin tipo';
        }
    }

    isGrupoCompletado(grupo: GrupoBastidor): boolean {
        if (!grupo.modulos.length) return false;
        return grupo.modulos.every(m => m.estado === 'COMPLETADO' || m.estado === 'CERRADO');
    }

    // Inline rename state for GrupoBastidor alias.
    editingGrupoId: number | null = null;
    editingGrupoNombre: string = '';

    startEditingGrupo(grupo: GrupoBastidor, event?: Event): void {
        event?.stopPropagation();
        this.editingGrupoId = grupo.id;
        this.editingGrupoNombre = grupo.nombre || '';
    }

    cancelEditingGrupo(): void {
        this.editingGrupoId = null;
        this.editingGrupoNombre = '';
    }

    saveGrupoNombre(grupo: GrupoBastidor): void {
        // Ignore if this callback is re-entered (e.g. Enter triggers save,
        // which unmounts the input, which fires blur -> save again with
        // editingGrupoNombre already cleared).
        if (this.editingGrupoId !== grupo.id) return;

        const target = this.editingGrupoNombre.trim();
        const current = (grupo.nombre || '').trim();

        // Leave edit mode up front so any follow-up blur is a no-op.
        this.editingGrupoId = null;
        this.editingGrupoNombre = '';

        if (target === current) {
            this.cdr.detectChanges();
            return;
        }

        this.api.updateGrupoBastidor(grupo.id, { nombre: target }).subscribe({
            next: (updated) => {
                grupo.nombre = updated.nombre;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error renaming grupo', err);
                alert('No se pudo guardar el nombre del grupo.');
                this.cdr.detectChanges();
            }
        });
    }

    reiniciarModulo(moduloId: number, event?: Event): void {
        if (event) event.stopPropagation();
        const confirmed = confirm('Reiniciar este modulo volvera a poner las fases INF y SUP como pendientes. Continuar?');
        if (!confirmed) return;

        this.api.reiniciarModulo(moduloId).subscribe({
            next: () => {
                this.loadData();
            },
            error: (err: any) => {
                console.error('Error reiniciando modulo', err);
                alert('Error al reiniciar el modulo');
                this.cdr.detectChanges();
            }
        });
    }

    completarModulo(moduloId: number, event?: Event): void {
        if (event) event.stopPropagation();
        this.api.completarModulo(moduloId).subscribe({
            next: () => {
                this.loadData();
            },
            error: (err: any) => {
                console.error('Error completando modulo', err);
                alert('Error al completar el modulo');
                this.cdr.detectChanges();
            }
        });
    }

    togglePlantaForm() {
        this.showPlantaForm = !this.showPlantaForm;
        // Auto-suggest next order
        if (this.showPlantaForm && this.plantas.length > 0) {
            const maxOrder = Math.max(...this.plantas.map(p => p.orden));
            this.newPlanta.orden = maxOrder + 1;
        }
    }

    createPlanta() {
        if (!this.proyectoId) return;

        const payload = {
            ...this.newPlanta,
            proyecto: this.proyectoId
        };

        this.loading = true;
        this.api.createPlanta(payload).subscribe({
            next: (planta: Planta) => {
                this.plantas.push(planta);
                this.plantas.sort((a: Planta, b: Planta) => a.orden - b.orden); // Re-sort
                this.showPlantaForm = false;
                this.newPlanta = { nombre: '', orden: 1 };
                this.loading = false;
                // Optionally auto-select
                this.selectPlanta(planta);
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error creating planta', err);
                this.loading = false;
                this.cdr.detectChanges();
            }
        });
    }

    deletePlanta(planta: Planta, event?: Event): void {
        if (event) {
            event.stopPropagation();
        }

        const confirmed = confirm(`¿Eliminar la planta "${planta.nombre}"? Esta acción no se puede deshacer.`);
        if (!confirmed) {
            return;
        }

        this.loading = true;
        this.api.deletePlanta(planta.id).subscribe({
            next: () => {
                this.plantas = this.plantas.filter(p => p.id !== planta.id);

                if (this.plantaFilesTarget?.id === planta.id) {
                    this.closePlantaFilesModal();
                }

                if (this.selectedPlanta?.id === planta.id) {
                    const nextPlanta = this.plantas[0] ?? null;
                    this.selectedPlanta = nextPlanta;

                    if (nextPlanta) {
                        this.loadModulos(nextPlanta.id);
                    } else {
                        this.modulos = [];
                        this.loading = false;
                        this.cdr.detectChanges();
                    }
                    return;
                }

                this.loading = false;
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error deleting planta', err);
                const detail = err?.error?.detail || 'No se pudo eliminar la planta.';
                alert(detail);
                this.loading = false;
                this.cdr.detectChanges();
            }
        });
    }

    selectPlanta(planta: Planta) {
        this.selectedPlanta = planta;
        this.loadModulos(planta.id);
    }

    loadModulos(plantaId: number) {
        this.loading = true;
        this.api.getModulos(plantaId).subscribe({
            next: (modulos: Modulo[]) => {
                this.modulos = modulos;
                this.loading = false;
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error loading modulos', err);
                this.loading = false;
                this.cdr.detectChanges();
            }
        });
    }

    toggleModuloForm() {
        this.showModuloForm = !this.showModuloForm;
    }

    createModulosBulk() {
        if (!this.selectedPlanta || !this.proyectoId) return;

        this.loadingBulk = true;
        const requests = [];

        for (let i = 0; i < this.bulkModulo.count; i++) {
            const num = this.bulkModulo.start + i;
            // Pad number with leading zero if < 10 for consistency (optional, but good for sorting)
            const numStr = num < 10 ? `0${num}` : `${num}`;
            const name = `${this.bulkModulo.prefix}${numStr}`;

            const payload = {
                nombre: name,
                planta: this.selectedPlanta.id,
                proyecto: this.proyectoId,
                estado: 'PENDIENTE',
                inferior_hecho: false,
                superior_hecho: false,
                cerrado: false
            };

            requests.push(this.api.createModulo(payload));
        }

        // Execute all requests
        forkJoin(requests).subscribe({
            next: (newModulos) => {
                this.modulos = [...this.modulos, ...newModulos];
                this.showModuloForm = false;
                this.loadingBulk = false;
                // Reset form for next batch
                this.bulkModulo.start += this.bulkModulo.count;
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error creating modules', err);
                this.loadingBulk = false;
                alert('Error creating some modules. Check console.');
                this.cdr.detectChanges();
            }
        });
    }

    // Change project ferralla assignment
    changeFerralla(userUrl: string | null): void {
        if (!this.proyectoId) return;

        this.loading = true;
        this.api.updateProyecto(this.proyectoId, { usuario: userUrl }).subscribe({
            next: (proyecto: Proyecto) => {
                this.proyecto = proyecto;
                this.loading = false;
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error updating ferralla', err);
                this.loading = false;
                alert('Error al cambiar la ferralla');
                this.cdr.detectChanges();
            }
        });
    }

    getSelectedFerrallaLabel(): string {
        if (!this.proyecto?.usuario) return 'Sin asignar';
        const user = this.users.find(u => u.url === this.proyecto!.usuario);
        return user ? (user.first_name || user.username) : 'Sin asignar';
    }

    saveBastidorLongitud(): void {
        if (!this.proyectoId || !this.proyecto) return;

        const bastidor = Number(this.proyecto.bastidor_longitud_cm);
        if (!Number.isFinite(bastidor) || bastidor <= 0) {
            alert('La longitud del bastidor debe ser mayor que 0.');
            this.loadData();
            return;
        }

        this.savingProjectConfig = true;
        this.api.updateProyecto(this.proyectoId, {
            bastidor_longitud_cm: Number(bastidor.toFixed(2))
        }).subscribe({
            next: (proyecto: Proyecto) => {
                this.proyecto = proyecto;
                this.savingProjectConfig = false;
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error updating bastidor length', err);
                this.savingProjectConfig = false;
                alert('Error al guardar la longitud del bastidor');
                this.cdr.detectChanges();
            }
        });
    }

    getModuloStatusLabel(estado: Modulo['estado']): string {
        switch (estado) {
            case 'COMPLETADO':
                return 'TERMINADO';
            case 'EN_PROGRESO':
                return 'EN PROCESO';
            case 'CERRADO':
                return 'CERRADO';
            default:
                return 'PENDIENTE';
        }
    }

    updateSubmoduleStatus(modulo: Modulo, phase: 'inferior_hecho' | 'superior_hecho', event: Event): void {
        const input = event.target as HTMLInputElement;
        const checked = input.checked;

        const inferior = phase === 'inferior_hecho' ? checked : modulo.inferior_hecho;
        const superior = phase === 'superior_hecho' ? checked : modulo.superior_hecho;
        const estado = this.computeModuloEstado(inferior, superior, modulo.cerrado);

        this.updatingSubmoduleId = modulo.id;
        this.api.updateModulo(modulo.id, {
            inferior_hecho: inferior,
            superior_hecho: superior,
            estado: estado
        }).subscribe({
            next: (updated: Modulo) => {
                const index = this.modulos.findIndex(m => m.id === modulo.id);
                if (index !== -1) {
                    this.modulos[index] = updated;
                }
                this.updatingSubmoduleId = null;
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error updating submodule status', err);
                this.updatingSubmoduleId = null;
                alert('Error al cambiar el estado del submódulo');
                this.cdr.detectChanges();
            }
        });
    }

    private computeModuloEstado(inferior: boolean, superior: boolean, cerrado: boolean): Modulo['estado'] {
        if (cerrado) {
            return 'CERRADO';
        }
        if (inferior && superior) {
            return 'COMPLETADO';
        }
        if (inferior || superior) {
            return 'EN_PROGRESO';
        }
        return 'PENDIENTE';
    }

    // Get user display name from URL
    getUserName(userUrl: string | null): string {
        if (!userUrl) return 'Sin asignar';
        const user = this.users.find(u => u.url === userUrl);
        return user ? (user.first_name || user.username) : 'Sin asignar';
    }

    async importPlantaFromFolder() {
        if (!this.proyectoId) return;

        try {
            // Use File System Access API
            const projectHandle = await (window as any).showDirectoryPicker();
            if (!projectHandle) return;

            this.importing = true;
            this.importProgress = `Analizando carpeta: ${projectHandle.name}...`;
            this.cdr.detectChanges();

            const formData = new FormData();
            const validExtensions = ['.png', '.jpg', '.jpeg'];
            let technicalDbFile: File | null = null;

            // Use single virtual "General" planta for backend compatibility
            const plantaUnicaData: any = {
                nombre: 'General',
                orden: 1,
                modulos: []
            };

            // Iterate modules (direct children of project folder)
            for await (const [childName, childHandle] of (projectHandle as any).entries()) {
                if (childHandle.kind === 'file') {
                    const fileName = childName;
                    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
                    if (['.db', '.sqlite', '.sqlite3'].includes(ext)) {
                        technicalDbFile = await (childHandle as any).getFile();
                    }
                    continue;
                }
                if (childHandle.kind === 'directory') {
                    const moduloName = childName;
                    const moduloHandle = childHandle;

                    this.importProgress = `Procesando modulo: ${moduloName}...`;
                    this.cdr.detectChanges();

                    // Parse color code from folder name (e.g. "A01_ymgc" -> name="A01", code="ymgc")
                    const parts = moduloName.split('_');
                    let colorCode = 'xxxx';
                    let cleanName = moduloName;
                    if (parts.length > 1) {
                        const lastPart = parts[parts.length - 1].toLowerCase();
                        if (lastPart.length === 4 && /^[ygcvmox]+$/.test(lastPart)) {
                            colorCode = lastPart;
                            cleanName = parts.slice(0, -1).join('_');
                        }
                    }
                    // Strip common prefixes (MODULO_, MOD_, MODULO-, MOD-) so names match DB records
                    cleanName = cleanName.replace(/^(MODULO|MOD)[_-]/i, '');

                    const moduloData: any = {
                        nombre: cleanName,
                        codigos_color: colorCode,
                        imagenes: []
                    };

                    // Check for INF and SUP subfolders
                    for await (const [faseName, faseHandle] of moduloHandle.entries()) {
                        if (faseHandle.kind !== 'directory') continue;

                        const faseNormalizada = faseName.toUpperCase();
                        if (faseNormalizada !== 'INF' && faseNormalizada !== 'SUP') continue;

                        const fase = faseNormalizada === 'INF' ? 'INFERIOR' : 'SUPERIOR';
                        let ordenImg = 1;

                        // Collect image files first, then sort alphabetically
                        const imgFiles: Array<[string, any]> = [];
                        for await (const [fileName, fileHandle] of faseHandle.entries()) {
                            if (fileHandle.kind !== 'file') continue;
                            const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
                            if (!validExtensions.includes(ext)) continue;
                            imgFiles.push([fileName, fileHandle]);
                        }
                        imgFiles.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

                        for (const [fileName, fileHandle] of imgFiles) {
                            const file = await fileHandle.getFile();
                            const formFileKey = `MOD_${moduloName}_${faseName}_${fileName}`;
                            formData.append(formFileKey, file);

                            moduloData.imagenes.push({
                                filename: formFileKey,
                                fase: fase,
                                orden: ordenImg++
                            });
                        }
                    }
                    plantaUnicaData.modulos.push(moduloData);
                }
            }

            this.importProgress = 'Subiendo datos...';
            this.cdr.detectChanges();

            // Add structure to FormData
            formData.append('plantas', JSON.stringify([plantaUnicaData]));

            // Upload
            this.api.importProjectStructure(this.proyectoId, formData).subscribe({
                next: (res) => {
                    const finish = (techResult?: any) => {
                        this.importing = false;
                        this.importProgress = '';
                        const s = res.stats;
                        const lines: string[] = [];
                        lines.push('Módulos importados correctamente.');
                        lines.push('');
                        lines.push(`• Módulos creados: ${s.modulos || 0}`);
                        lines.push(`• Imágenes cargadas: ${s.imagenes || 0}`);
                        lines.push(`• Plano de referencia: ${s.plano_cargado ? 'sí' : 'no'}`);
                        lines.push(`• Planilla (corte): ${s.planilla_cargada ? 'sí' : 'no'}`);
                        if (techResult?.stats) {
                            const t = techResult.stats;
                            lines.push(`• Base de datos técnica: importada (procesados ${t.processed || 0}, omitidos ${t.skipped || 0})`);
                            lines.push(`• Grupos de bastidor calculados: ${t.grupos_bastidor || 0}`);
                        } else if (technicalDbFile) {
                            lines.push(`• Base de datos técnica: no se pudo importar`);
                        }
                        if (s.errors && s.errors.length) {
                            lines.push('');
                            lines.push(`⚠ ${s.errors.length} incidencias.`);
                        }
                        alert(lines.join('\n'));
                        this.loadData();
                    };

                    // Auto-import technical data if .db was found in the folder
                    if (technicalDbFile && this.proyectoId) {
                        this.importProgress = 'Importando datos técnicos...';
                        this.cdr.detectChanges();
                        const techForm = new FormData();
                        techForm.append('technical_file', technicalDbFile);
                        this.api.importProjectTechnicalData(this.proyectoId, techForm).subscribe({
                            next: (techResult) => finish(techResult),
                            error: (err) => {
                                console.warn('Auto technical import failed:', err);
                                finish();
                            }
                        });
                    } else {
                        finish();
                    }
                },
                error: (err) => {
                    console.error('Error uploading modules', err);
                    this.importing = false;
                    this.importProgress = '';
                    alert('Error importando los modulos');
                    this.cdr.detectChanges();
                }
            });

        } catch (err: any) {
            if (err.name !== 'AbortError') {
                console.error('Error reading folder:', err);
                this.importing = false;
                alert('Error leyendo la carpeta: ' + err.message);
                this.cdr.detectChanges();
            } else {
                this.importing = false;
                this.importProgress = '';
            }
        }
    }

    triggerTechnicalDataUpload(fileInput: HTMLInputElement): void {
        fileInput.value = '';
        fileInput.click();
    }

    onTechnicalDataSelected(event: Event): void {
        if (!this.proyectoId) return;

        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        const lowerName = file.name.toLowerCase();
        if (!lowerName.endsWith('.json') && !lowerName.endsWith('.csv') && !lowerName.endsWith('.db')) {
            alert('El fichero técnico debe ser JSON o CSV.');
            return;
        }

        this.technicalImporting = true;
        this.technicalImportStats = null;

        const formData = new FormData();
        formData.append('technical_file', file);

        this.api.importProjectTechnicalData(this.proyectoId, formData).subscribe({
            next: (result) => {
                this.technicalImporting = false;
                this.technicalImportStats = result.stats;
                this.loadData();
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error importing technical data', err);
                this.technicalImporting = false;
                alert(err?.error?.detail || 'Error importando los datos técnicos');
                this.cdr.detectChanges();
            }
        });
    }

    getDetalleFase(modulo: Modulo, fase: 'INFERIOR' | 'SUPERIOR'): DetalleModuloFase | null {
        return modulo.detalles_fase?.find(detalle => detalle.fase === fase) || null;
    }

    hasDetallesTecnicos(modulo: Modulo): boolean {
        return !!modulo.detalles_fase?.length || !!modulo.ancho_cm;
    }

    formatDetailValue(value: string | number | null | undefined, suffix = ''): string {
        if (value === null || value === undefined || value === '') {
            return '';
        }
        return `${value}${suffix}`;
    }

    triggerPlantaFileUpload(fileInput: HTMLInputElement): void {
        fileInput.value = '';
        fileInput.click();
    }

    openPlantaFilesModal(planta: Planta, event?: Event): void {
        if (event) {
            event.stopPropagation();
        }
        this.plantaFilesTarget = planta;
        this.showPlantaFilesModal = true;
        this.refreshPlantaFileAvailability();
    }

    closePlantaFilesModal(): void {
        this.showPlantaFilesModal = false;
        this.plantaFilesTarget = null;
        this.plantaFileExists = { plano: false, corte: false };
        this.checkingPlantaFiles = false;
    }

    onPlantaFileSelected(event: Event, fileType: 'plano' | 'corte', planta?: Planta): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        const targetPlanta = planta || this.plantaFilesTarget;
        if (!targetPlanta) return;

        const isPlano = fileType === 'plano';
        const validMimeTypes = isPlano
            ? ['image/jpeg', 'image/jpg']
            : ['application/pdf'];
        const validExtensions = isPlano ? ['.jpg', '.jpeg'] : ['.pdf'];
        const fileName = file.name.toLowerCase();
        const extensionOk = validExtensions.some(ext => fileName.endsWith(ext));
        const mimeOk = validMimeTypes.includes(file.type);

        if (!extensionOk && !mimeOk) {
            alert(isPlano ? 'El plano debe ser un archivo JPG/JPEG.' : 'La planilla debe ser un archivo PDF.');
            return;
        }

        const formData = new FormData();
        if (isPlano) {
            formData.append('plano_imagen', file);
        } else {
            formData.append('fichero_corte', file);
        }

        this.uploadingPlantaId = targetPlanta.id;
        this.api.updatePlantaFiles(targetPlanta.id, formData).subscribe({
            next: (updatedPlanta) => {
                this.applyUpdatedPlanta(updatedPlanta);
                this.refreshPlantaAfterUpload(targetPlanta.id);
                this.uploadingPlantaId = null;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error updating plant files', err);
                this.uploadingPlantaId = null;
                alert('No se pudo actualizar el archivo de la planta.');
                this.cdr.detectChanges();
            }
        });
    }

    getPlantaFileUrl(fileType: 'plano' | 'corte'): string | null {
        const rawUrl = fileType === 'plano'
            ? this.plantaFilesTarget?.plano_imagen
            : this.plantaFilesTarget?.fichero_corte;
        return this.toAbsoluteFileUrl(rawUrl ?? null);
    }

    openPlantaFile(fileType: 'plano' | 'corte'): void {
        const canOpen = fileType === 'plano' ? this.plantaFileExists.plano : this.plantaFileExists.corte;
        if (!canOpen) return;
        const url = this.getPlantaFileUrl(fileType);
        if (!url) return;
        window.open(url, '_blank', 'noopener');
    }

    private applyUpdatedPlanta(updatedPlanta: Planta): void {
        const index = this.plantas.findIndex(p => p.id === updatedPlanta.id);
        if (index !== -1) {
            this.plantas[index] = updatedPlanta;
        }
        if (this.selectedPlanta?.id === updatedPlanta.id) {
            this.selectedPlanta = updatedPlanta;
        }
        if (this.plantaFilesTarget?.id === updatedPlanta.id) {
            this.plantaFilesTarget = updatedPlanta;
        }
    }

    private refreshPlantaAfterUpload(plantaId: number): void {
        if (!this.proyectoId) return;
        this.api.getPlantas(this.proyectoId).subscribe({
            next: (plantas) => {
                this.plantas = plantas.sort((a: Planta, b: Planta) => a.orden - b.orden);
                const refreshed = this.plantas.find(p => p.id === plantaId);
                if (refreshed) {
                    this.applyUpdatedPlanta(refreshed);
                }
                this.refreshPlantaFileAvailability();
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error refreshing plantas after upload', err);
            }
        });
    }

    private async refreshPlantaFileAvailability(): Promise<void> {
        this.checkingPlantaFiles = true;
        const planoUrl = this.getPlantaFileUrl('plano');
        const corteUrl = this.getPlantaFileUrl('corte');
        this.plantaFileExists.plano = await this.checkFileReachable(planoUrl);
        this.plantaFileExists.corte = await this.checkFileReachable(corteUrl);
        this.checkingPlantaFiles = false;
        this.cdr.detectChanges();
    }

    private async checkFileReachable(url: string | null): Promise<boolean> {
        if (!url) return false;
        try {
            const res = await fetch(url, { method: 'HEAD' });
            return res.ok;
        } catch {
            return false;
        }
    }

    private toAbsoluteFileUrl(url: string | null): string | null {
        if (!url) return null;
        if (/^https?:\/\//i.test(url)) return url;

        const apiBase = environment.apiUrl;
        let apiOrigin = '';
        if (/^https?:\/\//i.test(apiBase)) {
            apiOrigin = new URL(apiBase).origin;
        }

        if (url.startsWith('/')) {
            return apiOrigin ? `${apiOrigin}${url}` : url;
        }
        return apiOrigin ? `${apiOrigin}/${url}` : `/${url}`;
    }

    // =========================================================================
    // PHOTO GALLERY
    // =========================================================================
    openFotosModal(modulo: { id: number; nombre: string }, event?: Event): void {
        if (event) event.stopPropagation();
        this.fotosTarget = { id: modulo.id, nombre: modulo.nombre };
        this.showFotosModal = true;
        this.selectedFotoIndex = 0;
        this.loadFotos(modulo.id);
    }

    closeFotosModal(): void {
        this.showFotosModal = false;
        this.fotosTarget = null;
        this.fotos = [];
        this.selectedFotoIndex = 0;
    }

    prevFoto(): void {
        if (this.selectedFotoIndex > 0) this.selectedFotoIndex--;
    }

    nextFoto(): void {
        if (this.selectedFotoIndex < this.fotos.length - 1) this.selectedFotoIndex++;
    }

    downloadFotosPlanta(planta: Planta, event?: Event): void {
        if (event) event.stopPropagation();
        this.downloadingZip = true;
        this.api.downloadFotosZip({ planta: planta.id }).subscribe({
            next: (blob) => {
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `fotos_${planta.nombre}.zip`;
                a.click();
                window.URL.revokeObjectURL(url);
                this.downloadingZip = false;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error downloading ZIP', err);
                this.downloadingZip = false;
                alert('Error descargando fotos');
                this.cdr.detectChanges();
            }
        });
    }

    loadFotos(moduloId: number): void {
        this.loadingFotos = true;
        this.api.getFotos({ modulo: moduloId }).subscribe({
            next: (fotos) => {
                this.fotos = fotos;
                this.loadingFotos = false;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error loading fotos', err);
                this.loadingFotos = false;
                this.cdr.detectChanges();
            }
        });
    }

    getFotoUrl(foto: FotoFabricacion): string {
        return this.toAbsoluteFileUrl(foto.url) || '';
    }

    downloadFotosZip(scope: 'modulo' | 'planta' | 'proyecto'): void {
        this.downloadingZip = true;
        let params: { modulo?: number; planta?: number; proyecto?: number } = {};

        if (scope === 'modulo' && this.fotosTarget) {
            params.modulo = this.fotosTarget.id;
        } else if (scope === 'planta' && this.selectedPlanta) {
            params.planta = this.selectedPlanta.id;
        } else if (scope === 'proyecto' && this.proyectoId) {
            params.proyecto = this.proyectoId;
        }

        this.api.downloadFotosZip(params).subscribe({
            next: (blob) => {
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `fotos_${scope}.zip`;
                a.click();
                window.URL.revokeObjectURL(url);
                this.downloadingZip = false;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error downloading ZIP', err);
                this.downloadingZip = false;
                alert('Error descargando fotos');
                this.cdr.detectChanges();
            }
        });
    }

    getColorHex(code: string): string {
        const map: Record<string, string> = {
            y: '#eab308',  // yellow
            g: '#22c55e',  // green
            c: '#06b6d4',  // cyan
            v: '#8b5cf6',  // violet
            m: '#ec4899',  // magenta
            o: '#f97316',  // orange
        };
        return map[code] || '#9ca3af';
    }

    getColorLabel(code: string): string {
        const map: Record<string, string> = {
            y: 'Yellow', g: 'Green', c: 'Cyan',
            v: 'Violet', m: 'Magenta', o: 'Orange'
        };
        return map[code] || code;
    }
}
