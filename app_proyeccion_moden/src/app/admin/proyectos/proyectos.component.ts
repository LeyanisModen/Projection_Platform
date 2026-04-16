import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, User, Proyecto } from '../../services/api.service';
import { forkJoin } from 'rxjs';
import { Router } from '@angular/router';

interface ProjectGroup {
  username: string;
  userUrl: string;
  projects: Proyecto[];
  collapsed: boolean;
}

interface ImportStats {
  plantas: number;
  modulos: number;
  imagenes: number;
  errors: string[];
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
  }

  async selectFolder() {
    try {
      // Use File System Access API to pick a folder
      const dirHandle = await (window as any).showDirectoryPicker();
      this.selectedFolder = dirHandle;
      this.folderName = dirHandle.name;
      // Auto-set project name from folder name if empty
      if (!this.newProject.nombre) {
        this.newProject.nombre = dirHandle.name;
      }
      // Force UI update
      this.cdr.detectChanges();
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('Error selecting folder:', err);
        this.error = 'Error seleccionando carpeta';
        this.cdr.detectChanges();
      }
    }
  }

  async createProyecto() {
    this.loading = true;
    this.error = '';

    const projectData: any = {
      nombre: this.newProject.nombre,
      usuario: this.newProject.usuario || null
    };

    this.api.createProyecto(projectData).subscribe({
      next: async (project) => {
        this.projects.push(project);
        this.groupProjects();

        // If folder selected, import structure
        if (this.selectedFolder) {
          // Don't reset yet - importFolderStructure will handle cleanup
          this.loading = false;
          await this.importFolderStructure(project.id);
        } else {
          // No folder - just close the form
          this.newProject = { nombre: '', usuario: null };
          this.showForm = false;
          this.loading = false;
          this.selectedFolder = null;
          this.folderName = '';
          this.cdr.detectChanges();
        }
      },
      error: (err) => {
        console.error('Error creating project', err);
        this.error = 'Error creando proyecto';
        this.loading = false;
      }
    });
  }

  async importFolderStructure(proyectoId: number) {
    if (!this.selectedFolder) return;

    this.importing = true;
    this.importProgress = 'Leyendo estructura del proyecto...';

    try {
      const formData = new FormData();
      const validExtensions = ['.png', '.jpg', '.jpeg'];
      let technicalDbFile: File | null = null;

      // Single virtual "General" planta for backend compatibility
      const plantaUnicaData: any = {
        nombre: 'General',
        orden: 1,
        modulos: []
      };

      console.log('[IMPORT] Starting flat folder scan:', this.selectedFolder.name);

      // Iterate through modules (first level folders) OR files
      for await (const [childName, childHandle] of (this.selectedFolder as any).entries()) {
        console.log('[IMPORT] Found root entry:', childName, childHandle.kind);

        // CASE 1: Module (directory like MOD-01)
        if (childHandle.kind === 'directory') {
          const moduloName = childName;
          // Strip common prefixes so names match the technical DB (MODULO_A01 -> A01)
          const cleanName = moduloName.replace(/^(MODULO|MOD)[_-]/i, '');

          this.importProgress = `Procesando modulo: ${cleanName}...`;
          this.cdr.detectChanges();

          const moduloData: any = {
            nombre: cleanName,
            imagenes: []
          };

          // Check for INF and SUP inside Module
          for await (const [faseName, faseHandle] of childHandle.entries()) {
            if (faseHandle.kind !== 'directory') continue;

            const faseNormalizada = faseName.toUpperCase();
            if (faseNormalizada !== 'INF' && faseNormalizada !== 'SUP') continue;

            const fase = faseNormalizada === 'INF' ? 'INFERIOR' : 'SUPERIOR';
            let orden = 1;

            // Read images inside INF/SUP
            for await (const [fileName, fileHandle] of faseHandle.entries()) {
              if (fileHandle.kind !== 'file') continue;

              const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
              if (!validExtensions.includes(ext)) continue;

              this.importProgress = `Cargando imagen: ${fileName}...`;
              this.cdr.detectChanges();

              const file = await fileHandle.getFile();
              const uniqueFilename = `PROY_${moduloName}_${faseName}_${fileName}`;
              formData.append(uniqueFilename, file, uniqueFilename);

              moduloData.imagenes.push({
                fase: fase,
                orden: orden++,
                filename: uniqueFilename
              });
            }
          }

          if (moduloData.imagenes.length > 0) {
            plantaUnicaData.modulos.push(moduloData);
          }
        }
        // CASE 2: Project files (plano, bdd, etc)
        else if (childHandle.kind === 'file') {
          const fileName = childName;
          const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
          const uniqueFilename = `PROY_FILE_${fileName}`;

          if (['.jpg', '.jpeg', '.png'].includes(ext)) {
            console.log(`[IMPORT] Found PLANO for project: ${fileName}`);
            const file = await (childHandle as any).getFile();
            formData.append(uniqueFilename, file, uniqueFilename);
            plantaUnicaData.plano_filename = uniqueFilename;
          }
          else if (['.pdf', '.xls', '.xlsx'].includes(ext)) {
            console.log(`[IMPORT] Found DOC for project: ${fileName}`);
            const file = await (childHandle as any).getFile();
            formData.append(uniqueFilename, file, uniqueFilename);
            plantaUnicaData.corte_filename = uniqueFilename;
          }
          else if (['.db', '.sqlite', '.sqlite3'].includes(ext)) {
            console.log(`[IMPORT] Found technical DB for project: ${fileName}`);
            technicalDbFile = await (childHandle as any).getFile();
          }
        }
      }

      console.log(`[IMPORT] Detectados ${plantaUnicaData.modulos.length} módulos en la carpeta`);
      if (plantaUnicaData.modulos.length === 0) {
        const proceed = confirm(
          'No se detectó ningún módulo válido en la carpeta seleccionada.\n\n' +
          'Se esperaba una estructura tipo: MiProyecto/MODULO_A01/INF/*.jpg\n\n' +
          '¿Quieres crear el proyecto vacío igualmente?'
        );
        if (!proceed) {
          this.importing = false;
          this.importProgress = '';
          this.cdr.detectChanges();
          return;
        }
      }

      // Add the single planta to formData
      formData.append('plantas', JSON.stringify([plantaUnicaData]));

      this.importProgress = 'Subiendo archivos al servidor...';

      // Send to server
      this.api.importProjectStructure(proyectoId, formData).subscribe({
        next: (result) => {
          this.importStats = result.stats;
          console.log('Import complete:', result);

          const showSummary = (techResult?: any) => {
            const s = result.stats;
            const lines: string[] = [];
            lines.push(`Proyecto "${this.newProject.nombre}" creado correctamente.`);
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
            } else {
              lines.push(`• Base de datos técnica: no incluida en la carpeta`);
            }
            if (s.errors && s.errors.length) {
              lines.push('');
              lines.push(`⚠ ${s.errors.length} incidencias. Revisa la consola para más detalle.`);
            }
            alert(lines.join('\n'));
          };

          const finishImport = (techResult?: any) => {
            this.importing = false;
            this.importProgress = '';
            showSummary(techResult);
            if (result.stats.errors.length > 0) {
              this.error = `Importacion completada con ${result.stats.errors.length} errores`;
            } else {
              this.showForm = false;
              this.selectedFolder = null;
              this.folderName = '';
              this.importStats = null;
              this.newProject = { nombre: '', usuario: null };
            }
            this.cdr.detectChanges();
          };

          // If a .db/.sqlite was found, auto-import technical data
          if (technicalDbFile) {
            this.importProgress = 'Importando datos técnicos...';
            this.cdr.detectChanges();
            const techForm = new FormData();
            techForm.append('technical_file', technicalDbFile);
            this.api.importProjectTechnicalData(proyectoId, techForm).subscribe({
              next: (techResult) => finishImport(techResult),
              error: (err) => {
                console.warn('Auto technical import failed:', err);
                finishImport();
              }
            });
          } else {
            finishImport();
          }
        },
        error: (err) => {
          console.error('Error importing structure:', err);
          this.error = 'Error importando estructura';
          this.importing = false;
          this.importProgress = '';
          this.cdr.detectChanges();
        }
      });

    } catch (err: any) {
      console.error('Error reading folder:', err);
      this.error = 'Error leyendo carpeta: ' + err.message;
      this.importing = false;
      this.importProgress = '';
    }
  }

  manageProject(project: Proyecto) {
    this.router.navigate(['/admin-dashboard/proyectos', project.id]);
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


