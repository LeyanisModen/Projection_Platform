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
  newProject: any = { nombre: '', usuario: null, numPlantas: 0 };

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

    if (this.newProject.numPlantas > 0) {
      projectData.num_plantas = this.newProject.numPlantas;
    }

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
          this.newProject = { nombre: '', usuario: null, numPlantas: 0 };
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
    this.importProgress = 'Leyendo estructura de carpetas...';

    try {
      const formData = new FormData();
      const plantas: any[] = [];
      const validExtensions = ['.png', '.jpg', '.jpeg'];

      let plantaOrden = 1;

      console.log('[IMPORT] Starting folder scan:', this.selectedFolder.name);

      // Iterate through plantas (first level folders)
      for await (const [plantaName, plantaHandle] of (this.selectedFolder as any).entries()) {
        console.log('[IMPORT] Found entry:', plantaName, plantaHandle.kind);
        if (plantaHandle.kind !== 'directory') continue;

        this.importProgress = `Procesando planta: ${plantaName}...`;
        this.cdr.detectChanges();

        const plantaData: any = {
          nombre: plantaName,
          orden: plantaOrden++,
          modulos: []
        };

        // Iterate through children of Planta folder (Modules OR Files)
        for await (const [childName, childHandle] of plantaHandle.entries()) {
          console.log('[IMPORT] Found entry in planta:', plantaName + '/' + childName, childHandle.kind);

          // CASE 1: It's a Modulo (Directory)
          if (childHandle.kind === 'directory') {
            const moduloName = childName;
            const moduloHandle = childHandle;

            this.importProgress = `Procesando módulo: ${plantaName}/${moduloName}...`;
            this.cdr.detectChanges();

            const moduloData: any = {
              nombre: moduloName,
              imagenes: []
            };

            // Check for INF and SUP subfolders
            for await (const [faseName, faseHandle] of moduloHandle.entries()) {
              // console.log('[IMPORT] Found fase entry:', moduloName + '/' + faseName, faseHandle.kind);
              if (faseHandle.kind !== 'directory') continue;

              const faseNormalizada = faseName.toUpperCase();
              if (faseNormalizada !== 'INF' && faseNormalizada !== 'SUP') continue;

              const fase = faseNormalizada === 'INF' ? 'INFERIOR' : 'SUPERIOR';
              let orden = 1;

              // Read images in fase folder
              for await (const [fileName, fileHandle] of faseHandle.entries()) {
                // console.log('[IMPORT] Found file:', fileName, fileHandle.kind);
                if (fileHandle.kind !== 'file') continue;

                const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));

                // Be more flexible with extensions
                if (!validExtensions.includes(ext) && ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
                  continue;
                }

                this.importProgress = `Cargando imagen: ${fileName}...`;
                this.cdr.detectChanges();

                // Get the file and add to FormData
                const file = await fileHandle.getFile();
                const uniqueFilename = `${plantaName}_${moduloName}_${faseName}_${fileName}`;
                formData.append(uniqueFilename, file, uniqueFilename);

                moduloData.imagenes.push({
                  fase: fase,
                  orden: orden++,
                  filename: uniqueFilename
                });
              }
            }

            if (moduloData.imagenes.length > 0) {
              plantaData.modulos.push(moduloData);
            }
          }
          // CASE 2: It's a Plant File (Plano or Corte)
          else if (childHandle.kind === 'file') {
            const fileName = childName;
            const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
            const uniqueFilename = `${plantaName}_FILE_${fileName}`;

            // Check if it's an IMAGE (Plano)
            if (['.jpg', '.jpeg', '.png'].includes(ext)) {
              console.log(`[IMPORT] Found PLANO for ${plantaName}: ${fileName}`);
              const file = await (childHandle as any).getFile();
              formData.append(uniqueFilename, file, uniqueFilename);
              plantaData.plano_filename = uniqueFilename;
            }
            // Check if it's a DOCUMENT (Corte/Planilla)
            else if (['.pdf', '.xls', '.xlsx', '.csv'].includes(ext)) {
              console.log(`[IMPORT] Found CORTE for ${plantaName}: ${fileName}`);
              const file = await (childHandle as any).getFile();
              formData.append(uniqueFilename, file, uniqueFilename);
              plantaData.corte_filename = uniqueFilename;
            }
          }
        }

        if (plantaData.modulos.length > 0) {
          plantas.push(plantaData);
        }
      }

      // Add plantas JSON to formData
      formData.append('plantas', JSON.stringify(plantas));

      this.importProgress = 'Subiendo archivos al servidor...';

      // Send to server
      this.api.importProjectStructure(proyectoId, formData).subscribe({
        next: (result) => {
          this.importStats = result.stats;
          this.importing = false;
          this.importProgress = '';
          console.log('Import complete:', result);

          if (result.stats.errors.length > 0) {
            this.error = `Importación completada con ${result.stats.errors.length} errores`;
          } else {
            // Success - close form and reset
            this.showForm = false;
            this.selectedFolder = null;
            this.folderName = '';
            this.importStats = null;
          }
          this.cdr.detectChanges();
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

  createPlantas(proyectoId: number, count: number) {
    for (let i = 1; i <= count; i++) {
      this.api.createPlanta({ nombre: `Planta ${i}`, proyecto: proyectoId, orden: i }).subscribe({
        next: () => console.log(`Planta ${i} creada`),
        error: (err) => console.error(`Error creando Planta ${i}`, err)
      });
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

