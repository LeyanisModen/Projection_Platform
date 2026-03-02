import { Component, OnInit, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ApiService, Proyecto, Planta, Modulo, User, FotoFabricacion } from '../../../services/api.service';
import { switchMap, forkJoin, of } from 'rxjs';
import { environment } from '../../../../environments/environment';

@Component({
    selector: 'app-proyecto-detalle',
    standalone: true,
    imports: [CommonModule, FormsModule, RouterModule],
    templateUrl: './detalle.component.html',
    styleUrls: ['./detalle.component.css']
})
export class ProyectoDetailComponent implements OnInit {
    proyectoId: number | null = null;
    proyecto: Proyecto | null = null;
    plantas: Planta[] = [];
    selectedPlanta: Planta | null = null;
    modulos: Modulo[] = [];
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

    // Photo Gallery State
    showFotosModal = false;
    fotosTarget: Modulo | null = null;
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
            users: this.api.getUsers()
        }).subscribe({
            next: (data) => {
                if (data && data.proyecto && data.plantas) {
                    this.proyecto = data.proyecto;
                    this.plantas = data.plantas.sort((a: Planta, b: Planta) => a.orden - b.orden);
                    this.users = data.users || [];
                    if (this.plantas.length > 0 && !this.selectedPlanta) {
                        this.selectPlanta(this.plantas[0]);
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

    togglePlantaForm() {
        this.showPlantaForm = !this.showPlantaForm;
        // Auto-suggest next order
        if (this.showPlantaForm && this.plantas.length > 0) {
            const maxOrder = Math.max(...this.plantas.map(p => p.orden));
            this.newPlanta.orden = maxOrder + 1;
            this.newPlanta.nombre = `Planta ${this.plantas.length + 1}`;
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
            const plantaHandle = await (window as any).showDirectoryPicker();
            if (!plantaHandle) return;

            this.importing = true;
            this.importProgress = `Analizando carpeta: ${plantaHandle.name}...`;
            this.cdr.detectChanges();

            const formData = new FormData();
            const validExtensions = ['.png', '.jpg', '.jpeg'];

            // Calculate next order
            const nextOrder = this.plantas.length > 0
                ? Math.max(...this.plantas.map(p => p.orden)) + 1
                : 1;

            const plantaData: any = {
                nombre: plantaHandle.name,
                orden: nextOrder,
                modulos: []
            };

            // Iterate modules (children of plantaHandle)
            for await (const [moduloName, moduloHandle] of (plantaHandle as any).entries()) {
                if (moduloHandle.kind !== 'directory') continue;

                this.importProgress = `Procesando módulo: ${moduloName}...`;
                this.cdr.detectChanges();

                const moduloData: any = {
                    nombre: moduloName,
                    imagenes: []
                };

                // Check for INF and SUP subfolders
                for await (const [faseName, faseHandle] of moduloHandle.entries()) {
                    if (faseHandle.kind !== 'directory') continue;

                    const faseNormalizada = faseName.toUpperCase();
                    if (faseNormalizada !== 'INF' && faseNormalizada !== 'SUP') continue;

                    const fase = faseNormalizada === 'INF' ? 'INFERIOR' : 'SUPERIOR';
                    let ordenImg = 1;

                    // Read images in fase folder
                    for await (const [fileName, fileHandle] of faseHandle.entries()) {
                        if (fileHandle.kind !== 'file') continue;

                        const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
                        if (!validExtensions.includes(ext) && ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') continue;

                        const file = await fileHandle.getFile();
                        // Append file to FormData with filename as key
                        formData.append(fileName, file);

                        moduloData.imagenes.push({
                            filename: fileName,
                            fase: fase,
                            orden: ordenImg++
                        });
                    }
                }
                plantaData.modulos.push(moduloData);
            }

            this.importProgress = 'Subiendo datos...';
            this.cdr.detectChanges();

            // Add structure to FormData
            formData.append('plantas', JSON.stringify([plantaData]));

            // Upload
            this.api.importProjectStructure(this.proyectoId, formData).subscribe({
                next: (res) => {
                    this.importing = false;
                    this.importProgress = '';
                    alert(`Planta importada correctamente: ${res.stats.modulos} módulos creados.`);
                    this.loadData();
                },
                error: (err) => {
                    console.error('Error uploading plant', err);
                    this.importing = false;
                    this.importProgress = '';
                    alert('Error importando la planta');
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
    openFotosModal(modulo: Modulo, event?: Event): void {
        if (event) event.stopPropagation();
        this.fotosTarget = modulo;
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

    getColorHex(color: string): string {
        const map: Record<string, string> = {
            pink: '#ec4899',
            green: '#22c55e',
            blue: '#3b82f6',
            yellow: '#eab308',
            orange: '#f97316',
            purple: '#a855f7'
        };
        return map[color] || '#9ca3af';
    }
}
