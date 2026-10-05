import {
    appendModuleImportCandidate,
    moduleAlreadyExists,
    normalizeModuleImportIdentity,
    parseModuleImportFolder,
    scanModuleImportFolder,
} from './module-import.utils';

import { vi } from 'vitest';

type FakeEntry = [string, FakeHandle];

interface FakeHandle {
    kind: 'file' | 'directory';
    name?: string;
    entries?: () => AsyncGenerator<FakeEntry>;
    getFile?: () => Promise<File>;
}

function fakeFile(name: string, size = 10, error?: string): FakeHandle {
    return {
        kind: 'file',
        getFile: error
            ? async () => { throw new Error(error); }
            : async () => ({ name, size } as File),
    };
}

function fakeDirectory(name: string, entries: Record<string, FakeHandle>): FakeHandle {
    return {
        kind: 'directory',
        name,
        entries: async function* () {
            for (const entry of Object.entries(entries)) {
                yield entry as FakeEntry;
            }
        },
    };
}

describe('module import folder helpers', () => {
    it('extracts the module name and four-character color code', () => {
        expect(parseModuleImportFolder('MOD-A01_ymgc')).toEqual({
            moduleName: 'A01',
            colorCode: 'ymgc',
        });
    });

    it('keeps an unknown suffix as part of the module name', () => {
        expect(parseModuleImportFolder('MOD-A01_notas')).toEqual({
            moduleName: 'A01_notas',
            colorCode: 'xxxx',
        });
    });

    it('treats a restarted module as the same imported module', () => {
        expect(normalizeModuleImportIdentity('D06-R')).toBe('D06');
        expect(moduleAlreadyExists('MOD-D06_ymgc', ['D01', 'D06-R'])).toBe(true);
    });

    it('does not mark a genuinely new module as existing', () => {
        expect(moduleAlreadyExists('MOD-A08_ymgc', ['A01', 'A02'])).toBe(false);
    });

    it('validates a complete module and keeps its files for upload', async () => {
        const root = fakeDirectory('Proyecto', {
            'MOD-A01_ymgc': fakeDirectory('MOD-A01_ymgc', {
                INF: fakeDirectory('INF', {
                    '02.jpg': fakeFile('02.jpg'),
                    '01.jpg': fakeFile('01.jpg'),
                }),
                SD_S: fakeDirectory('SD_S', {
                    '01.png': fakeFile('01.png'),
                }),
                SUP: fakeDirectory('SUP', {
                    '01.jpg': fakeFile('01.jpg'),
                }),
            }),
        });

        const result = await scanModuleImportFolder(root);

        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0].moduleName).toBe('A01');
        expect(result.candidates[0].valid).toBe(true);
        expect(result.candidates[0].phases).toEqual(['INF', 'SD_S', 'SUP']);
        expect(
            result.candidates[0].phaseFolders.get('INF')?.images.map(image => image.fileName)
        ).toEqual(['01.jpg', '02.jpg']);
    });

    it('pairs every PLAYER image with its MONITOR image by name and uploads both', async () => {
        const root = fakeDirectory('Proyecto', {
            'MOD-A01_ymgc': fakeDirectory('MOD-A01_ymgc', {
                INF: fakeDirectory('INF', {
                    PLAYER: fakeDirectory('PLAYER', {
                        '02_foto.jpg': fakeFile('02_foto.jpg', 100),
                        '01.jpg': fakeFile('01.jpg', 100),
                    }),
                    MONITOR: fakeDirectory('MONITOR', {
                        '01.JPG': fakeFile('01.JPG', 300),
                        '02_foto.jpg': fakeFile('02_foto.jpg', 300),
                    }),
                }),
                // Formato antiguo en la misma carpeta: vale como solo player.
                SUP: fakeDirectory('SUP', {
                    '01.jpg': fakeFile('01.jpg', 100),
                }),
            }),
        });

        const result = await scanModuleImportFolder(root);
        const candidate = result.candidates[0];
        expect(candidate.issues).toEqual([]);
        expect(candidate.valid).toBe(true);
        expect(candidate.hasMonitor).toBe(true);
        expect(candidate.totalBytes).toBe(900);
        const inf = candidate.phaseFolders.get('INF')!.images;
        expect(inf.map(image => [image.fileName, image.monitorFileName])).toEqual([['01.jpg', '01.JPG'], ['02_foto.jpg', '02_foto.jpg']]);
        expect(candidate.phaseFolders.get('SUP')!.images[0].monitor).toBeUndefined();

        const formData = { append: vi.fn() } as unknown as FormData;
        const payload = appendModuleImportCandidate(formData, candidate);
        expect(payload.imagenes).toEqual([
            { filename: 'MOD_MOD-A01_ymgc_INF_01.jpg', fase: 'INFERIOR', source_phase: 'INF', orden: 1, monitor_filename: 'MOD_MOD-A01_ymgc_INF_MONITOR_01.JPG' },
            { filename: 'MOD_MOD-A01_ymgc_INF_02_foto.jpg', fase: 'INFERIOR', source_phase: 'INF', orden: 2, monitor_filename: 'MOD_MOD-A01_ymgc_INF_MONITOR_02_foto.jpg' },
            { filename: 'MOD_MOD-A01_ymgc_SUP_01.jpg', fase: 'SUPERIOR', source_phase: 'SUP', orden: 1 },
        ]);
        expect((formData.append as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5);
    });

    it('rejects a module whose MONITOR folder does not match PLAYER', async () => {
        const root = fakeDirectory('Proyecto', {
            'MOD-A02_ymgc': fakeDirectory('MOD-A02_ymgc', {
                INF: fakeDirectory('INF', {
                    PLAYER: fakeDirectory('PLAYER', {
                        '01.jpg': fakeFile('01.jpg'),
                        '02.jpg': fakeFile('02.jpg'),
                    }),
                    MONITOR: fakeDirectory('MONITOR', {
                        '01.jpg': fakeFile('01.jpg'),
                        '03.jpg': fakeFile('03.jpg'),
                    }),
                }),
                SUP: fakeDirectory('SUP', {
                    MONITOR: fakeDirectory('MONITOR', { '01.jpg': fakeFile('01.jpg') }),
                    '01.jpg': fakeFile('01.jpg'),
                }),
            }),
        });

        const candidate = (await scanModuleImportFolder(root)).candidates[0];
        expect(candidate.valid).toBe(false);
        expect(candidate.issues).toEqual([
            'INF/MONITOR: falta 02.jpg.',
            'INF/MONITOR: sobra 03.jpg (no esta en PLAYER).',
            'SUP/MONITOR necesita su carpeta SUP/PLAYER.',
        ]);
    });

    it('identifies the module and missing required phase', async () => {
        const root = fakeDirectory('Proyecto', {
            'MOD-G09': fakeDirectory('MOD-G09', {
                INF: fakeDirectory('INF', { '01.jpg': fakeFile('01.jpg') }),
            }),
        });

        const result = await scanModuleImportFolder(root);

        expect(result.candidates[0].moduleName).toBe('G09');
        expect(result.candidates[0].valid).toBe(false);
        expect(result.candidates[0].issues).toContain('Falta la carpeta obligatoria SUP.');
        expect(result.candidates[0].selected).toBe(false);
    });

    it('keeps valid modules when another image cannot be read', async () => {
        const root = fakeDirectory('Proyecto', {
            'MOD-A01': fakeDirectory('MOD-A01', {
                INF: fakeDirectory('INF', { '01.jpg': fakeFile('01.jpg') }),
                SUP: fakeDirectory('SUP', { '01.jpg': fakeFile('01.jpg') }),
            }),
            'MOD-A02': fakeDirectory('MOD-A02', {
                INF: fakeDirectory('INF', { '01.jpg': fakeFile('01.jpg', 10, 'archivo danado') }),
                SUP: fakeDirectory('SUP', { '01.jpg': fakeFile('01.jpg') }),
            }),
        });

        const result = await scanModuleImportFolder(root);

        expect(result.candidates.find(candidate => candidate.moduleName === 'A01')?.valid).toBe(true);
        const invalid = result.candidates.find(candidate => candidate.moduleName === 'A02');
        expect(invalid?.valid).toBe(false);
        expect(invalid?.issues.join(' ')).toContain('INF/01.jpg');
        expect(invalid?.issues.join(' ')).toContain('archivo danado');
    });

    it('rejects an optional SD folder when it is present but empty', async () => {
        const root = fakeDirectory('Proyecto', {
            'MOD-A01': fakeDirectory('MOD-A01', {
                INF: fakeDirectory('INF', { '01.jpg': fakeFile('01.jpg') }),
                SD_D: fakeDirectory('SD_D', {}),
                SUP: fakeDirectory('SUP', { '01.jpg': fakeFile('01.jpg') }),
            }),
        });

        const result = await scanModuleImportFolder(root);

        expect(result.candidates[0].valid).toBe(false);
        expect(result.candidates[0].issues).toContain(
            'La carpeta SD_D no contiene imagenes JPG o PNG.'
        );
    });

    it('recognizes the project plan PDF and documents ZIP by their names', async () => {
        const root = fakeDirectory('Proyecto', {
            'Plano general A3.pdf': fakeFile('Plano general A3.pdf'),
            'Documentación_obra_final.ZIP': fakeFile('Documentación_obra_final.ZIP'),
            'planilla_antigua.pdf': fakeFile('planilla_antigua.pdf'),
            'plano_antiguo.jpg': fakeFile('plano_antiguo.jpg'),
            'MOD-A01': fakeDirectory('MOD-A01', {
                INF: fakeDirectory('INF', { '01.jpg': fakeFile('01.jpg') }),
                SUP: fakeDirectory('SUP', { '01.jpg': fakeFile('01.jpg') }),
            }),
        });

        const result = await scanModuleImportFolder(root);

        expect(result.planoFile?.entryName).toBe('Plano general A3.pdf');
        expect(result.documentosFile?.entryName).toBe('Documentación_obra_final.ZIP');
        expect(result.rootIssues).toEqual([]);
    });
});
