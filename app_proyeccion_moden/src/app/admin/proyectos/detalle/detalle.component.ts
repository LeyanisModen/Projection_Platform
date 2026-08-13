import { Component, OnInit, ChangeDetectorRef, HostListener } from '@angular/core';
import { ElementRef, ViewChild } from '@angular/core';
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
    ApiService, Proyecto, Modulo, User, FotoFabricacion, Imagen,
    DetalleModuloFase, TechnicalImportStats, GrupoBastidor, GrupoBastidorModulo,
    EstrategiaBastidor, ModuloFase
} from '../../../services/api.service';
import { switchMap, forkJoin, of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ProjectTablePreviewComponent } from './project-table-preview.component';
import { ZoomableImageComponent } from '../../../shared/zoomable-image/zoomable-image.component';
import {
    appendModuleImportCandidate,
    ModuleImportCandidate,
    scanModuleImportFolder,
} from './module-import.utils';

@Component({
    selector: 'app-proyecto-detalle',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        RouterModule,
        DragDropModule,
        ProjectTablePreviewComponent,
        ZoomableImageComponent,
    ],
    templateUrl: './detalle.component.html',
    styleUrls: ['./detalle.component.css']
})
export class ProyectoDetailComponent implements OnInit {
    proyectoId: number | null = null;
    proyecto: Proyecto | null = null;
    modulos: Modulo[] = [];
    grupos: GrupoBastidor[] = [];
    users: User[] = [];

    loading = false;
    // Module status options
    statusOptions = ['PENDIENTE', 'EN_PROGRESO', 'COMPLETADO'];

    // Import State
    importing = false;
    importProgress = '';
    showModuleImportModal = false;
    moduleImportFolderName = '';
    moduleImportCandidates: ModuleImportCandidate[] = [];
    private moduleImportTechnicalDbFile: File | null = null;
    uploadingProjectFile = false;
    updatingSubmoduleId: number | null = null;
    showProjectFilesModal = false;
    checkingProjectFiles = false;
    projectFileExists = { plano: false, planilla: false };
    dropdownOpen = false;
    savingProjectConfig = false;
    editingProjectName = false;
    projectNameDraft = '';
    savingProjectName = false;
    @ViewChild('projectNameInput') projectNameInput?: ElementRef<HTMLInputElement>;
    technicalImporting = false;
    technicalImportStats: TechnicalImportStats | null = null;

    // Photo Gallery State
    showFotosModal = false;
    fotosTarget: { id: number; nombre: string } | null = null;
    fotos: FotoFabricacion[] = [];
    loadingFotos = false;
    downloadingZip = false;
    selectedFotoIndex = 0;
    showBastidorDownloadModal = false;
    selectedDownloadModuloIds: number[] = [];

    // Imported image sequence preview. This is read-only and never touches production state.
    showSecuenciaModal = false;
    secuenciaTarget: { id: number; nombre: string } | null = null;
    secuenciaImagenes: Imagen[] = [];
    secuenciaFase: ModuloFase = 'INFERIOR';
    selectedSecuenciaIndex = 0;
    loadingSecuencia = false;
    secuenciaImageErrors = new Set<number>();
    tablePreviewRevision = 0;

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

