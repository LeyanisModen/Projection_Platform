import {
    moduleAlreadyExists,
    normalizeModuleImportIdentity,
    parseModuleImportFolder,
    scanModuleImportFolder,
} from './module-import.utils';

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

    it('recognizes project plano and planilla PDFs by their names', async () => {
        const root = fakeDirectory('Proyecto', {
            'Plano general A3.pdf': fakeFile('Plano general A3.pdf'),
            'planilla_corte_final.PDF': fakeFile('planilla_corte_final.PDF'),
            'plano_antiguo.jpg': fakeFile('plano_antiguo.jpg'),
            'MOD-A01': fakeDirectory('MOD-A01', {
                INF: fakeDirectory('INF', { '01.jpg': fakeFile('01.jpg') }),
                SUP: fakeDirectory('SUP', { '01.jpg': fakeFile('01.jpg') }),
            }),
        });

        const result = await scanModuleImportFolder(root);

        expect(result.planoFile?.entryName).toBe('Plano general A3.pdf');
        expect(result.planillaFile?.entryName).toBe('planilla_corte_final.PDF');
        expect(result.rootIssues).toEqual([]);
    });
});
