"""Import an unmodified Synth release; pin archive and extracted file hashes."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    'index.html', 'synth-dmg/index.html', 'synth-dmg/synth.js',
    'synth-dmg/processor.js', 'synth-dmg/synth.css',
    'generated/gameboy_apu_wasm.js', 'generated/gameboy_apu_wasm.wasm',
    'sources/GameBoy.json', 'sources/GameBoy.md',
    'sources/dmg-synth-browser.json', 'sources/dmg-synth-browser-inputs.zip',
    'LICENSE', 'licenses/mame-gameboy/LICENSE',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_release(destination, hashes):
    missing = REQUIRED - hashes.keys()
    if missing:
        raise ValueError('Expected DMG Synth ZIP; missing: ' + ', '.join(sorted(missing)))

    def verify(record, name):
        if name not in hashes:
            raise ValueError(f'Missing recorded release file: {name}')
        data = (destination / name).read_bytes()
        if record.get('bytes') != len(data) or record.get('sha256') != hashes[name]:
            raise ValueError(f'Release source receipt mismatch: {name}')

    browser = json.loads((destination / 'sources/dmg-synth-browser.json').read_text())
    native = json.loads((destination / 'sources/GameBoy.json').read_text())
    if browser.get('productId') != 'tetorica-dmg-synth' or native.get('component') != 'gameboy_apu':
        raise ValueError('Expected DMG Synth / Game Boy source receipts')
    for bundle in browser.get('bundles', []):
        verify(bundle, bundle.get('path'))
    if {item.get('path') for item in browser.get('bundles', [])} != {
            'synth-dmg/synth.js', 'synth-dmg/processor.js', 'synth-dmg/synth.css'}:
        raise ValueError('Expected complete DMG Synth bundle receipts')
    source = browser.get('sourceArchive', {})
    if source.get('path') != 'sources/dmg-synth-browser-inputs.zip':
        raise ValueError('Expected browser source archive receipt')
    verify(source, source['path'])
    for name in ['gameboy_apu_wasm.js', 'gameboy_apu_wasm.wasm']:
        verify(native.get('generated', {}).get(name, {}), 'generated/' + name)
    for item in native.get('inputs', []):
        verify(item, item.get('path'))
    if not native.get('inputs'):
        raise ValueError('Expected Game Boy native source inputs')


def unpack(archive, destination):
    hashes = {}
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename
                    or ':' in entry.filename or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError(f'Unsafe ZIP entry: {entry.filename}')
        for entry in entries:
            if entry.is_dir():
                continue
            name = str(PurePosixPath(entry.filename))
            if name in hashes:
                raise ValueError(f'Duplicate ZIP entry: {name}')
            data = source.read(entry)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            hashes[name] = digest(data)
    validate_release(destination, hashes)
    return hashes


def check(root):
    lock = json.loads((root / 'release.lock.json').read_text())
    actual = {p.relative_to(root / 'dist').as_posix(): digest(p.read_bytes())
              for p in (root / 'dist').rglob('*') if p.is_file()}
    if actual != lock['files']:
        raise ValueError('dist differs from release.lock.json; import the pinned ZIP again')
    return lock


def import_release(root, archive):
    if not archive.is_file():
        raise FileNotFoundError(f'Synth release ZIP not found: {archive}')
    sha = digest(archive.read_bytes())
    previous = root / 'release.lock.json'
    old_lock = json.loads(previous.read_text()) if previous.exists() else {}
    version = old_lock.get('version') if old_lock.get('sha256') == sha else f'sha256-{sha[:12]}'
    with tempfile.TemporaryDirectory(prefix='.import-', dir=root) as temporary:
        staging = Path(temporary) / 'dist'
        staging.mkdir()
        hashes = unpack(archive, staging)
        lock = {'version': version, 'archive': archive.name, 'sha256': sha, 'files': hashes}
        destination = root / 'dist'
        if destination.exists():
            destination.rename(Path(temporary) / 'previous-dist')
        staging.rename(destination)
        previous.write_text(json.dumps(lock, indent=2, sort_keys=True) + '\n')
    print(f'Imported {version}: {len(hashes)} files, SHA256 {sha}')
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('zip', nargs='?', type=Path, help='Path to the Synth release ZIP')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not args.check and args.zip is None:
        parser.error('provide the ZIP path: npm run import:release -- ./xxx.zip')
    try:
        if args.check:
            lock = check(ROOT)
            print(f"Verified Synth {lock['version']}: {len(lock['files'])} files")
        else:
            import_release(ROOT, args.zip)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
