export interface ParsedModuleFolder {
    moduleName: string;
    colorCode: string;
}

export const MODULE_IMPORT_PHASE_ORDER = ['INF', 'SD_S', 'SD_D', 'SUP'] as const;
export type ModuleImportPhase = typeof MODULE_IMPORT_PHASE_ORDER[number];

export interface ModuleImportImageFile {
    fileName: string;
    file: File;
}

export interface ModuleImportPhaseFolder {
    name: string;
    images: ModuleImportImageFile[];
}

export interface ModuleImportCandidate {
    folderName: string;
    moduleName: string;
    colorCode: string;
    phaseFolders: Map<ModuleImportPhase, ModuleImportPhaseFolder>;
    phases: ModuleImportPhase[];
    alreadyImported: boolean;
    selected: boolean;
    issues: string[];
    valid: boolean;
}

export interface ProjectImportFile {
    entryName: string;
    file: File;
}

export interface ModuleImportScanResult {
    candidates: ModuleImportCandidate[];
    technicalDbFile: File | null;
    planoFile: ProjectImportFile | null;
    planillaFile: ProjectImportFile | null;
    rootIssues: string[];
}

export interface ModuleImportPayload {
    nombre: string;
    codigos_color: string;
    source_folder: string;
    imagenes: Array<{
        filename: string;
        fase: 'INFERIOR' | 'SUPERIOR';
        source_phase: ModuleImportPhase;
        orden: number;
    }>;
}

const VALID_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const TECHNICAL_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);
const PLANILLA_EXTENSIONS = new Set(['.pdf', '.xls', '.xlsx']);

export function parseModuleImportFolder(folderName: string): ParsedModuleFolder {
    const parts = folderName.split('_');
    let colorCode = 'xxxx';
    let moduleName = folderName;

    if (parts.length > 1) {
        const possibleColorCode = parts[parts.length - 1].toLowerCase();
        if (possibleColorCode.length === 4 && /^[ygcvmox]+$/.test(possibleColorCode)) {
            colorCode = possibleColorCode;
            moduleName = parts.slice(0, -1).join('_');
        }
    }

    moduleName = moduleName.replace(/^(MODULO|MOD)[_-]/i, '').trim();
    return { moduleName, colorCode };
}

export function normalizeModuleImportIdentity(moduleName: string): string {
    return parseModuleImportFolder(moduleName).moduleName
        .replace(/-R$/i, '')
        .trim()
        .toUpperCase();
}

export function moduleAlreadyExists(
    moduleName: string,
    existingModuleNames: Iterable<string>
): boolean {
    const identity = normalizeModuleImportIdentity(moduleName);
    return Array.from(existingModuleNames).some(
        existingName => normalizeModuleImportIdentity(existingName) === identity
    );
}

