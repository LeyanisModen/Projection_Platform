export interface ParsedModuleFolder {
    moduleName: string;
    colorCode: string;
}

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
