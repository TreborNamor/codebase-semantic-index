"""Package the complete source and public evidence, excluding local caches/secrets."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
output = root / 'dist/codeconverge-0.2.0-source.zip'
directories = ['src/codeconverge', 'tests', 'scripts', 'docs', 'integration', 'benchmarks',
    'extension/src', 'artifacts/benchmarks']
files = {root / name for name in ['README.md', 'LICENSE', '.gitignore', 'pyproject.toml',
    'requirements-runtime.txt', 'requirements.lock', 'requirements-offline.lock',
    'extension/package.json', 'extension/package-lock.json', 'extension/tsconfig.json',
    'extension/README.md', 'extension/.vscodeignore', 'extension/LICENSE',
    'artifacts/integration/release-audit.json']}
for directory in directories:
    files.update((root / directory).rglob('*'))
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for path in sorted(files):
        relative = path.relative_to(root)
        if path.is_file() and path.name != 'probe-deferral-setting.cjs' and not path.is_symlink() and not {'__pycache__', '.pytest_cache', 'private'} & set(relative.parts):
            archive.write(path, relative.as_posix())
print(json.dumps({'file':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
