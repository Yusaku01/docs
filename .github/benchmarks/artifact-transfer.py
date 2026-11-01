"""Fork-only artifact round-trip benchmark; never deploys anything."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path('.artifact-benchmark')


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(base):
    files = []
    for entry in ('dist', 'worker.js', 'wrangler.jsonc'):
        path = base / entry
        candidates = path.rglob('*') if path.is_dir() else [path]
        for file in candidates:
            relative = file.relative_to(base)
            # Match upload-artifact's default hidden-file exclusion.
            if any(part.startswith('.') for part in relative.parts):
                continue
            if file.is_symlink():
                raise RuntimeError(f'Unexpected symlink: {relative}')
            if file.is_file():
                files.append(relative.as_posix())
    return sorted(files)


def prepare_manifest():
    ROOT.mkdir(exist_ok=True)
    files = inventory(Path('.'))
    assert len(files) > 1000, 'Expected a full docs build'
    manifest = {}
    groups = {}
    for name in files:
        file = Path(name)
        size = file.stat().st_size
        manifest[name] = {'bytes': size, 'sha256': digest(file)}
        kind = 'OG images' if name.startswith('dist/open-graph/') else file.suffix or '(no extension)'
        row = groups.setdefault(kind, {'files': 0, 'bytes': 0})
        row['files'] += 1
        row['bytes'] += size
    (ROOT / 'manifest.json').write_text(json.dumps(manifest))
    (ROOT / 'files.txt').write_bytes(b''.join(os.fsencode(name) + b'\0' for name in files))
    (ROOT / 'inventory.json').write_text(json.dumps({'files': len(files), 'bytes': sum(x['bytes'] for x in manifest.values()), 'groups': groups}, indent=2))
    print((ROOT / 'inventory.json').read_text())


def prepare(trial, codec):
    assert codec in ('zip', 'gzip', 'zstd')
    result = {'trial': trial, 'codec': codec, 'pack_seconds': 0, 'unpack_seconds': 0}
    if codec != 'zip':
        extension, compressor = ('gz', 'gzip -1') if codec == 'gzip' else ('zst', 'zstd -3 -T1')
        archive = ROOT / f'{trial}.tar.{extension}'
        start = time.perf_counter()
        subprocess.run(['tar', '--null', '-T', str(ROOT / 'files.txt'), '-I', compressor, '-cf', str(archive)], check=True)
        result['pack_seconds'] = time.perf_counter() - start
        result['packed_bytes'] = archive.stat().st_size
        result['archive'] = str(archive)
    (ROOT / f'{trial}.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


def verify(trial):
    result = json.loads((ROOT / f'{trial}.json').read_text())
    downloaded = ROOT / 'downloads' / trial
    if result['codec'] == 'zip':
        restored = downloaded
    else:
        restored = ROOT / 'restored' / trial
        restored.mkdir(parents=True)
        archive = downloaded / Path(result['archive']).name
        assert archive.is_file(), f'Raw archive missing: {archive}'
        start = time.perf_counter()
        subprocess.run(['tar', '-xf', str(archive), '-C', str(restored)], check=True)
        result['unpack_seconds'] = time.perf_counter() - start
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    # Include every restored file, even unexpected hidden files or extra roots.
    restored_files = sorted(p.relative_to(restored).as_posix() for p in restored.rglob('*') if p.is_file())
    assert restored_files == sorted(manifest), 'Restored file set differs'
    for name, expected in manifest.items():
        file = restored / name
        assert not file.is_symlink(), f'Unexpected restored symlink: {name}'
        assert file.stat().st_size == expected['bytes'], f'Size mismatch: {name}'
        assert digest(file) == expected['sha256'], f'Hash mismatch: {name}'
    result['verified_files'] = len(manifest)
    result['artifact_id'] = os.environ['ARTIFACT_ID']
    (ROOT / f'{trial}.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    shutil.rmtree(downloaded)
    if restored != downloaded:
        shutil.rmtree(restored)
        Path(result['archive']).unlink()


def summarize():
    trials = [json.loads(p.read_text()) for p in sorted(ROOT.glob('r*.json'))]
    report = {'commit': os.environ.get('GITHUB_SHA'), 'inventory': json.loads((ROOT / 'inventory.json').read_text()), 'trials': trials,
              'timing_note': 'Add pack_seconds, GitHub upload step duration, GitHub download step duration, and unpack_seconds. ZIP creation/extraction are inside the Action step durations. Hash verification and setup are excluded.'}
    (ROOT / 'results.json').write_text(json.dumps(report, indent=2))
    assert len(trials) == 9 and all(t.get('verified_files') == report['inventory']['files'] for t in trials)
    summary = '## Artifact comparison\n\nAll 9 transfers preserve every file path, size, and SHA-256.\n\n'
    summary += '| Trial | Pack (s) | Unpack (s) | Files |\n| --- | ---: | ---: | ---: |\n'
    for t in trials:
        summary += f"| {t['trial']} | {t['pack_seconds']:.3f} | {t['unpack_seconds']:.3f} | {t['verified_files']} |\n"
    summary += '\nUse Upload/Download step timestamps for transfer timings; ZIP compression and extraction are already included there. See results artifact for inventory and measurements.\n'
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(summary)
    print(summary)


if __name__ == '__main__':
    command, *args = sys.argv[1:]
    {'inventory': prepare_manifest, 'prepare': prepare, 'verify': verify, 'summary': summarize}[command](*args)
