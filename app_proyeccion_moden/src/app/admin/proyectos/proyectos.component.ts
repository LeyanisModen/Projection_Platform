import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, User, Proyecto } from '../../services/api.service';
import { forkJoin } from 'rxjs';
import { Router } from '@angular/router';
import { planningIssues, planningLabel, planningPace, queueOutOfOrder } from '../../shared/project-planning';
import { ordenarPorEdificio } from '../../shared/edificios';

interface ProjectGroup {
  username: string;
  userUrl: string;
  projects: Proyecto[];
  /** Proyectos archivados de todas las ferrallas, al final de la lista. */
  archived?: boolean;
}

/**
 * Listado de proyectos por ferralla y alta de proyecto.
 *
 * Un proyecto nace solo con nombre (y ferralla si se conoce): sirve para
 * gestionar fechas y validaciones previas antes de tener datos. Todo lo demas
 * (modulos, plano, documentos, plazo, limites) se completa desde su detalle,
 * al que se salta nada mas crearlo.
 */
@Component({
  selector: 'app-proyectos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './proyectos.component.html',
  styleUrls: ['../admin-theme.css', './proyectos.component.css']
})
export class ProyectosComponent implements OnInit {
  readonly planningPace = planningPace;
  readonly queueOutOfOrder = queueOutOfOrder;
  readonly planningIssues = planningIssues;
  readonly planningLabel = planningLabel;
  users: User[] = [];
  projects: Proyecto[] = [];
  groupedProjects: ProjectGroup[] = [];
  loading = false;
  error = '';
  showForm = false;
  newProject: { nombre: string; usuario: string | null } = { nombre: '', usuario: null };

  constructor(private api: ApiService, private router: Router, private cdr: ChangeDetectorRef) { }

  ngOnInit(): void {
    this.loadData();
  }

  loadData() {
    this.loading = true;
    forkJoin({
      users: this.api.getUsers(),
      projects: this.api.getProyectos()
    }).subscribe({
      next: (data) => {
        this.users = data.users;
        this.projects = data.projects;
        this.groupProjects();
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error loading data', err);
        this.error = 'Error cargando datos';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  groupProjects() {
    const groups: { [key: string]: ProjectGroup } = {};

    // Initialize groups for all users
    this.users.forEach(user => {
      groups[user.url] = {
        username: user.first_name || user.username,
        userUrl: user.url,
        projects: [],
      };
    });

    // Add "Sin Asignar" group
    groups['__unassigned__'] = {
      username: 'Sin ferralla',
      userUrl: '',
      projects: [],
    };

    // Distribute projects (los archivados van aparte, al final)
    const archived = this.projects.filter(project => project.archivado_at);
    this.projects.filter(project => !project.archivado_at).forEach(project => {
      if (project.usuario && groups[project.usuario]) {
        groups[project.usuario].projects.push(project);
      } else {
        groups['__unassigned__'].projects.push(project);
      }
    });

    // Solo ferrallas con proyectos; los sin ferralla van primero.
    const unassigned = groups['__unassigned__'];
    delete groups['__unassigned__'];

    // Dentro de cada ferralla, por edificio y de abajo arriba.
    Object.values(groups).forEach(group => group.projects = ordenarPorEdificio(group.projects));
    this.groupedProjects = Object.values(groups).filter(group => group.projects.length > 0);
    if (unassigned.projects.length > 0) {
      this.groupedProjects.unshift(unassigned);
    }
    if (archived.length > 0) {
      this.groupedProjects.push({ username: 'Archivados', userUrl: '__archived__', projects: archived, archived: true });
    }
  }

  /** Cabecera antes del primer forjado de cada edificio (si la ferralla tiene edificios). */
  edificioCabecera(group: ProjectGroup, index: number): string | null {
    if (group.archived || !group.projects.some(project => project.edificio)) return null;
    const project = group.projects[index];
    const anterior = group.projects[index - 1];
    if (anterior && (anterior.edificio ?? null) === (project.edificio ?? null)) return null;
    if (!project.edificio) return 'Sin edificio';
    const forjados = group.projects.filter(other => other.edificio === project.edificio).length;
    return `${project.edificio_nombre} · ${forjados} ${forjados === 1 ? 'forjado' : 'forjados'}`;
  }

  toggleForm() {
    this.showForm = !this.showForm;
    this.error = '';
    this.newProject = { nombre: '', usuario: null };
    this.cdr.detectChanges();
  }

  createProyecto() {
    const nombre = this.newProject.nombre.trim();
    if (!nombre || this.loading) return;
    this.error = '';
    this.loading = true;
    this.api.createProyecto({ nombre, usuario: this.newProject.usuario || null }).subscribe({
      next: (project) => {
        this.loading = false;
        this.manageProject(project);
      },
      error: (err) => {
        console.error('Error creating project', err);
        this.error = this.apiErrorMessage(err, 'Error creando el proyecto.');
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private apiErrorMessage(err: any, fallback: string): string {
    const payload = err?.error;
    if (typeof payload === 'string' && payload.trim()) return payload;
    if (payload?.message) return payload.message;
    if (payload?.detail) return payload.detail;
    if (payload && typeof payload === 'object') {
      const fieldErrors = Object.entries(payload)
        .flatMap(([key, value]) => {
          const messages = Array.isArray(value) ? value : [value];
          return messages.map(message => `${key}: ${message}`);
        });
      if (fieldErrors.length) return fieldErrors.join(' ');
    }
    return fallback;
  }

  manageProject(project: Proyecto) {
    this.router.navigate(['/admin-dashboard/proyectos', project.id]);
  }

  onProjectRowKeydown(event: KeyboardEvent, project: Proyecto): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.manageProject(project);
    }
  }

  confirmDelete(project: Proyecto) {
    if (confirm(`¿Eliminar proyecto ${project.nombre}?`)) {
      this.deleteProyecto(project.id);
    }
  }

  deleteProyecto(id: number) {
    this.loading = true;
    this.api.deleteProyecto(id).subscribe({
      next: () => {
        this.projects = this.projects.filter(p => p.id !== id);
        this.groupProjects();
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error deleting project', err);
        this.error = 'Error eliminando proyecto';
        this.loading = false;
      }
    });
  }
}