function fileExtension(fileName: string): string {
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

async function readProjectFile(
    entryName: string,
    handle: any,
    rootIssues: string[]
): Promise<ProjectImportFile | null> {
    try {
        const file = await handle.getFile() as File;
        if (typeof file.size === 'number' && file.size <= 0) {
            rootIssues.push(`El archivo ${entryName} esta vacio.`);
            return null;
        }
        return { entryName, file };
    } catch (error: any) {
        rootIssues.push(`No se pudo leer ${entryName}: ${error?.message || 'error desconocido'}.`);
        return null;
    }
}

/**
 * Reads module folders without loading image bytes into JavaScript memory.
 * File objects are retained so validation and upload use the exact same files.
 */
export async function scanModuleImportFolder(
    projectHandle: any,
    existingModuleNames: Iterable<string> = [],
    onProgress?: (folderName: string) => void
): Promise<ModuleImportScanResult> {
    const rootEntries: Array<[string, any]> = [];
    for await (const entry of projectHandle.entries()) {
        rootEntries.push(entry);
    }
    rootEntries.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

    const rootIssues: string[] = [];
    let technicalDbFile: File | null = null;
    let planoFile: ProjectImportFile | null = null;
    let planillaFile: ProjectImportFile | null = null;

    for (const [entryName, entryHandle] of rootEntries) {
        if (entryHandle.kind !== 'file') continue;
        const extension = fileExtension(entryName);
        const recognizedProjectFile = (
            TECHNICAL_EXTENSIONS.has(extension) ||
            VALID_IMAGE_EXTENSIONS.has(extension) ||
            PLANILLA_EXTENSIONS.has(extension)
        );
        if (!recognizedProjectFile) continue;
        const projectFile = await readProjectFile(entryName, entryHandle, rootIssues);
        if (!projectFile) continue;

        if (TECHNICAL_EXTENSIONS.has(extension)) {
            if (technicalDbFile) {
                rootIssues.push(
                    `Hay mas de una base tecnica. Se usara ${technicalDbFile.name} y se omitira ${entryName}.`
                );
            } else {
                technicalDbFile = projectFile.file;
            }
        } else if (VALID_IMAGE_EXTENSIONS.has(extension)) {
            if (planoFile) {
                rootIssues.push(
                    `Hay mas de un plano. Se usara ${planoFile.entryName} y se omitira ${entryName}.`
                );
            } else {
                planoFile = projectFile;
            }
        } else if (PLANILLA_EXTENSIONS.has(extension)) {
            if (planillaFile) {
                rootIssues.push(
                    `Hay mas de una planilla. Se usara ${planillaFile.entryName} y se omitira ${entryName}.`
                );
            } else {
                planillaFile = projectFile;
            }
        }
    }

    const phaseNames = new Set<string>(MODULE_IMPORT_PHASE_ORDER);
    const rootDirectories = rootEntries.filter(([, handle]) => handle.kind === 'directory');
    const selectedFolderIsModule = rootDirectories.some(
        ([name]) => phaseNames.has(name.toUpperCase())
    );
    const moduleDirectories: Array<[string, any]> = selectedFolderIsModule
        ? [[projectHandle.name, projectHandle]]
        : rootDirectories.filter(([name]) => !phaseNames.has(name.toUpperCase()));

    const existingNames = Array.from(existingModuleNames);
    const incomingIdentities = new Set<string>();
    const candidates: ModuleImportCandidate[] = [];

    for (const [folderName, moduleHandle] of moduleDirectories) {
        onProgress?.(folderName);
        const parsedFolder = parseModuleImportFolder(folderName);
        const issues: string[] = [];
        const phaseFolders = new Map<ModuleImportPhase, ModuleImportPhaseFolder>();

        if (!parsedFolder.moduleName) {
            issues.push('El nombre del modulo queda vacio despues de normalizar la carpeta.');
        }

        try {
            for await (const [phaseName, phaseHandle] of moduleHandle.entries()) {
                if (phaseHandle.kind !== 'directory') continue;
                const normalizedPhase = phaseName.toUpperCase() as ModuleImportPhase;
                if (!phaseNames.has(normalizedPhase)) continue;
                if (phaseFolders.has(normalizedPhase)) {
                    issues.push(`La fase ${normalizedPhase} aparece mas de una vez.`);
                    continue;
                }

                const imageEntries: Array<[string, any]> = [];
                for await (const [fileName, fileHandle] of phaseHandle.entries()) {
                    if (fileHandle.kind !== 'file') continue;
                    if (!VALID_IMAGE_EXTENSIONS.has(fileExtension(fileName))) continue;
                    imageEntries.push([fileName, fileHandle]);
                }
                imageEntries.sort((a, b) =>
                    a[0].localeCompare(b[0], undefined, { numeric: true })
                );

                const images: ModuleImportImageFile[] = [];
                if (imageEntries.length === 0) {
                    issues.push(`La carpeta ${normalizedPhase} no contiene imagenes JPG o PNG.`);
                }
                for (const [fileName, fileHandle] of imageEntries) {
                    try {
                        const file = await fileHandle.getFile() as File;
                        if (typeof file.size === 'number' && file.size <= 0) {
                            issues.push(`${normalizedPhase}/${fileName} esta vacia.`);
                            continue;
                        }
                        images.push({ fileName, file });
                    } catch (error: any) {
                        issues.push(
                            `No se pudo leer ${normalizedPhase}/${fileName}: ` +
                            `${error?.message || 'error desconocido'}.`
                        );
                    }
                }
                phaseFolders.set(normalizedPhase, {
                    name: phaseName,
                    images,
                });
            }
        } catch (error: any) {
            issues.push(`No se pudo leer la estructura: ${error?.message || 'error desconocido'}.`);
        }

        for (const requiredPhase of ['INF', 'SUP'] as const) {
            if (!phaseFolders.has(requiredPhase)) {
                issues.push(`Falta la carpeta obligatoria ${requiredPhase}.`);
            }
        }

        const identity = normalizeModuleImportIdentity(parsedFolder.moduleName);
        if (identity && incomingIdentities.has(identity)) {
            issues.push('Hay otra carpeta en esta seleccion para el mismo modulo.');
        } else if (identity) {
            incomingIdentities.add(identity);
        }

        const alreadyImported = moduleAlreadyExists(parsedFolder.moduleName, existingNames);
        const valid = issues.length === 0;
        candidates.push({
            folderName,
            moduleName: parsedFolder.moduleName || folderName,
            colorCode: parsedFolder.colorCode,
            phaseFolders,
            phases: MODULE_IMPORT_PHASE_ORDER.filter(phase => phaseFolders.has(phase)),
            alreadyImported,
            selected: valid && !alreadyImported,
            issues,
            valid,
        });
    }

    candidates.sort((a, b) =>
        a.moduleName.localeCompare(b.moduleName, undefined, { numeric: true })
    );
    return {
        candidates,
        technicalDbFile,
        planoFile,
        planillaFile,
        rootIssues,
    };
}

export function appendModuleImportCandidate(
    formData: FormData,
    candidate: ModuleImportCandidate,
    keyPrefix = 'MOD'
): ModuleImportPayload {
    const payload: ModuleImportPayload = {
        nombre: candidate.moduleName,
        codigos_color: candidate.colorCode,
        source_folder: candidate.folderName,
        imagenes: [],
    };
    const nextImageOrder: Record<'INFERIOR' | 'SUPERIOR', number> = {
        INFERIOR: 1,
        SUPERIOR: 1,
    };

    for (const phaseName of MODULE_IMPORT_PHASE_ORDER) {
        const phaseFolder = candidate.phaseFolders.get(phaseName);
        if (!phaseFolder) continue;
        const fase: 'INFERIOR' | 'SUPERIOR' =
            phaseName === 'INF' ? 'INFERIOR' : 'SUPERIOR';

        for (const image of phaseFolder.images) {
            const formFileKey =
                `${keyPrefix}_${candidate.folderName}_${phaseFolder.name}_${image.fileName}`;
            formData.append(formFileKey, image.file, formFileKey);
            payload.imagenes.push({
                filename: formFileKey,
                fase,
                source_phase: phaseName,
                orden: nextImageOrder[fase]++,
            });
        }
    }
    return payload;
}
