#!/usr/bin/env python3
"""Run hand-selected behavioral mutants in isolated script copies, without publishing."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

PROD = Path(__file__).resolve().parents[1]
TEST = 'test-release-retention.py'
TIMER = 'test_timer_keeps_three_newest_numeric_versions_plus_all_pointers'
SAFETY = 'test_only_exact_owned_files_are_removed'
CHANGED = 'test_changed_pointer_or_replaced_artifact_stops_a_stale_plan'
LOCK = 'test_cleanup_mirror_and_promote_wait_for_the_channel_writer'
RELEASE = 'test_release_prunes_after_the_new_canary_is_committed'
PROMOTE = 'test_promote_releases_the_old_stable_after_pointer_moves'
HOOK = 'python3 "$(dirname "$0")/prune-releases.py" "$dir"'
SHELL_LOCK = 'flock -x "$AHV_CHANNEL_LOCK_FD"'
MUTANTS = [
    ('keep-two', 'prune-releases.py', '[:3]', '[:2]', TIMER),
    ('keep-four', 'prune-releases.py', '[:3]', '[:4]', TIMER),
    ('lexical-order', 'prune-releases.py', "key=lambda tag: tuple(int(p) for p in tag[1:].split('.'))", 'key=lambda tag: tag', TIMER),
    ('forget-stable', 'prune-releases.py', 'keep.add(value)', "keep.add(value) if key != 'stable' else None", TIMER),
    ('forget-canary', 'prune-releases.py', 'keep.add(value)', "keep.add(value) if key != 'canary' else None", 'test_canary_and_floor_outside_latest_three_are_preserved'),
    ('forget-floor', 'prune-releases.py', 'keep.add(value)', "keep.add(value) if key != 'store_floor' else None", TIMER),
    ('leave-archives', 'prune-releases.py', ' or ARCHIVE.fullmatch(entry.name)', '', TIMER),
    ('leave-glibc-variants', 'prune-releases.py', r'(?:-glibc[0-9]+(?:\.[0-9]+)+)?', '', TIMER),
    ('broad-archive-suffix', 'prune-releases.py', r"\.tar\.zst')", r"\.tar\.zst.*')", SAFETY),
    ('admit-nonregular-files', 'prune-releases.py', 'entry.is_file(follow_symlinks=False)', 'True', SAFETY),
    ('ignore-invalid-pointers', 'prune-releases.py', "if not isinstance(value, str) or re.fullmatch(TAG, value) is None:", 'if False:', 'test_missing_or_invalid_channels_refuses_all_deletion'),
    ('ignore-pointer-change', 'prune-releases.py', 'if channels_path.read_bytes() != snapshot:', 'if False:', CHANGED),
    ('ignore-artifact-change', 'prune-releases.py', 'if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size) != (original.st_dev, original.st_ino, original.st_mtime_ns, original.st_size):', 'if False:', CHANGED),
    ('skip-prune-lock', 'prune-releases.py', 'fcntl.flock(descriptor, fcntl.LOCK_EX)', 'pass', LOCK),
    ('skip-mirror-lock', 'mirror-prebuilt.sh', SHELL_LOCK, ':', LOCK),
    ('skip-promote-lock', 'promote.sh', SHELL_LOCK, ':', LOCK),
    ('skip-release-lock', 'release-cli.sh', SHELL_LOCK, ':', RELEASE),
    ('skip-mirror-cleanup', 'mirror-prebuilt.sh', HOOK, ':', TIMER),
    ('skip-promote-cleanup', 'promote.sh', HOOK, ':', PROMOTE),
    ('skip-release-cleanup', 'release-cli.sh', 'python3 "$FORK/scripts/prod/prune-releases.py" "$RELEASE_DIR"', ':', RELEASE),
]


def main():
    baseline = subprocess.run([sys.executable, str(PROD / 'tests' / TEST)], capture_output=True, text=True, timeout=90)
    if baseline.returncode:
        sys.exit('BASELINE FAILED\n' + baseline.stdout + baseline.stderr)
    killed = survived = invalid = 0
    for name, filename, old, new, method in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='ahv-retention-mutant-') as root:
            copy = Path(root) / 'scripts' / 'prod'
            (copy / 'tests').mkdir(parents=True)
            for source in ['prune-releases.py', 'release-cli.sh', 'mirror-prebuilt.sh', 'promote.sh']:
                shutil.copyfile(PROD / source, copy / source)
            shutil.copyfile(PROD / 'tests' / TEST, copy / 'tests' / TEST)
            target = copy / filename
            source = target.read_text()
            if source.count(old) != 1:
                sys.exit(f'{name}: mutation anchor count {source.count(old)}')
            target.write_text(source.replace(old, new))
            result = subprocess.run([sys.executable, str(copy / 'tests' / TEST), f'ReleaseRetentionTests.{method}'],
                                    capture_output=True, text=True, timeout=90)
            if result.returncode and 'FAILED (failures=' in result.stderr and 'errors=' not in result.stderr:
                killed += 1
                print(f'KILLED {name}', flush=True)
            elif result.returncode:
                invalid += 1
                print(f'INVALID {name}\n{result.stdout}{result.stderr}', flush=True)
            else:
                survived += 1
                print(f'SURVIVED {name}', flush=True)
    print(f'{killed} killed, {survived} survived, {invalid} invalid; {len(MUTANTS)} total', flush=True)
    return 1 if survived or invalid else 0


if __name__ == '__main__':
    sys.exit(main())
