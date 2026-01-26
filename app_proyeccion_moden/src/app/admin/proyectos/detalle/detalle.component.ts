import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ApiService, Proyecto, Planta, Modulo } from '../../../services/api.service';
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

    constructor(
        private route: ActivatedRoute,
        private api: ApiService,
        private cdr: ChangeDetectorRef
    ) { }

    ngOnInit(): void {
        this.route.params.pipe(
            switchMap(params => {
                if (params['id']) {
                    this.proyectoId = +params['id'];
                    this.loading = true;
                    return forkJoin({
                        proyecto: this.api.getProyecto(this.proyectoId),
                        plantas: this.api.getPlantas(this.proyectoId)
                    });
                }
                return of(null);
            })
        ).subscribe({
            next: (data) => {
                console.log('Project Detail Data:', data);
                if (data && data.proyecto && data.plantas) {
                    this.proyecto = data.proyecto;
                    this.plantas = data.plantas.sort((a: Planta, b: Planta) => a.orden - b.orden);
                    this.loading = false;
                    console.log('Loading disabled, triggering CD');
                    this.cdr.detectChanges();
                } else {
                    console.error('Missing data in response', data);
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
}
