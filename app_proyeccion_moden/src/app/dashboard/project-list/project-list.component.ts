import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Proyecto, ProyectoService } from '../../services/proyecto.service';

@Component({
    selector: 'app-project-list',
    standalone: true,
    imports: [CommonModule],
    templateUrl: './project-list.component.html',
    styleUrl: './project-list.component.css' // Corregido a styleUrl (Angular 17+)
})
export class ProjectListComponent implements OnInit {
    proyectos: Proyecto[] = [];
    loading = true;

    constructor(private proyectoService: ProyectoService) { }

    ngOnInit(): void {
        this.proyectoService.getProyectos().subscribe({
            next: (data) => {
                this.proyectos = data;
                this.loading = false;
            },
            error: (err) => {
                console.error('Error cargando proyectos', err);
                this.loading = false;
            }
        });
    }
}
