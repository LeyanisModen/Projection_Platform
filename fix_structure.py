import re
import sys

def modify_file(filepath, operations):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    for search, replace in operations:
        content = re.sub(search, replace, content, flags=re.MULTILINE|re.DOTALL)
        
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Updated {filepath}")

# 1. Update proyectos.component.html
proyectos_html_ops = [
    (r'\s*<div class="form-group">\s*<label for="numPlantas">.*?</label>\s*<input type="number".*?[(]ngModel[)]="newProject.numPlantas".*?</div>', ''),
    (r'<li>\{\{ importStats\.plantas \}\} plantas creadas</li>\s*', ''),
]
modify_file('app_proyeccion_moden/src/app/admin/proyectos/proyectos.component.html', proyectos_html_ops)

# 2. Update proyectos.component.ts - Rewrite importFolderStructure
proyectos_ts_ops = [
    (r'newProject: any = \{ nombre: \'\', usuario: null, numPlantas: 0 \};', 'newProject: any = { nombre: \'\', usuario: null };'),
    (r'if \(this\.newProject\.numPlantas > 0\) \{.*?\}', ''),
    (r'this\.newProject = \{ nombre: \'\', usuario: null, numPlantas: 0 \};', 'this.newProject = { nombre: \'\', usuario: null };'),
    (r'createPlantas\(proyectoId: number, count: number\) \{[\s\S]*?\}', ''),
]

with open('app_proyeccion_moden/src/app/admin/proyectos/proyectos.component.ts', 'r', encoding='utf-8') as f:
    ts_content = f.read()

# Replace the whole importFolderStructure method
new_import = """  async importFolderStructure(proyectoId: number) {
    if (!this.selectedFolder) return;

    this.importing = true;
    this.importProgress = 'Leyendo estructura del proyecto...';

    try {
      const formData = new FormData();
      const validExtensions = ['.png', '.jpg', '.jpeg'];

      // Creamos una única "Planta" virtual para agrupar todo el proyecto 
      // esto mantendrá la compatibilidad con el backend que espera esta estructura.
      const plantaUnicaData: any = {
        nombre: 'General',
        orden: 1,
        módulos: []
      };

      console.log('[IMPORT] Starting flat folder scan:', this.selectedFolder.name);

      // Iterate through modules (first level folders) OR files 
      for await (const [childName, childHandle] of (this.selectedFolder as any).entries()) {
        console.log('[IMPORT] Found root entry:', childName, childHandle.kind);

        // CASE 1: Módulo (e.g. MOD-01)
        if (childHandle.kind === 'directory') {
          const moduloName = childName;
          
          this.importProgress = `Procesando módulo: ${moduloName}...`;
          this.cdr.detectChanges();

          const moduloData: any = {
            nombre: moduloName,
            imágenes: []
          };

          // Check for INF and SUP inside Modulo
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
              if (!validExtensions.includes(ext) && ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
                continue;
              }

              this.importProgress = `Cargando imagen: ${fileName}...`;
              this.cdr.detectChanges();

              const file = await fileHandle.getFile();
              // Create unique internal filename
              const uniqueFilename = `PROY_${moduloName}_${faseName}_${fileName}`;
              formData.append(uniqueFilename, file, uniqueFilename);

              moduloData.imágenes.push({
                fase: fase,
                orden: orden++,
                filename: uniqueFilename
              });
            }
          }

          if (moduloData.imágenes.length > 0) {
            plantaUnicaData.módulos.push(moduloData);
          }
        }
        // CASE 2: Archivos del proyecto (PLANO, BDD, etc)
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
          else if (['.pdf', '.xls', '.xlsx', '.csv'].includes(ext)) {
            console.log(`[IMPORT] Found DOC for project: ${fileName}`);
            const file = await (childHandle as any).getFile();
            formData.append(uniqueFilename, file, uniqueFilename);
            plantaUnicaData.corte_filename = uniqueFilename;
          }
        }
      }

      // Add the single planta to formData
      formData.append('plantas', JSON.stringify([plantaUnicaData]));

      this.importProgress = 'Subiendo archivos al servidor...';
"""

