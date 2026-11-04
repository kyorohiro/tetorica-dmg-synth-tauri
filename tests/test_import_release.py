import importlib.util
from pathlib import Path
import tempfile
import json
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('importer', Path(__file__).resolve().parents[1] / 'scripts/import_release.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def release_files(text=b'<html>test</html>'):
    files = {
        'index.html': text, 'synth-dmg/index.html': text,
        'synth-dmg/synth.js': b'// test', 'synth-dmg/processor.js': b'// processor',
        'synth-dmg/synth.css': b'body {}', 'generated/gameboy_apu_wasm.js': b'// factory',
        'generated/gameboy_apu_wasm.wasm': b'\x00asm\x01\x00\x00\x00',
        'sources/GameBoy.md': b'Native sources', 'sources/native/gameboy.cpp': b'// native',
        'sources/dmg-synth-browser-inputs.zip': bytes(range(256)),
        'LICENSE': b'BSD-3-Clause', 'licenses/mame-gameboy/LICENSE': b'BSD-3-Clause',
    }
    def record(name):
        return {'path': name, 'bytes': len(files[name]), 'sha256': importer.digest(files[name])}
    files['sources/dmg-synth-browser.json'] = json.dumps({
        'productId': 'tetorica-dmg-synth',
        'bundles': [record(name) for name in ['synth-dmg/synth.js', 'synth-dmg/processor.js', 'synth-dmg/synth.css']],
        'sourceArchive': record('sources/dmg-synth-browser-inputs.zip'),
    }).encode()
    files['sources/GameBoy.json'] = json.dumps({
        'component': 'gameboy_apu', 'inputs': [record('sources/native/gameboy.cpp')],
        'generated': {name: record('generated/' + name) for name in ['gameboy_apu_wasm.js', 'gameboy_apu_wasm.wasm']},
    }).encode()
    return files


def write_archive(path, files):
    with zipfile.ZipFile(path, 'w') as output:
        for name, data in files.items():
            output.writestr(name, data)


class ImportTests(unittest.TestCase):
    def test_new_zip_updates_without_version_and_preserves_label_for_same_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'any-name.zip'
            write_archive(archive, release_files(b'first'))
            first = importer.import_release(root, archive)
            first['version'] = 'named-release'
            (root / 'release.lock.json').write_text(json.dumps(first))
            self.assertEqual(importer.import_release(root, archive)['version'], 'named-release')
            write_archive(archive, release_files(b'second'))
            changed = importer.import_release(root, archive)
            self.assertNotEqual(changed['sha256'], first['sha256'])
            self.assertEqual(changed['version'], 'sha256-' + changed['sha256'][:12])
            self.assertEqual((root / 'dist/index.html').read_text(), 'second')
            self.assertEqual(importer.check(root), changed)

    def test_invalid_replacement_preserves_dist_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'release.zip'
            write_archive(archive, release_files(b'valid'))
            first = importer.import_release(root, archive)
            write_archive(archive, {'index.html': b'wrong app'})
            with self.assertRaises(ValueError):
                importer.import_release(root, archive)
            self.assertEqual(importer.check(root), first)
            self.assertEqual((root / 'dist/index.html').read_text(), 'valid')

    def unpack(self, files):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'release.zip'
            write_archive(archive, files)
            return importer.unpack(archive, root / 'out')

    def test_preserves_all_original_bytes(self):
        files = release_files()
        self.assertEqual(self.unpack(files), {name: importer.digest(data) for name, data in files.items()})

    def test_check_detects_modified_or_extra_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'dist').mkdir()
            target = root / 'dist/index.html'
            target.write_bytes(b'original')
            (root / 'release.lock.json').write_text(json.dumps({'version': 'test', 'files': {'index.html': importer.digest(b'original')}}))
            self.assertEqual(importer.check(root)['version'], 'test')
            target.write_bytes(b'changed')
            with self.assertRaises(ValueError): importer.check(root)
            target.write_bytes(b'original')
            (root / 'dist/extra.js').write_bytes(b'extra')
            with self.assertRaises(ValueError): importer.check(root)

    def test_rejects_traversal(self):
        for name in ['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'C:/escape']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.unpack({name: b'bad'})

    def test_rejects_wrong_release_or_missing_wasm_and_sources(self):
        with self.assertRaises(ValueError): self.unpack({'index.html': b'wrong app'})
        for name in ['generated/gameboy_apu_wasm.js', 'generated/gameboy_apu_wasm.wasm',
                     'sources/GameBoy.json', 'sources/dmg-synth-browser-inputs.zip']:
            files = release_files(); del files[name]
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)

    def test_rejects_mismatched_receipts_and_changed_native_or_browser_bytes(self):
        for name in ['generated/gameboy_apu_wasm.wasm', 'synth-dmg/synth.js',
                     'sources/native/gameboy.cpp', 'sources/dmg-synth-browser-inputs.zip']:
            files = release_files(); files[name] = b'changed'
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/dmg-synth-browser.json'])
        receipt['productId'] = 'tetorica-spu-synth'
        files['sources/dmg-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaises(ValueError): self.unpack(files)

    def test_rejects_duplicate_names_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); archive = root / 'release.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('index.html', b'a')
                with self.assertWarns(UserWarning): output.writestr('index.html', b'b')
            with self.assertRaisesRegex(ValueError, 'Duplicate'): importer.unpack(archive, root / 'out')
            with zipfile.ZipFile(archive, 'w') as output:
                info = zipfile.ZipInfo('link'); info.create_system = 3
                info.external_attr = 0o120777 << 16
                output.writestr(info, '../../escape')
            with self.assertRaisesRegex(ValueError, 'Unsafe'): importer.unpack(archive, root / 'out2')


if __name__ == '__main__':
    unittest.main()
