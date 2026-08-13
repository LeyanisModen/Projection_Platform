import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, User, Proyecto } from '../../services/api.service';
import { forkJoin } from 'rxjs';
import { Router } from '@angular/router';
import {
  appendModuleImportCandidate,
  ModuleImportScanResult,
  scanModuleImportFolder,
} from './detalle/module-import.utils';

interface ProjectGroup {
  username: string;
  userUrl: string;
  projects: Proyecto[];
  collapsed: boolean;
}

interface ImportStats {
  modulos: number;
  imagenes: number;
  detalles_fase?: number;
  plano_cargado?: boolean;
  planilla_cargada?: boolean;
  base_tecnica_actualizada?: boolean;
  modulos_omitidos?: number;
  module_errors?: Array<{
    module: string;
    folder: string;
    errors: string[];
  }>;
  errors: string[];
}

interface ProjectCreationReport {
  projectName: string;
  stats: ImportStats;
}

@Component({
  selector: 'app-proyectos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './proyectos.component.html',
  styleUrls: ['./proyectos.component.css']
})
export class ProyectosComponent implements OnInit {
  users: User[] = [];
  projects: Proyecto[] = [];
  groupedProjects: ProjectGroup[] = [];
  loading = false;
  error = '';
  showForm = false;
  newProject: any = { nombre: '', usuario: null };

