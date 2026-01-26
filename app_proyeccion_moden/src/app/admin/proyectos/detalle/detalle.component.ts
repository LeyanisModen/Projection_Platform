import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ApiService, Proyecto, Planta, Modulo, User } from '../../../services/api.service';
import { switchMap, forkJoin, of } from 'rxjs';

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

    constructor(
        private route: ActivatedRoute,
        private api: ApiService,
        private cdr: ChangeDetectorRef
    ) { }

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

    // Update module status
    updateModuloStatus(modulo: Modulo, newStatus: string): void {
        console.log('CLICKED updateModuloStatus', modulo.id, newStatus);

        if (modulo.estado === newStatus) {
            console.log('Status is already', newStatus, 'skipping');
            return;
        }

        this.api.updateModulo(modulo.id, { estado: newStatus }).subscribe({
            next: (updated: Modulo) => {
                console.log('Update success', updated);
                const index = this.modulos.findIndex(m => m.id === modulo.id);
                if (index !== -1) {
                    this.modulos[index] = updated;
                }
                this.cdr.detectChanges();
            },
            error: (err: any) => {
                console.error('Error updating module status', err);
                alert('Error al cambiar el estado del módulo');
            }
        });
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
}
