#!/usr/bin/env python3
"""Run hand-selected behavioral mutants in isolated script copies, without publishing."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

PROD = Path(__file__).resolve().parents[1]
TEST = 'test-release-retention.py'
TIMER = 'test_timer_keeps_newest_numeric_version_plus_stable_and_canary'
SAFETY = 'test_only_exact_owned_files_are_removed'
CHANGED = 'test_changed_pointer_or_replaced_artifact_stops_a_stale_plan'
LOCK = 'test_cleanup_mirror_and_promote_wait_for_the_channel_writer'
RELEASE = 'test_release_prunes_after_the_new_canary_is_committed'
PROMOTE = 'test_promote_releases_the_old_stable_after_pointer_moves'
TARGET = 'test_invalid_pointer_targets_refuse_all_deletion'
PROMOTE_WARNING = 'test_promote_warns_when_cleanup_fails_after_stable_moves'
VALIDATE = '            validate_pointer(directory, tag)\n        except (OSError, ValueError) as error:'
FALLBACK_SKIP = '        except (OSError, ValueError):\n            continue'
FALLBACK_KEEP = '        keep.add(tag)\n        break'
FALLBACK = 'test_fallback_below_stable_is_kept_and_nothing_older'
SKIPPED = 'test_incomplete_fallback_candidate_is_skipped_without_error'
HOOK = 'python3 "$(dirname "$0")/prune-releases.py" "$dir"'
SHELL_LOCK = 'flock -x "$AHV_CHANNEL_LOCK_FD"'
WARNING = '  printf \'stable → %s OK; dọn kho lỗi: %s; chạy lại prune-releases.py\\n\' "$tag" "$cleanup_output" >&2'
MUTANTS = [
    ('keep-none', 'prune-releases.py', '[:1]', '[:0]', 'test_newest_version_no_channel_points_to_is_kept'),
    # Was checked by the one-version test; that case now keeps a fallback, so a dedicated case kills it.
    ('keep-two', 'prune-releases.py', '[:1]', '[:2]', 'test_unpromoted_newer_versions_expire_except_the_newest'),
    ('keep-three', 'prune-releases.py', '[:1]', '[:3]', TIMER),
    ('lexical-order', 'prune-releases.py', 'sorted(versions, key=version_key, reverse=True)', 'sorted(versions, key=lambda tag: tag, reverse=True)', TIMER),
    ('forget-stable', 'prune-releases.py', 'keep.add(value)', "keep.add(value) if key != 'stable' else None", TIMER),
    ('forget-canary', 'prune-releases.py', 'keep.add(value)', "keep.add(value) if key != 'canary' else None", 'test_canary_outside_newest_is_preserved_and_floor_is_not'),
    ('readd-floor-to-keep', 'prune-releases.py', "if key != 'store_floor':", 'if True:', 'test_canary_outside_newest_is_preserved_and_floor_is_not'),
    ('skip-floor-tag-shape-check', 'prune-releases.py', 'if not isinstance(value, str) or re.fullmatch(TAG, value) is None:', "if key != 'store_floor' and (not isinstance(value, str) or re.fullmatch(TAG, value) is None):", 'test_malformed_floor_refuses_all_deletion'),
    ('leave-archives', 'prune-releases.py', ' or ARCHIVE.fullmatch(entry.name)', '', TIMER),
    ('leave-glibc-variants', 'prune-releases.py', r'(?:-glibc[0-9]+(?:\.[0-9]+)+)?', '', TIMER),
    ('broad-archive-suffix', 'prune-releases.py', r"\.tar\.zst')", r"\.tar\.zst.*')", SAFETY),
    ('admit-nonregular-files', 'prune-releases.py', 'entry.is_file(follow_symlinks=False)', 'True', SAFETY),
    ('ignore-invalid-pointers', 'prune-releases.py', "raise ValueError(f'invalid or missing channel pointer: {key}')", 'continue', 'test_missing_or_invalid_channels_refuses_all_deletion'),
    ('skip-pointer-target-validation', 'prune-releases.py', VALIDATE, '            pass\n        except (OSError, ValueError) as error:', TARGET),
    ('skip-stable-target-validation', 'prune-releases.py', VALIDATE, "            if channels.get('stable') != tag: validate_pointer(directory, tag)\n        except (OSError, ValueError) as error:", TARGET),
    ('skip-canary-target-validation', 'prune-releases.py', VALIDATE, "            if channels.get('canary') != tag: validate_pointer(directory, tag)\n        except (OSError, ValueError) as error:", TARGET),
    ('validate-floor-target', 'prune-releases.py', 'for tag in keep:', "for tag in keep | ({channels['store_floor']} if 'store_floor' in channels else set()):", 'test_floor_without_files_is_not_an_error_and_existing_floor_files_expire'),
    ('ignore-pointer-version-mismatch', 'prune-releases.py', "if not isinstance(manifest, dict) or manifest.get('version') != tag:", 'if False:', TARGET),
    ('allow-pointer-manifest-symlink', 'prune-releases.py', 'path.lstat().st_mode', 'path.stat().st_mode', TARGET),
    ('allow-pointer-archive-symlink', 'prune-releases.py', '(directory / name).lstat().st_mode', '(directory / name).stat().st_mode', TARGET),
    ('only-validate-first-package', 'prune-releases.py', 'for package in packages.values():', 'for package in list(packages.values())[:1]:', TARGET),
    ('drop-pointer-error-tag', 'prune-releases.py', "raise ValueError(f'pointer {tag}: {error}') from error", 'raise ValueError(str(error)) from error', TARGET),
    ('ignore-pointer-change', 'prune-releases.py', 'if channels_path.read_bytes() != snapshot:', 'if False:', CHANGED),
    ('ignore-artifact-change', 'prune-releases.py', 'if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size) != (original.st_dev, original.st_ino, original.st_mtime_ns, original.st_size):', 'if False:', CHANGED),
    ('drop-fallback', 'prune-releases.py', FALLBACK_KEEP, '        break', FALLBACK),
    ('fallback-by-canary', 'prune-releases.py', "stable_key = version_key(channels['stable'])", "stable_key = version_key(channels['canary'])", 'test_canary_newer_than_stable_keeps_fallback_of_stable'),
    ('fallback-ignores-floor', 'prune-releases.py', '(floor_key is None or version_key(tag) >= floor_key)', 'True', 'test_floor_bounds_the_fallback'),
    ('fallback-floor-exclusive', 'prune-releases.py', 'version_key(tag) >= floor_key', 'version_key(tag) > floor_key', 'test_floor_bounds_the_fallback'),
    ('fallback-skips-completeness-check', 'prune-releases.py', '            validate_pointer(directory, tag)\n        except (OSError, ValueError):', '            pass\n        except (OSError, ValueError):', SKIPPED),
    ('fallback-incomplete-is-fatal', 'prune-releases.py', FALLBACK_SKIP, '        except (OSError, ValueError):\n            raise', SKIPPED),
    ('fallback-stops-at-incomplete', 'prune-releases.py', FALLBACK_SKIP, '        except (OSError, ValueError):\n            break', SKIPPED),
    ('fallback-compares-text', 'prune-releases.py', 'version_key(tag) < stable_key', "tag < channels['stable']", 'test_fallback_compares_version_numbers_not_text'),
    ('fallback-picks-by-text', 'prune-releases.py', 'sorted(candidates, key=version_key, reverse=True)', 'sorted(candidates, key=lambda tag: tag, reverse=True)', 'test_fallback_compares_version_numbers_not_text'),
    ('fallback-includes-stable', 'prune-releases.py', 'version_key(tag) < stable_key', 'version_key(tag) <= stable_key', FALLBACK),
    ('keep-every-version-below-stable', 'prune-releases.py', FALLBACK_KEEP, '        keep.add(tag)', FALLBACK),
    ('skip-prune-lock', 'prune-releases.py', 'fcntl.flock(descriptor, fcntl.LOCK_EX)', 'pass', LOCK),
    ('skip-mirror-lock', 'mirror-prebuilt.sh', SHELL_LOCK, ':', LOCK),
    ('skip-promote-lock', 'promote.sh', SHELL_LOCK, ':', LOCK),
    ('skip-release-lock', 'release-cli.sh', SHELL_LOCK, ':', RELEASE),
    ('skip-mirror-cleanup', 'mirror-prebuilt.sh', HOOK, ':', TIMER),
    ('skip-promote-cleanup', 'promote.sh', HOOK, ':', PROMOTE),
    ('promote-fails-after-pointer-moves', 'promote.sh', WARNING, '  exit 1', PROMOTE_WARNING),
    ('hide-promote-cleanup-warning', 'promote.sh', WARNING, '  :', PROMOTE_WARNING),
    ('hide-promote-cleanup-reason', 'promote.sh', WARNING, WARNING.replace('"$cleanup_output"', '"failed"'), PROMOTE_WARNING),
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
