#!/usr/bin/env python3
"""Exercise retention through the mirror timer using only temporary files."""
import json
import importlib.util
import fcntl
import os
from pathlib import Path
import subprocess
import shutil
import stat
import tempfile
import unittest
import sys
from contextlib import contextmanager
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


class ReleaseRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ahv-retention-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.channel = self.root / 'channel'
        self.channel.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        # No network: every asset request is a deterministic miss.
        curl = self.bin / 'curl'
        curl.write_text('#!/bin/sh\nprintf requested > "$HOME/requested"\nexit 22\n')
        curl.chmod(0o755)
        self.env = dict(PATH=f'{self.bin}:{os.environ["PATH"]}',
                        HOME=str(self.root), AHV_MIRROR_PLATFORMS='linux-x64')
        self.pointers = {'stable': 'v0.2.2', 'canary': 'v0.2.10', 'store_floor': 'v0.2.1'}
        self.channels()

    def channels(self):
        (self.channel / 'channels.json').write_text(json.dumps(self.pointers))

    def release(self, tag):
        names = [f'{tag}.json', f'ahv-cli-{tag}-linux-x64.tar.zst',
                 f'ahv-cli-{tag}-linux-arm64.tar.zst',
                 f'ahv-cli-{tag}-linux-x64-glibc2.28.tar.zst']
        packages = {platform: {'file': name} for platform, name in zip(
            ['linux-x64', 'linux-arm64', 'linux-x64-glibc2.28'], names[1:])}
        (self.channel / names[0]).write_text(json.dumps({'version': tag, 'packages': packages}))
        for name in names[1:]:
            (self.channel / name).write_text('archive bytes')
        return set(names)

    def mirror(self):
        return subprocess.run(['bash', str(SCRIPTS / 'mirror-prebuilt.sh'), str(self.channel)],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def test_timer_keeps_three_newest_numeric_versions_plus_all_pointers(self):
        kept = {'channels.json'}
        removed = set()
        for tag in ['v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.8', 'v0.2.9', 'v0.2.10']:
            names = self.release(tag)
            (kept if tag in ['v0.2.1', 'v0.2.2', 'v0.2.8', 'v0.2.9', 'v0.2.10'] else removed).update(names)
        # Historical archives can outlive their tag manifest after an interrupted cleanup.
        orphan = 'ahv-cli-v0.2.0-linux-x64.tar.zst'
        (self.channel / orphan).write_text('old orphan')
        removed.add(orphan)
        result = self.mirror()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(p.name for p in self.channel.iterdir()), kept)
        self.assertTrue(all(not (self.channel / name).exists() for name in removed))
        self.assertEqual(json.loads((self.channel / 'channels.json').read_text()), self.pointers)
        # The periodic pass must also work with nothing new downloaded.
        self.assertEqual(self.mirror().returncode, 0)
        self.assertEqual(set(p.name for p in self.channel.iterdir()), kept)

    def test_canary_and_floor_outside_latest_three_are_preserved(self):
        self.pointers = {'stable': 'v0.2.10', 'canary': 'v0.2.1', 'store_floor': 'v0.2.2'}
        self.channels()
        for tag in ['v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.8', 'v0.2.9', 'v0.2.10']:
            self.release(tag)
        self.assertEqual(self.mirror().returncode, 0)
        for tag in ['v0.2.1', 'v0.2.2', 'v0.2.8', 'v0.2.9', 'v0.2.10']:
            self.assertTrue((self.channel / f'{tag}.json').exists(), tag)
        self.assertFalse((self.channel / 'v0.2.3.json').exists())

    def test_only_exact_owned_files_are_removed(self):
        for tag in ['v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.8', 'v0.2.9', 'v0.2.10']:
            self.release(tag)
        untouched = ['manifest.json', 'notes.txt', 'v0.2.3.json.backup',
                     'ahv-cli-v0.2.3-linux-x64.tar.zst.part',
                     '.ahv-cli-v0.2.3-linux-x64.tar.zst.part',
                     'ahv-cli-v0.2.3-linux-x64.tar.zst.bak',
                     'ahv-cli-v0.2.3-linux-x64-extra.tar.zst',
                     'ahv-cli-v0.2.3-linux-x64-glibc2.28.tar.zst.backup',
                     'ahv-cli-v0.2.3-windows-x64.tar.zst', 'v99.0.0.json.backup']
        for name in untouched:
            (self.channel / name).write_text('leave this byte for byte')
        outside = self.root / 'outside'
        outside.write_text('outside remains')
        (self.channel / 'v0.2.0.json').symlink_to(outside)
        (self.channel / 'ahv-cli-v0.2.0-linux-arm64.tar.zst').symlink_to(outside)
        (self.channel / 'v0.2.99.json').mkdir()
        (self.channel / 'ahv-cli-v0.2.3-linux-s390x.tar.zst').mkdir()
        self.assertEqual(self.mirror().returncode, 0)
        self.assertFalse((self.channel / 'v0.2.3.json').exists())
        for name in untouched:
            self.assertTrue((self.channel / name).exists(), name)
            self.assertEqual((self.channel / name).read_text(), 'leave this byte for byte', name)
        self.assertTrue((self.channel / 'v0.2.0.json').is_symlink())
        self.assertTrue((self.channel / 'ahv-cli-v0.2.0-linux-arm64.tar.zst').is_symlink())
        self.assertTrue((self.channel / 'v0.2.99.json').is_dir())
        self.assertEqual(outside.read_text(), 'outside remains')

    def test_missing_or_invalid_channels_refuses_all_deletion(self):
        for tag in ['v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.8', 'v0.2.9', 'v0.2.10']:
            self.release(tag)
        path = self.channel / 'channels.json'
        for payload in [None, '{', '[]', '{}', '{"stable":"../v0.2.2","canary":"v0.2.10"}',
                        '{"stable":"v0.2.2","canary":"v0.2.10","store_floor":3}']:
            with self.subTest(payload=payload):
                if payload is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(payload)
                before = {p.name: p.read_bytes() for p in self.channel.iterdir()}
                result = self.mirror()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual({p.name: p.read_bytes() for p in self.channel.iterdir()}, before)

    def test_fewer_than_three_versions_and_duplicate_pointers(self):
        self.pointers = {'stable': 'v0.2.9', 'canary': 'v0.2.9'}
        self.channels()
        self.release('v0.2.8')
        self.release('v0.2.9')
        before = {p.name: p.read_bytes() for p in self.channel.iterdir()}
        self.assertEqual(self.mirror().returncode, 0)
        self.assertEqual({p.name: p.read_bytes() for p in self.channel.iterdir()}, before)

    def test_invalid_pointer_targets_refuse_all_deletion(self):
        # Skipping any pointer's manifest/archive validation must leave an expired
        # release eligible for deletion here, making the preservation check fail.
        def snapshot():
            result = {}
            for path in self.channel.iterdir():
                mode = path.lstat().st_mode
                if stat.S_ISLNK(mode):
                    content = os.readlink(path)
                elif stat.S_ISREG(mode):
                    try:
                        content = path.read_bytes()
                    except PermissionError:
                        content = None
                else:
                    content = None
                result[path.name] = (mode, content)
            return result

        for pointer in ['stable', 'canary', 'store_floor']:
            for defect in ['missing-manifest', 'missing-archive', 'version-mismatch',
                           'manifest-symlink', 'manifest-directory', 'archive-symlink',
                           'archive-directory', 'invalid-json', 'unreadable-manifest']:
                with self.subTest(pointer=pointer, defect=defect):
                    shutil.rmtree(self.channel)
                    self.channel.mkdir()
                    self.pointers = {'stable': 'v0.2.10', 'canary': 'v0.2.10', 'store_floor': 'v0.2.10'}
                    self.pointers[pointer] = 'v0.2.1'
                    self.channels()
                    for tag in ['v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.8', 'v0.2.9', 'v0.2.10']:
                        self.release(tag)
                    manifest = self.channel / 'v0.2.1.json'
                    archive = self.channel / 'ahv-cli-v0.2.1-linux-arm64.tar.zst'
                    if defect == 'missing-manifest':
                        manifest.unlink()
                    elif defect == 'missing-archive':
                        archive.unlink()
                    elif defect == 'version-mismatch':
                        data = json.loads(manifest.read_text())
                        data['version'] = 'v0.2.99'
                        manifest.write_text(json.dumps(data))
                    elif defect in ['manifest-symlink', 'archive-symlink']:
                        target = manifest if defect == 'manifest-symlink' else archive
                        outside = self.root / 'symlink-target'
                        outside.write_bytes(target.read_bytes())
                        target.unlink()
                        target.symlink_to(outside)
                    elif defect in ['manifest-directory', 'archive-directory']:
                        target = manifest if defect == 'manifest-directory' else archive
                        target.unlink()
                        target.mkdir()
                    elif defect == 'invalid-json':
                        manifest.write_text('{')
                    else:
                        unreadable_bytes = manifest.read_bytes()
                        manifest.chmod(0)
                    before = snapshot()
                    result = subprocess.run(['python3', str(SCRIPTS / 'prune-releases.py'), str(self.channel)],
                                            env=self.env, capture_output=True, text=True, timeout=20)
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('v0.2.1', result.stderr)
                    self.assertEqual(snapshot(), before)
                    if defect == 'unreadable-manifest':
                        manifest.chmod(0o644)
                        self.assertEqual(manifest.read_bytes(), unreadable_bytes)

    def test_promote_warns_when_cleanup_fails_after_stable_moves(self):
        self.pointers = {'stable': 'v0.2.56', 'canary': 'invalid-tag', 'store_floor': 'v0.2.57'}
        self.channels()
        for tag in ['v0.2.56', 'v0.2.57', 'v0.2.58', 'v0.2.59', 'v0.2.60', 'v0.2.61']:
            self.release(tag)
        before = {p.name: p.read_bytes() for p in self.channel.iterdir() if p.name != 'channels.json'}
        result = subprocess.run(['bash', str(SCRIPTS / 'promote.sh'), 'v0.2.60', str(self.channel)],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads((self.channel / 'channels.json').read_text())['stable'], 'v0.2.60')
        self.assertEqual((self.channel / 'manifest.json').read_bytes(), before['v0.2.60.json'])
        self.assertIn('stable → v0.2.60 OK; dọn kho lỗi: prune: invalid or missing channel pointer: canary; '
                      'chạy lại prune-releases.py', result.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in self.channel.iterdir()
                          if p.name not in ['channels.json', 'manifest.json']}, before)

    def test_changed_pointer_or_replaced_artifact_stops_a_stale_plan(self):
        spec = importlib.util.spec_from_file_location('prune_releases', SCRIPTS / 'prune-releases.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        scandir = os.scandir
        for change in ['pointer', 'artifact']:
            with self.subTest(change=change):
                self.pointers['store_floor'] = 'v0.2.1'
                self.channels()
                for tag in ['v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.8', 'v0.2.9', 'v0.2.10']:
                    self.release(tag)
                @contextmanager
                def concurrent_writer(directory):
                    with scandir(directory) as entries:
                        yield entries
                    if change == 'pointer':
                        self.pointers['store_floor'] = 'v0.2.3'
                        self.channels()
                    else:
                        target = self.channel / 'v0.2.3.json'
                        replacement = self.channel / 'replacement.tmp'
                        replacement.write_text('replacement must survive')
                        replacement.replace(target)
                with patch.object(module.os, 'scandir', concurrent_writer):
                    with self.assertRaisesRegex(ValueError, 'changed during cleanup'):
                        module.prune(self.channel)
                self.assertTrue((self.channel / 'v0.2.3.json').exists())

    def test_promote_releases_the_old_stable_after_pointer_moves(self):
        self.pointers = {'stable': 'v0.2.56', 'canary': 'v0.2.61', 'store_floor': 'v0.2.57'}
        self.channels()
        for tag in ['v0.2.56', 'v0.2.57', 'v0.2.58', 'v0.2.59', 'v0.2.60', 'v0.2.61']:
            self.release(tag)
        result = subprocess.run(['bash', str(SCRIPTS / 'promote.sh'), 'v0.2.60', str(self.channel)],
                                env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.channel / 'v0.2.56.json').exists())
        self.assertFalse((self.channel / 'v0.2.58.json').exists())
        for tag in ['v0.2.57', 'v0.2.59', 'v0.2.60', 'v0.2.61']:
            self.assertTrue((self.channel / f'{tag}.json').exists(), tag)
        self.assertEqual(json.loads((self.channel / 'manifest.json').read_text())['version'], 'v0.2.60')

    def test_cleanup_mirror_and_promote_wait_for_the_channel_writer(self):
        commands = [
            ['python3', str(SCRIPTS / 'prune-releases.py'), str(self.channel)],
            ['bash', str(SCRIPTS / 'mirror-prebuilt.sh'), str(self.channel)],
            ['bash', str(SCRIPTS / 'promote.sh'), 'v0.2.60', str(self.channel)],
        ]
        for command in commands:
            with self.subTest(command=command[1]):
                self.pointers = {'stable': 'v0.2.61', 'canary': 'v0.2.61', 'store_floor': 'v0.2.57'}
                self.channels()
                for tag in ['v0.2.56', 'v0.2.57', 'v0.2.59', 'v0.2.60', 'v0.2.61']:
                    self.release(tag)
                lock = os.open(self.channel, os.O_RDONLY)
                (self.root / 'requested').unlink(missing_ok=True)
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    process = subprocess.Popen(command, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    waited = False
                    try:
                        process.communicate(timeout=0.3)
                    except subprocess.TimeoutExpired:
                        waited = True
                    finally:
                        while_locked = json.loads((self.channel / 'channels.json').read_text())
                        requested_while_locked = (self.root / 'requested').exists()
                        # The queued cleaner must use this latest pointer after acquiring the lock.
                        self.pointers['store_floor'] = 'v0.2.56'
                        self.channels()
                        fcntl.flock(lock, fcntl.LOCK_UN)
                    out, err = process.communicate(timeout=20)
                finally:
                    os.close(lock)
                self.assertTrue(waited, f'did not wait for writer: {out!r} {err!r}')
                self.assertEqual(while_locked['stable'], 'v0.2.61')
                self.assertFalse(requested_while_locked)
                self.assertEqual(process.returncode, 0, err)
                self.assertTrue((self.channel / 'v0.2.56.json').exists())

    def test_release_prunes_after_the_new_canary_is_committed(self):
        # Execute the real release orchestrator in a fixture tree. All build,
        # smoke and git operations are replaced; no tag or remote is touched.
        fork = self.root / 'fork'
        prod = fork / 'scripts' / 'prod'
        (prod / 'tests').mkdir(parents=True)
        for name in ['release-cli.sh', 'prune-releases.py']:
            shutil.copyfile(SCRIPTS / name, prod / name)
        release_script = prod / 'release-cli.sh'
        release_script.write_text(release_script.read_text().replace('/tmp/ahv-release-build-', str(self.root / 'release-build-')))
        git = self.bin / 'git'
        git.write_text('''#!/bin/sh
case "$1" in
  rev-parse) case "$2" in --abbrev-ref) echo master;; *) echo true;; esac;;
  tag) case "$*" in *--sort*) echo v0.2.100;; esac;;
  rev-list) echo 1;;
  push) printf pushed > "$HOME/pushed";;
  status|fetch) :;;
  *) echo "unexpected fake git command: $*" >&2; exit 1;;
esac
''')
        git.chmod(0o755)
        (prod / 'install.sh').write_text('''#!/bin/sh
mkdir -p "$AHV_HOME/bin"
cat > "$AHV_HOME/bin/ahv" <<'CLI'
#!/bin/sh
case "$1" in
  --version) echo 'ahv v0.2.101';;
  doctor) echo '{"ok":true,"error_count":0}';;
  login) echo '{"providers":{"claude":{}}}';;
  *) exit 1;;
esac
CLI
chmod +x "$AHV_HOME/bin/ahv"
''')
        (prod / 'smoke-run.sh').write_text('echo fixture-smoke\n')
        for name in ['test-browser-playwright.sh', 'test-no-telemetry.sh']:
            (prod / 'tests' / name).write_text('exit 0\n')
        (prod / 'tests' / 'test-subscriptions-keep-session.mjs').write_text('process.exit(0)\n')
        (prod / 'build-prebuilt.sh').write_text('''#!/bin/sh
mkdir -p "$2"
printf '{"version":"%s","packages":{}}' "$1" > "$2/$1.json"
printf bytes > "$2/ahv-cli-$1-linux-x64.tar.zst"
''')
        self.pointers = {'stable': 'v0.2.90', 'canary': 'v0.2.100', 'store_floor': 'v0.2.91'}
        self.channels()
        for tag in ['v0.2.90', 'v0.2.91', 'v0.2.98', 'v0.2.99', 'v0.2.100']:
            self.release(tag)
        env = dict(self.env, AHV_RELEASE_DIR=str(self.channel),
                   AHV_BUILD_HOME=str(self.root / 'build'), AHV_BUILD_USER=str(os.getuid()))
        # id -un must agree with BUILD_USER; no sudo/account switch is allowed.
        identity = self.bin / 'id'
        identity.write_text(f'#!/bin/sh\necho {os.getuid()}\n')
        identity.chmod(0o755)
        lock = os.open(self.channel, os.O_RDONLY)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(['bash', str(prod / 'release-cli.sh')], env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    process.communicate(timeout=0.7)
                published_while_locked = (self.channel / 'v0.2.101.json').exists()
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                out, err = process.communicate(timeout=20)
        finally:
            os.close(lock)
        self.assertFalse(published_while_locked)
        self.assertEqual(process.returncode, 0, out + err)
        self.assertEqual((self.root / 'pushed').read_text(), 'pushed')
        self.assertEqual(json.loads((self.channel / 'channels.json').read_text())['canary'], 'v0.2.101')
        self.assertFalse((self.channel / 'v0.2.98.json').exists())
        for tag in ['v0.2.90', 'v0.2.91', 'v0.2.99', 'v0.2.100', 'v0.2.101']:
            self.assertTrue((self.channel / f'{tag}.json').exists(), tag)


if __name__ == '__main__':
    unittest.main()
