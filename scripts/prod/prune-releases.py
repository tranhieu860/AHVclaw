#!/usr/bin/env python3
"""Keep the three newest AHV CLI versions plus the channel and store-floor tags.

Only regular files with complete names emitted by build-prebuilt.sh and
mirror-prebuilt.sh are eligible. Symlinks, directories and partial files stay.
Missing or invalid channel pointers stop cleanup before any deletion.
"""
import json
import fcntl
import os
from pathlib import Path
import re
import stat
import sys

TAG = r'v[0-9]+\.[0-9]+\.[0-9]+'
MANIFEST = re.compile(rf'({TAG})\.json')
ARCHIVE = re.compile(rf'ahv-cli-({TAG})-linux-(?:x64|arm64)(?:-glibc[0-9]+(?:\.[0-9]+)+)?\.tar\.zst')


def prune(directory):
    """Lock the channel directory before planning or deleting any artifacts."""
    inherited = os.environ.get('AHV_CHANNEL_LOCK_FD')
    descriptor = os.dup(int(inherited)) if inherited is not None else os.open(directory, os.O_RDONLY)
    try:
        opened = os.fstat(descriptor)
        target = os.stat(directory)
        if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (target.st_dev, target.st_ino):
            raise ValueError('channel lock descriptor does not match the directory')
        # The shell passes its locked descriptor; dup shares that same flock.
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        prune_locked(directory)
    finally:
        os.close(descriptor)


def prune_locked(directory):
    """Unlink each expired, exactly identified artifact while the caller holds the lock."""
    directory = Path(directory)
    channels_path = directory / 'channels.json'
    snapshot = channels_path.read_bytes()
    channels = json.loads(snapshot)
    if not isinstance(channels, dict):
        raise ValueError('channels.json must be an object')
    keep = set()
    for key in ('stable', 'canary', 'store_floor'):
        if key == 'store_floor' and key not in channels:
            continue
        value = channels.get(key)
        if not isinstance(value, str) or re.fullmatch(TAG, value) is None:
            raise ValueError(f'invalid or missing channel pointer: {key}')
        keep.add(value)
    artifacts = []
    with os.scandir(directory) as entries:
        for entry in entries:
            match = MANIFEST.fullmatch(entry.name) or ARCHIVE.fullmatch(entry.name)
            if match is not None and entry.is_file(follow_symlinks=False):
                artifacts.append((entry.name, match[1], entry.stat(follow_symlinks=False)))
    versions = {tag for _, tag, _ in artifacts}
    keep.update(sorted(versions, key=lambda tag: tuple(int(p) for p in tag[1:].split('.')), reverse=True)[:3])
    for name, tag, original in artifacts:
        if tag in keep:
            continue
        # Also detect changes by external writers that do not follow the lock protocol.
        if channels_path.read_bytes() != snapshot:
            raise ValueError('channels.json changed during cleanup; retry')
        path = directory / name
        current = path.lstat()
        if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size) != (original.st_dev, original.st_ino, original.st_mtime_ns, original.st_size):
            raise ValueError(f'artifact changed during cleanup: {name}; retry')
        path.unlink()
        print(f'prune: removed {name}')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('usage: prune-releases.py <channel-dir>')
        prune(sys.argv[1])
    except (OSError, ValueError) as error:
        sys.exit(f'prune: {error}')