    @HostListener('document:keydown', ['$event'])
    onDocumentKeydown(event: KeyboardEvent): void {
        if (this.showModuleImportModal && event.key === 'Escape') {
            this.closeModuleImportSelection();
            event.preventDefault();
            return;
        }
        if (!this.showSecuenciaModal) return;
        if (event.key === 'Escape') {
            this.closeSecuenciaModal();
        } else if (event.key === 'ArrowLeft') {
            this.prevSecuenciaImagen();
        } else if (event.key === 'ArrowRight') {
            this.nextSecuenciaImagen();
        } else {
            return;
        }
        event.preventDefault();
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
            users: this.api.getUsers(),
            modulos: this.api.getModulos(this.proyectoId),
            grupos: this.api.getGruposBastidor(this.proyectoId)
        }).subscribe({
            next: (data) => {
                if (data && data.proyecto) {
                    this.proyecto = data.proyecto;
                    this.users = data.users || [];
                    this.modulos = data.modulos || [];
                    this.grupos = (data.grupos || []).sort((a, b) => a.indice - b.indice);
                    this.refreshTablePreview();

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

    startProjectNameEdit(): void {
        if (!this.proyecto) return;
        this.projectNameDraft = this.proyecto.nombre;
        this.editingProjectName = true;
        this.cdr.detectChanges();
        this.focusProjectNameInput();
    }

    private focusProjectNameInput(): void {
        setTimeout(() => {
            const input = this.projectNameInput?.nativeElement;
            if (!input) return;
            input.focus();
            input.select();
        });
    }

    cancelProjectNameEdit(): void {
        if (this.savingProjectName) return;
        this.editingProjectName = false;
        this.projectNameDraft = '';
        this.cdr.detectChanges();
    }

    saveProjectName(): void {
        if (!this.proyectoId || !this.proyecto) return;

        const target = this.projectNameDraft.trim();
        if (!target) {
            alert('El nombre del proyecto no puede estar vacio.');
            return;
        }

        if (target === this.proyecto.nombre) {
            this.cancelProjectNameEdit();
            return;
        }

        this.savingProjectName = true;
        this.api.updateProyecto(this.proyectoId, { nombre: target }).subscribe({
            next: (proyecto: Proyecto) => {
                this.proyecto = proyecto;
                this.projectNameDraft = '';
                this.editingProjectName = false;
                this.savingProjectName = false;
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error updating project name', err);
                this.savingProjectName = false;
                alert('No se pudo guardar el nombre del proyecto.');
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
        return modulo.movible ?? (modulo.estado === 'PENDIENTE');
    }

    moduloBloqueoTitle(modulo: GrupoBastidorModulo): string {
        return modulo.motivo_bloqueo || 'Este modulo ya no se puede reordenar';
    }

    /** Primer modulo bloqueado por estado o avance real. El bastidor inferior
     *  se fabrica desde abajo hacia arriba en el card, por lo que cualquier
     *  modulo nuevo debe quedar visualmente ANTES (encima) de esta frontera.
     *  -1 si todos son pendientes (o el bastidor esta vacio). */
    private _firstLockedIndex(
        grupo: GrupoBastidor,
        excludeModuloId?: number,
    ): number {
        return grupo.modulos
            .filter(m => m.id !== excludeModuloId)
            .findIndex(m => !this.isModuloMovible(m));
    }

    /** Predicate para cdkDropList: impide soltar por debajo del primer
     *  bloqueado, lo que adelantaría el modulo nuevo en la fabricación. */
    bastidorSortPredicate = (
        index: number,
        drag: { data: GrupoBastidorModulo },
        drop: { data: GrupoBastidor },
    ): boolean => {
        const grupo = drop?.data;
        if (!grupo) return true;
        const firstLocked = this._firstLockedIndex(grupo, drag.data.id);
        return firstLocked === -1 || index <= firstLocked;
    };

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

    /** Drop de un modulo en otro bastidor existente (o en el mismo para reordenar). */
    onModuloDropInBastidor(event: CdkDragDrop<GrupoBastidor>): void {
        const modulo = event.item.data as GrupoBastidorModulo;
        const destino = event.container.data as GrupoBastidor;
        const origen = event.previousContainer.data as GrupoBastidor;
        const indexDestino = event.currentIndex;

        if (!this.isModuloMovible(modulo)) {
            alert(this.moduloBloqueoTitle(modulo));
            return;
        }

        // Defensa redundante: si por cualquier razon el drop cae debajo de
        // modulos ya fabricados, llevarlo al primer hueco seguro por encima.
        // INF recorre el card en sentido inverso: abajo se fabrica primero.
        const destinoSinArrastrado: GrupoBastidorModulo[] = destino.modulos
            .filter(m => m.id !== modulo.id);
        const firstLocked = destinoSinArrastrado.findIndex(
            m => !this.isModuloMovible(m),
        );
        const indexClamped = firstLocked === -1
            ? indexDestino
            : Math.min(indexDestino, firstLocked);

        const sameGroup = event.previousContainer === event.container;
        if (sameGroup) {
            // Intra-bastidor: solo persiste si cambio realmente de posicion.
            if (event.previousIndex === event.currentIndex) return;
            moveItemInArray(destino.modulos, event.previousIndex, indexClamped);
        } else {
            transferArrayItem(origen.modulos, destino.modulos, event.previousIndex, indexClamped);
        }

        this.movingModulo = true;
        this.api.moveModuloEntreBastidores(modulo.id, destino.id, indexClamped).subscribe({
            next: (grupos) => {
                this.grupos = grupos.sort((a, b) => a.indice - b.indice);
                this.movingModulo = false;
                this.refreshTablePreview();
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
            alert(this.moduloBloqueoTitle(modulo));
            return;
        }
        this.movingModulo = true;
        this.api.moveModuloEntreBastidores(modulo.id, null, 0).subscribe({
            next: (grupos) => {
                this.grupos = grupos.sort((a, b) => a.indice - b.indice);
                this.movingModulo = false;
                this.refreshTablePreview();
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
                this.refreshTablePreview();
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
                this.refreshTablePreview();
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

    grupoFotosCount(grupo: GrupoBastidor): number {
        return grupo.modulos.reduce((total, modulo) => total + (modulo.fotos_count || 0), 0);
    }

    hasAnyGrupoFotos(): boolean {
        return this.grupos.some(grupo => this.grupoFotosCount(grupo) > 0);
    }

    grupoDownloadName(grupo: GrupoBastidor): string {
        return grupo.nombre || `Bastidor ${grupo.indice}`;
    }

    grupoDownloadModuloIds(grupo: GrupoBastidor): number[] {
        return this.grupoDownloadModulos(grupo)
            .map(modulo => modulo.id);
    }

    grupoDownloadModulos(grupo: GrupoBastidor): GrupoBastidorModulo[] {
        return grupo.modulos
            .filter(modulo => (modulo.fotos_count || 0) > 0)
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
                this.refreshTablePreview();
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

    reiniciarFaseModulo(
        modulo: GrupoBastidorModulo,
        fase: ModuloFase,
        event?: Event
    ): void {
        event?.stopPropagation();

        const faseLabel = fase === 'INFERIOR' ? 'INF' : 'SUP';
        const detalleSd = fase === 'SUPERIOR'
            ? ' Tambien se repetiran SD_S y SD_D si existen.'
            : '';
        const confirmed = confirm(
            `Reiniciar solo la fase ${faseLabel} de ${modulo.nombre}?${detalleSd} ` +
            'La otra fase se conservara y tendras que volver a planificar.'
        );
        if (!confirmed) return;

        this.api.reiniciarFaseModulo(modulo.id, fase).subscribe({
            next: () => {
                this.loadData();
            },
            error: (err: any) => {
                console.error(`Error reiniciando fase ${fase}`, err);
                alert(`Error al reiniciar la fase ${faseLabel}`);
                this.cdr.detectChanges();
            }
        });
    }

    completarFaseModulo(
        modulo: GrupoBastidorModulo,
        fase: ModuloFase,
        event?: Event
    ): void {
        event?.stopPropagation();
        const faseLabel = fase === 'INFERIOR' ? 'INF' : 'SUP';

        this.api.completarFaseModulo(modulo.id, fase).subscribe({
            next: () => {
                this.loadData();
            },
            error: (err: any) => {
                console.error(`Error completando fase ${fase}`, err);
                alert(`Error al completar la fase ${faseLabel}`);
                this.cdr.detectChanges();
            }
        });
    }

    toggleFaseModulo(
        modulo: GrupoBastidorModulo,
        fase: ModuloFase,
        event: Event
    ): void {
        event.stopPropagation();
        const completada = fase === 'INFERIOR'
            ? modulo.inferior_hecho
            : modulo.superior_hecho;

        if (completada) {
            this.reiniciarFaseModulo(modulo, fase);
            return;
        }
        this.completarFaseModulo(modulo, fase);
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

    loadModulos() {
        if (!this.proyectoId) return;
        this.loading = true;
        this.api.getModulos(this.proyectoId).subscribe({
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

    async importModulesFromFolder(): Promise<void> {
        if (!this.proyectoId || this.importing) return;

        try {
            const projectHandle = await (window as any).showDirectoryPicker();
            if (!projectHandle) return;

            this.importing = true;
            this.importProgress = `Analizando carpeta: ${projectHandle.name}...`;
            this.cdr.detectChanges();

            const { candidates, technicalDbFile, rootIssues } = await scanModuleImportFolder(
                projectHandle,
                this.modulos.map(modulo => modulo.nombre),
                folderName => {
                    this.importProgress = `Revisando módulo: ${folderName}...`;
                    this.cdr.detectChanges();
                }
            );
            if (candidates.length === 0) {
                this.importing = false;
                this.importProgress = '';
                alert('No se encontraron módulos con carpetas INF, SUP, SD_S o SD_D.');
                this.cdr.detectChanges();
                return;
            }

            this.moduleImportFolderName = projectHandle.name;
            this.moduleImportCandidates = candidates;
            this.moduleImportTechnicalDbFile = technicalDbFile;
            this.showModuleImportModal = true;
            this.importing = false;
            this.importProgress = '';
            this.cdr.detectChanges();
            if (rootIssues.length) {
                alert([
                    'La carpeta contiene incidencias en los archivos generales:',
                    '',
                    ...rootIssues.map(issue => `• ${issue}`),
                ].join('\n'));
            }
        } catch (err: any) {
            this.importing = false;
            this.importProgress = '';
            if (err.name !== 'AbortError') {
                console.error('Error reading folder:', err);
                alert('Error leyendo la carpeta: ' + err.message);
            }
            this.cdr.detectChanges();
        }
    }

    get selectedModuleImportCount(): number {
        return this.moduleImportCandidates.filter(candidate => candidate.selected).length;
    }

    get newModuleImportCount(): number {
        return this.moduleImportCandidates.filter(
            candidate => candidate.valid && !candidate.alreadyImported
        ).length;
    }

    get invalidModuleImportCount(): number {
        return this.moduleImportCandidates.filter(candidate => !candidate.valid).length;
    }

    selectOnlyNewModuleImports(): void {
        this.moduleImportCandidates.forEach(candidate => {
            candidate.selected = candidate.valid && !candidate.alreadyImported;
        });
    }

    clearModuleImportSelection(): void {
        this.moduleImportCandidates.forEach(candidate => candidate.selected = false);
    }

    closeModuleImportSelection(): void {
        this.showModuleImportModal = false;
        this.moduleImportFolderName = '';
        this.moduleImportCandidates = [];
        this.moduleImportTechnicalDbFile = null;
    }

    confirmModuleImportSelection(): void {
        if (!this.proyectoId || this.selectedModuleImportCount === 0) return;

        const selectedCandidates = this.moduleImportCandidates.filter(candidate => candidate.selected);
        const invalidCandidates = this.moduleImportCandidates.filter(candidate => !candidate.valid);
        const technicalDbFile = this.moduleImportTechnicalDbFile;
        this.showModuleImportModal = false;
        void this.uploadSelectedModules(
            selectedCandidates,
            technicalDbFile,
            invalidCandidates
        );
    }

    private async uploadSelectedModules(
        selectedCandidates: ModuleImportCandidate[],
        technicalDbFile: File | null,
        invalidCandidates: ModuleImportCandidate[] = []
    ): Promise<void> {
        if (!this.proyectoId) return;

        this.importing = true;
        const formData = new FormData();
        const modulesData: any[] = [];

        try {
            for (const candidate of selectedCandidates) {
                this.importProgress = `Procesando módulo: ${candidate.moduleName}...`;
                this.cdr.detectChanges();

                modulesData.push(
                    appendModuleImportCandidate(formData, candidate)
                );
            }

            this.importProgress = 'Subiendo datos...';
            this.cdr.detectChanges();
            formData.append('modulos', JSON.stringify(modulesData));
            formData.append('strict_validation', 'true');
            formData.append('client_module_errors', JSON.stringify(
                invalidCandidates.map(candidate => ({
                    module: candidate.moduleName,
                    folder: candidate.folderName,
                    errors: candidate.issues,
                }))
            ));
            if (technicalDbFile) {
                formData.append('technical_file', technicalDbFile);
            }

            this.closeModuleImportSelection();
            this.api.importProjectStructure(this.proyectoId, formData).subscribe({
                next: (res) => {
                    this.importing = false;
                    this.importProgress = '';
                    const stats = res.stats;
                    const lines: string[] = [
                        'Módulos importados correctamente.',
                        '',
                        `• Módulos creados: ${stats.modulos || 0}`,
                        `• Imágenes cargadas: ${stats.imagenes || 0}`,
                        `• Plano de referencia: ${stats.plano_cargado ? 'sí' : 'no'}`,
                        `• Planilla (corte): ${stats.planilla_cargada ? 'sí' : 'no'}`,
                    ];
                    if (technicalDbFile) {
                        lines.push(stats.base_tecnica_actualizada
                            ? `• Base de datos técnica: guardada y aplicada (${stats.detalles_fase || 0} fases)`
                            : '• Base de datos técnica: no se pudo importar');
                    } else if (stats.detalles_fase) {
                        lines.push(
                            `• Datos técnicos recuperados de la base guardada: ${stats.detalles_fase} fases`
                        );
                    }
                    if (stats.errors?.length) {
                        lines.push('', `⚠ ${stats.errors.length} incidencias:`);
                        for (const moduleError of stats.module_errors || []) {
                            lines.push(
                                `• ${moduleError.module}: ${moduleError.errors.join(' ')}`
                            );
                        }
                    }
                    alert(lines.join('\n'));
                    this.loadData();
                },
                error: (err) => {
                    console.error('Error uploading modules', err);
                    this.importing = false;
                    this.importProgress = '';
                    alert(
                        err?.error?.message ||
                        err?.error?.detail ||
                        'Error importando los módulos'
                    );
                    this.cdr.detectChanges();
                }
            });
        } catch (err: any) {
            console.error('Error reading selected module folders', err);
            this.importing = false;
            this.importProgress = '';
            this.closeModuleImportSelection();
            alert('Error leyendo los módulos seleccionados: ' + err.message);
            this.cdr.detectChanges();
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
        const validExtensions = ['.json', '.csv', '.db', '.sqlite', '.sqlite3'];
        if (!validExtensions.some(extension => lowerName.endsWith(extension))) {
            alert('El fichero técnico debe ser JSON, CSV o SQLite.');
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

    triggerProjectFileUpload(fileInput: HTMLInputElement): void {
        fileInput.value = '';
        fileInput.click();
    }

    openProjectFilesModal(event?: Event): void {
        if (event) {
            event.stopPropagation();
        }
        this.showProjectFilesModal = true;
        this.refreshProjectFileAvailability();
    }

    closeProjectFilesModal(): void {
        this.showProjectFilesModal = false;
        this.projectFileExists = { plano: false, planilla: false };
        this.checkingProjectFiles = false;
    }

    onProjectFileSelected(event: Event, fileType: 'plano' | 'planilla'): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        if (!this.proyectoId) return;

        const fileName = file.name.toLowerCase();
        if (!fileName.endsWith('.pdf') && file.type !== 'application/pdf') {
            alert(`${fileType === 'plano' ? 'El plano' : 'La planilla'} debe ser un archivo PDF.`);
            return;
        }

        const formData = new FormData();
        formData.append(fileType === 'plano' ? 'plano_archivo' : 'planilla_archivo', file);

        this.uploadingProjectFile = true;
        this.api.updateProyectoFiles(this.proyectoId, formData).subscribe({
            next: (updatedProject) => {
                this.proyecto = updatedProject;
                this.uploadingProjectFile = false;
                this.refreshProjectFileAvailability();
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error updating project files', err);
                this.uploadingProjectFile = false;
                alert(err?.error?.[fileType === 'plano' ? 'plano_archivo' : 'planilla_archivo']?.[0]
                    || 'No se pudo actualizar el archivo del proyecto.');
                this.cdr.detectChanges();
            }
        });
    }

    getProjectFileUrl(fileType: 'plano' | 'planilla'): string | null {
        const rawUrl = fileType === 'plano'
            ? this.proyecto?.plano_archivo
            : this.proyecto?.planilla_archivo;
        return this.toAbsoluteFileUrl(rawUrl ?? null);
    }

    openProjectFile(fileType: 'plano' | 'planilla'): void {
        const canOpen = this.projectFileExists[fileType];
        if (!canOpen) return;
        const url = this.getProjectFileUrl(fileType);
        if (!url) return;
        window.open(url, '_blank', 'noopener');
    }

    private async refreshProjectFileAvailability(): Promise<void> {
        this.checkingProjectFiles = true;
        const planoUrl = this.getProjectFileUrl('plano');
        const planillaUrl = this.getProjectFileUrl('planilla');
        this.projectFileExists.plano = await this.checkFileReachable(planoUrl);
        this.projectFileExists.planilla = await this.checkFileReachable(planillaUrl);
        this.checkingProjectFiles = false;
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
    // IMPORTED IMAGE SEQUENCE PREVIEW (READ-ONLY)
    // =========================================================================
    openSecuenciaModal(modulo: { id: number; nombre: string }, event?: Event): void {
        event?.stopPropagation();
        this.secuenciaTarget = { id: modulo.id, nombre: modulo.nombre };
        this.showSecuenciaModal = true;
        this.secuenciaImagenes = [];
        this.secuenciaFase = 'INFERIOR';
        this.selectedSecuenciaIndex = 0;
        this.secuenciaImageErrors.clear();
        this.loadingSecuencia = true;

        this.api.getModuloImagenes(modulo.id).subscribe({
            next: (imagenes) => {
                this.secuenciaImagenes = [...imagenes].sort((a, b) =>
                    a.fase.localeCompare(b.fase) || a.orden - b.orden || a.version - b.version
                );
                if (!this.secuenciaImagenes.some(imagen => imagen.fase === 'INFERIOR')) {
                    this.secuenciaFase = 'SUPERIOR';
                }
                this.selectedSecuenciaIndex = 0;
                this.loadingSecuencia = false;
                this.cdr.detectChanges();
            },
            error: (err) => {
                console.error('Error loading imported image sequence', err);
                this.loadingSecuencia = false;
                this.cdr.detectChanges();
            }
        });
    }

    closeSecuenciaModal(): void {
        this.showSecuenciaModal = false;
        this.secuenciaTarget = null;
        this.secuenciaImagenes = [];
        this.selectedSecuenciaIndex = 0;
        this.secuenciaImageErrors.clear();
    }

    get secuenciaImagenesFase(): Imagen[] {
        return this.secuenciaImagenes.filter(imagen => imagen.fase === this.secuenciaFase);
    }

    get secuenciaImagenActual(): Imagen | null {
        return this.secuenciaImagenesFase[this.selectedSecuenciaIndex] || null;
    }

    secuenciaFaseCount(fase: ModuloFase): number {
        return this.secuenciaImagenes.filter(imagen => imagen.fase === fase).length;
    }

    secuenciaMarcadoresCount(): number {
        return this.secuenciaImagenes.filter(imagen => !!this.getSecuenciaMarker(imagen)).length;
    }

    selectSecuenciaFase(fase: ModuloFase): void {
        this.secuenciaFase = fase;
        this.selectedSecuenciaIndex = 0;
    }

    selectSecuenciaImagen(index: number): void {
        if (index < 0 || index >= this.secuenciaImagenesFase.length) return;
        this.selectedSecuenciaIndex = index;
    }

    prevSecuenciaImagen(): void {
        if (this.selectedSecuenciaIndex > 0) this.selectedSecuenciaIndex--;
    }

    nextSecuenciaImagen(): void {
        if (this.selectedSecuenciaIndex < this.secuenciaImagenesFase.length - 1) {
            this.selectedSecuenciaIndex++;
        }
    }

    getSecuenciaImagenUrl(imagen: Imagen): string {
        return this.toAbsoluteFileUrl(imagen.src || imagen.url) || '';
    }

    getSecuenciaArchivoNombre(imagen: Imagen): string {
        if (imagen.archivo_nombre) return imagen.archivo_nombre;
        const rawName = (imagen.url || '').split('/').pop() || imagen.nombre;
        try {
            return decodeURIComponent(rawName);
        } catch {
            return rawName;
        }
    }

    getSecuenciaMarker(imagen: Imagen): 'WARNING' | 'CHECK' | 'FOTO' | null {
        const fileName = this.getSecuenciaArchivoNombre(imagen).toUpperCase();
        if (fileName.includes('WARNING')) return 'WARNING';
        if (/(CHECK|CHCK|COMPROB)/.test(fileName)) return 'CHECK';
        if (fileName.includes('FOTO')) return 'FOTO';
        return null;
    }

    onSecuenciaImageError(imagen: Imagen): void {
        this.secuenciaImageErrors.add(imagen.id);
        this.cdr.detectChanges();
    }

    // =========================================================================
    // PHOTO GALLERY
    // =========================================================================
    openBastidorDownloadModal(event?: Event): void {
        event?.stopPropagation();
        const gruposConFotos = this.grupos.filter(grupo => this.grupoFotosCount(grupo) > 0);
        const terminadosConFotos = gruposConFotos.filter(grupo => this.isGrupoCompletado(grupo));
        const preselected = terminadosConFotos.length ? terminadosConFotos : gruposConFotos;

        this.selectedDownloadModuloIds = preselected.flatMap(grupo => this.grupoDownloadModuloIds(grupo));
        this.showBastidorDownloadModal = true;
        this.cdr.detectChanges();
    }

    closeBastidorDownloadModal(): void {
        if (this.downloadingZip) return;
        this.showBastidorDownloadModal = false;
        this.selectedDownloadModuloIds = [];
        this.cdr.detectChanges();
    }

    isDownloadGrupoSelected(grupo: GrupoBastidor): boolean {
        const moduloIds = this.grupoDownloadModuloIds(grupo);
        return moduloIds.length > 0
            && moduloIds.every(id => this.selectedDownloadModuloIds.includes(id));
    }

    isDownloadGrupoIndeterminate(grupo: GrupoBastidor): boolean {
        const moduloIds = this.grupoDownloadModuloIds(grupo);
        if (moduloIds.length === 0) return false;
        const selectedCount = moduloIds.filter(id => this.selectedDownloadModuloIds.includes(id)).length;
        return selectedCount > 0 && selectedCount < moduloIds.length;
    }

    toggleDownloadGrupo(grupo: GrupoBastidor, event: Event): void {
        const checked = (event.target as HTMLInputElement).checked;
        const moduloIds = this.grupoDownloadModuloIds(grupo);
        if (checked) {
            this.selectedDownloadModuloIds = Array.from(new Set([
                ...this.selectedDownloadModuloIds,
                ...moduloIds,
            ]));
        } else {
            this.selectedDownloadModuloIds = this.selectedDownloadModuloIds
                .filter(id => !moduloIds.includes(id));
        }
    }

    isDownloadModuloSelected(modulo: GrupoBastidorModulo): boolean {
        return this.selectedDownloadModuloIds.includes(modulo.id);
    }

    toggleDownloadModulo(modulo: GrupoBastidorModulo, event: Event): void {
        const checked = (event.target as HTMLInputElement).checked;
        if (checked) {
            if (!this.selectedDownloadModuloIds.includes(modulo.id)) {
                this.selectedDownloadModuloIds = [...this.selectedDownloadModuloIds, modulo.id];
            }
        } else {
            this.selectedDownloadModuloIds = this.selectedDownloadModuloIds
                .filter(id => id !== modulo.id);
        }
    }

    selectDownloadGrupos(mode: 'terminados' | 'conFotos' | 'none'): void {
        if (mode === 'none') {
            this.selectedDownloadModuloIds = [];
            return;
        }

        const grupos = this.grupos.filter(grupo => {
            const hasFotos = this.grupoFotosCount(grupo) > 0;
            return mode === 'conFotos'
                ? hasFotos
                : hasFotos && this.isGrupoCompletado(grupo);
        });
        this.selectedDownloadModuloIds = grupos.flatMap(grupo => this.grupoDownloadModuloIds(grupo));
    }

    selectedDownloadGruposCount(): number {
        return this.grupos.filter(grupo => {
            const moduloIds = this.grupoDownloadModuloIds(grupo);
            return moduloIds.some(id => this.selectedDownloadModuloIds.includes(id));
        }).length;
    }

    selectedDownloadModulosCount(): number {
        return this.selectedDownloadModuloIds.length;
    }

    selectedDownloadFotosCount(): number {
        return this.grupos
            .flatMap(grupo => grupo.modulos)
            .filter(modulo => this.selectedDownloadModuloIds.includes(modulo.id))
            .reduce((total, modulo) => total + (modulo.fotos_count || 0), 0);
    }

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

    downloadSelectedBastidores(): void {
        if (!this.proyectoId || this.selectedDownloadModuloIds.length === 0) {
            alert('Selecciona al menos un modulo con fotos.');
            return;
        }

        this.downloadingZip = true;
        const moduloIds = [...this.selectedDownloadModuloIds];

        this.api.downloadFotosZip({
            proyecto: this.proyectoId,
            modulo: moduloIds
        }).subscribe({
            next: (blob) => {
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = moduloIds.length === 1 ? 'fotos_modulo.zip' : 'fotos_modulos.zip';
                a.click();
                window.URL.revokeObjectURL(url);
                this.downloadingZip = false;
                this.showBastidorDownloadModal = false;
                this.selectedDownloadModuloIds = [];
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

    eliminarModulo(modulo: GrupoBastidorModulo, event?: Event): void {
        event?.stopPropagation();
        const fotosCount = modulo.fotos_count || 0;
        const fotosWarning = fotosCount > 0
            ? ` Tambien se eliminaran ${fotosCount} foto${fotosCount === 1 ? '' : 's'} asociada${fotosCount === 1 ? '' : 's'}.`
            : '';
        const confirmed = confirm(
            `Eliminar definitivamente ${modulo.nombre}? ` +
            'Se quitaran sus imagenes y sus asignaciones de las mesas.' +
            fotosWarning + ' Esta accion no se puede deshacer.'
        );
        if (!confirmed) return;

        this.api.deleteModulo(modulo.id, true).subscribe({
            next: () => this.loadData(),
            error: (err: any) => {
                console.error('Error eliminando modulo', err);
                alert(err?.error?.detail || 'No se pudo eliminar el modulo.');
                this.cdr.detectChanges();
            }
        });
    }

    downloadFotosZip(scope: 'modulo' | 'proyecto'): void {
        this.downloadingZip = true;
        let params: { modulo?: number; proyecto?: number } = {};

        if (scope === 'modulo' && this.fotosTarget) {
            params.modulo = this.fotosTarget.id;
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

    private refreshTablePreview(): void {
        this.tablePreviewRevision += 1;
    }

    onPreviewGroupsChanged(grupos: GrupoBastidor[]): void {
        this.grupos = grupos.sort((a, b) => a.indice - b.indice);
        this.refreshTablePreview();
        this.cdr.detectChanges();
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
