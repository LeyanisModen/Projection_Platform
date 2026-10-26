import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, User, Proyecto, ProyectoCheckResumen } from '../../services/api.service';
import { forkJoin } from 'rxjs';
import { Router } from '@angular/router';
import { planningIssues, planningLabel, planningPace, queueOutOfOrder } from '../../shared/project-planning';
import { ordenarPorEdificio } from '../../shared/edificios';

/** Una casilla de la lista de control en la fila del proyecto. */
interface CasillaCheck {
  completado: boolean;
  /** Pendiente con su fecha ya pasada. */
  vencido: boolean;
  texto: string;
}

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
  /** Casillas de la lista de control de cada proyecto, alineadas con la lista maestra
   *  (null donde el proyecto no tiene ese paso). */
  casillas = new Map<number, Array<CasillaCheck | null>>();
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
    this.calcularCasillas();
  }

  /** Una columna por paso de la lista maestra, en su orden, igual en todas las filas;
   *  los pasos propios de cada proyecto, al final. */
  private calcularCasillas(): void {
    const orden = new Map<number, number>();
    for (const project of this.projects) {
      for (const check of project.checks_resumen || []) {
        if (check.definicion !== null && !orden.has(check.definicion)) orden.set(check.definicion, check.orden);
      }
    }
    const columnas = [...orden.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([definicion]) => definicion);
    const hoy = formatDate(new Date(), 'yyyy-MM-dd', 'en-US');
    this.casillas = new Map();
    for (const project of this.projects) {
      const checks = project.checks_resumen || [];
      if (!checks.length) continue;
      const porDefinicion = new Map(checks.filter(c => c.definicion !== null).map(c => [c.definicion, c]));
      const propios = checks.filter(c => c.definicion === null || !orden.has(c.definicion));
      this.casillas.set(project.id, [
        ...columnas.map(definicion => porDefinicion.get(definicion) ?? null),
        ...propios,
      ].map(check => check ? this.casilla(check, hoy) : null));
    }
  }

  private casilla(check: ProyectoCheckResumen, hoy: string): CasillaCheck {
    const fecha = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
    const vencido = !check.completado && !!check.fecha_limite && check.fecha_limite < hoy;
    const texto = check.completado
      ? `${check.titulo} · hecho${check.completado_at ? ' el ' + formatDate(check.completado_at, 'dd/MM/yyyy', 'en-US') : ''}`
      : check.fecha_limite
        ? `${check.titulo} · ${vencido ? 'vencido el' : 'antes del'} ${fecha(check.fecha_limite)}`
        : `${check.titulo} · pendiente`;
    return { completado: check.completado, vencido, texto };
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
