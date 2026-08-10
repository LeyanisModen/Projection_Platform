import {
    moduleAlreadyExists,
    normalizeModuleImportIdentity,
    parseModuleImportFolder,
} from './module-import.utils';

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
});
