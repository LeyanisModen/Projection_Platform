import os
import re

directories = [
    r'app_proyeccion_moden\src\app\admin\proyectos',
]

replacements = {
    r'm[\ufffd]dulos': 'módulos',
    r't[\ufffd]cnicos': 'técnicos',
    r't[\ufffd]cnica': 'técnica',
    r'im[\ufffd]genes': 'imágenes',
    r'importaci[\ufffd]n': 'importación',
    r'm[\ufffd]s': 'más',
    r'a[\ufffd]n': 'aún',
    r'bot[\ufffd]n': 'botón',
    r'M[\ufffd]dulos': 'Módulos',
    r'T[\ufffd]cnicos': 'Técnicos',
    r'Importaci[\ufffd]n': 'Importación',
}

def fix_file(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        try:
            with open(file_path, 'r', encoding='latin-1') as f:
                content = f.read()
        except Exception:
            return
    original = content
    for pattern, replacement in replacements.items():
        content = re.sub(pattern, replacement, content)
    if content != original:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'Fixed {file_path}')

for root, _, files in os.walk(directories[0]):
    for file in files:
        if file.endswith('.ts') or file.endswith('.html') or file.endswith('.css'):
            fix_file(os.path.join(root, file))

print("Done fixing encoding issues.")