  // Folder import state
  selectedFolder: FileSystemDirectoryHandle | null = null;
  folderName: string = '';
  importProgress: string = '';
  importing = false;
  importStats: ImportStats | null = null;
  folderScan: ModuleImportScanResult | null = null;
  creationReport: ProjectCreationReport | null = null;

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
        collapsed: false
      };
    });

    // Add "Sin Asignar" group
    groups['__unassigned__'] = {
      username: 'Sin Asignar',
      userUrl: '',
      projects: [],
      collapsed: false
    };

    // Distribute projects
    this.projects.forEach(project => {
      if (project.usuario && groups[project.usuario]) {
        groups[project.usuario].projects.push(project);
      } else {
        groups['__unassigned__'].projects.push(project);
      }
    });

    // Convert to array, put "Sin Asignar" first if it has projects
    const unassigned = groups['__unassigned__'];
    delete groups['__unassigned__'];

    this.groupedProjects = Object.values(groups);
    if (unassigned.projects.length > 0) {
      this.groupedProjects.unshift(unassigned);
    }
  }

  toggleForm() {
    this.showForm = !this.showForm;
    this.error = '';
    this.selectedFolder = null;
    this.folderName = '';
    this.importStats = null;
    this.folderScan = null;
    this.creationReport = null;
  }

  async selectFolder() {
    try {
      const dirHandle = await (window as any).showDirectoryPicker();
      this.selectedFolder = dirHandle;
      this.folderName = dirHandle.name;
      this.folderScan = null;
      this.creationReport = null;
      this.error = '';
      if (!this.newProject.nombre) {
        this.newProject.nombre = dirHandle.name;
      }

      this.importing = true;
      this.importProgress = 'Analizando la estructura completa...';
      this.cdr.detectChanges();
      this.folderScan = await scanModuleImportFolder(
        dirHandle,
        [],
        folderName => {
          this.importProgress = `Revisando modulo: ${folderName}...`;
          this.cdr.detectChanges();
        }
      );
      this.importing = false;
      this.importProgress = '';

      if (this.validFolderModules.length === 0) {
        this.error = this.folderScan.candidates.length
          ? 'No hay ningun modulo valido. Corrige las incidencias indicadas antes de crear el proyecto.'
          : 'No se encontraron carpetas de modulos en la carpeta seleccionada.';
      }
      this.cdr.detectChanges();
    } catch (err: any) {
      this.importing = false;
      this.importProgress = '';
      if (err.name !== 'AbortError') {
        console.error('Error selecting folder:', err);
        this.error = 'Error leyendo la carpeta: ' + (err.message || 'error desconocido');
        this.cdr.detectChanges();
      }
    }
  }

  get validFolderModules() {
    return this.folderScan?.candidates.filter(candidate => candidate.valid) || [];
  }

  get invalidFolderModules() {
    return this.folderScan?.candidates.filter(candidate => !candidate.valid) || [];
  }

  get canCreateSelectedProject(): boolean {
    return !this.selectedFolder || this.validFolderModules.length > 0;
  }

  async createProyecto() {
    this.error = '';

    const projectData: any = {
      nombre: this.newProject.nombre,
      usuario: this.newProject.usuario || null
    };

    if (!this.selectedFolder) {
      this.loading = true;
      this.api.createProyecto(projectData).subscribe({
        next: (project) => {
          this.projects.push(project);
          this.groupProjects();
          this.resetCreationForm();
        },
        error: (err) => {
          console.error('Error creating project', err);
          this.error = this.apiErrorMessage(err, 'Error creando el proyecto.');
          this.loading = false;
          this.cdr.detectChanges();
        }
      });
      return;
    }

    if (!this.folderScan || this.validFolderModules.length === 0) {
      this.error = 'La carpeta no contiene ningun modulo valido para importar.';
      this.cdr.detectChanges();
      return;
    }

    this.loading = true;
    this.importing = true;
    this.importProgress = `Preparando ${this.validFolderModules.length} modulos validos...`;
    this.cdr.detectChanges();

    try {
      const formData = this.buildProjectCreationFormData(projectData, this.folderScan);
      this.importProgress = 'Creando proyecto y subiendo imagenes...';
      this.api.createProjectWithStructure(formData).subscribe({
        next: (result) => {
          const projectName = this.newProject.nombre;
          this.projects.push(result.project);
          this.groupProjects();
          this.creationReport = { projectName, stats: result.stats };
          this.importStats = result.stats;
          this.newProject = { nombre: '', usuario: null };
          this.showForm = false;
          this.loading = false;
          this.importing = false;
          this.importProgress = '';
          this.selectedFolder = null;
          this.folderName = '';
          this.folderScan = null;
          this.cdr.detectChanges();
        },
        error: (err) => {
          console.error('Error creating project with structure:', err);
          const stats = err?.error?.stats as ImportStats | undefined;
          if (stats) this.importStats = stats;
          this.error = this.apiErrorMessage(
            err,
            'No se pudo crear el proyecto. No se guardo ningun proyecto vacio.'
          );
          this.loading = false;
          this.importing = false;
          this.importProgress = '';
          this.cdr.detectChanges();
        }
      });
    } catch (err: any) {
      console.error('Error preparing project structure:', err);
      this.error = 'Error preparando la importacion: ' + (err.message || 'error desconocido');
      this.loading = false;
      this.importing = false;
      this.importProgress = '';
      this.cdr.detectChanges();
    }
  }

  private buildProjectCreationFormData(
    projectData: any,
    scan: ModuleImportScanResult
  ): FormData {
    const formData = new FormData();
    const modules = this.validFolderModules.map(candidate =>
      appendModuleImportCandidate(formData, candidate, 'PROY')
    );

    if (scan.planoFile) {
      formData.append('plano_file', scan.planoFile.file, scan.planoFile.entryName);
    }
    if (scan.planillaFile) {
      formData.append('planilla_file', scan.planillaFile.file, scan.planillaFile.entryName);
    }
    if (scan.technicalDbFile) {
      formData.append('technical_file', scan.technicalDbFile, scan.technicalDbFile.name);
    }

    formData.append('project', JSON.stringify(projectData));
    formData.append('modulos', JSON.stringify(modules));
    formData.append('strict_validation', 'true');
    formData.append('client_errors', JSON.stringify(scan.rootIssues));
    formData.append('client_module_errors', JSON.stringify(
      this.invalidFolderModules.map(candidate => ({
        module: candidate.moduleName,
        folder: candidate.folderName,
        errors: candidate.issues,
      }))
    ));
    return formData;
  }

  private apiErrorMessage(err: any, fallback: string): string {
    const payload = err?.error;
    if (typeof payload === 'string' && payload.trim()) return payload;
    if (payload?.message) return payload.message;
    if (payload?.detail) return payload.detail;
    if (payload && typeof payload === 'object') {
      const fieldErrors = Object.entries(payload)
        .filter(([key]) => !['stats', 'status'].includes(key))
        .flatMap(([key, value]) => {
          const messages = Array.isArray(value) ? value : [value];
          return messages.map(message => `${key}: ${message}`);
        });
      if (fieldErrors.length) return fieldErrors.join(' ');
    }
    return fallback;
  }

  private resetCreationForm(): void {
    this.newProject = { nombre: '', usuario: null };
    this.showForm = false;
    this.loading = false;
    this.importing = false;
    this.selectedFolder = null;
    this.folderName = '';
    this.folderScan = null;
    this.importProgress = '';
    this.cdr.detectChanges();
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