import re
# Find the method start and the line before createPlantas
start_match = re.search(r'\s*async importFolderStructure.*?\{\n', ts_content)
end_match = re.search(r'\s*// Send to server\s*this\.api\.importProjectStructure', ts_content)

if start_match and end_match:
    ts_content = ts_content[:start_match.start()] + "\n" + new_import + ts_content[end_match.start():]

for search, replace in proyectos_ts_ops:
    ts_content = re.sub(search, replace, ts_content, flags=re.MULTILINE|re.DOTALL)

with open('app_proyeccion_moden/src/app/admin/proyectos/proyectos.component.ts', 'w', encoding='utf-8') as f:
    f.write(ts_content)
print("Updated proyectos TS")


# 3. Update detalle.component.ts - importPlantaFromFolder -> importModulosFromFolder
with open('app_proyeccion_moden/src/app/admin/proyectos/detalle/detalle.component.ts', 'r', encoding='utf-8') as f:
    det_ts_content = f.read()

new_det_import = """  async importPlantaFromFolder() {
        if (!this.proyectoId) return;

        try {
            // Use File System Access API
            const projectHandle = await (window as any).showDirectoryPicker();
            if (!projectHandle) return;

            this.importing = true;
            this.importProgress = `Analizando carpeta: ${projectHandle.name}...`;
            this.cdr.detectChanges();

            const formData = new FormData();
            const validExtensions = ['.png', '.jpg', '.jpeg'];

            // Usamos la planta virtual creada en loadData o creamos una "General"
            const plantaUnicaData: any = {
                nombre: 'General',
                orden: 1,
                modulos: [] // NOTA: Backend usa modulos sin acento
            };

            // Iterate modules (children of projectHandle)
            for await (const [childName, childHandle] of (projectHandle as any).entries()) {
                if (childHandle.kind === 'directory') {
                    const moduloName = childName;
                    const moduloHandle = childHandle;

                    this.importProgress = `Procesando módulo: ${moduloName}...`;
                    this.cdr.detectChanges();

                    // Parse color code from folder name
                    const parts = moduloName.split('_');
                    let colorCode = 'xxxx';
                    let cleanName = moduloName;
                    if (parts.length > 1) {
                        const lastPart = parts[parts.length - 1].toLowerCase();
                        if (lastPart.length === 4 && /^[ygcvmox]+$/.test(lastPart)) {
                            colorCode = lastPart;
                            cleanName = parts.slice(0, -1).join('_');
                        }
                    }

                    const moduloData: any = {
                        nombre: cleanName,
                        codigos_color: colorCode,
                        imagenes: [] // backend usa imagenes sin acento
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
                            
                            // Asegurar un nombre único en el form data
                            const formFileKey = `MOD_${moduloName}_${faseName}_${fileName}`;
                            formData.append(formFileKey, file);

                            moduloData.imagenes.push({
                                filename: formFileKey,
                                fase: fase,
                                orden: ordenImg++
                            });
                        }
                    }
                    plantaUnicaData.modulos.push(moduloData);
                }
            }

            this.importProgress = 'Subiendo datos...';
            this.cdr.detectChanges();

            // Add structure to FormData
            formData.append('plantas', JSON.stringify([plantaUnicaData]));

            // Upload
            this.api.importProjectStructure(this.proyectoId, formData).subscribe({
                next: (res) => {
                    this.importing = false;
                    this.importProgress = '';
                    alert(`Nuevos módulos importados correctamente: ${res.stats.modulos} creados.`);
                    this.loadData();
                },
                error: (err) => {
                    console.error('Error uploading modules', err);
                    this.importing = false;
                    this.importProgress = '';
                    alert('Error importando los módulos');
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
    }"""

start_match = re.search(r'\s*async importPlantaFromFolder\(\).*?\{\n', det_ts_content)
end_match = re.search(r'\s*triggerTechnicalDataUpload\s*\(', det_ts_content)

if start_match and end_match:
    det_ts_content = det_ts_content[:start_match.start()] + "\n" + new_det_import + "\n\n" + det_ts_content[end_match.start():]

with open('app_proyeccion_moden/src/app/admin/proyectos/detalle/detalle.component.ts', 'w', encoding='utf-8') as f:
    f.write(det_ts_content)
print("Updated detalle TS")
