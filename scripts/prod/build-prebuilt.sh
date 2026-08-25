#!/usr/bin/env bash
# Package a built AHV CLI tree into the prebuilt archive that hosts download
# instead of building from source (the AHV CLI release channel on ahvclaw.com).
#
# Usage: scripts/prod/build-prebuilt.sh <tag> <output-dir> [source-dir]
#   output-dir on the reference machine is /srv/ahvclaw.com/releases/ahv-cli —
#   the CLI product's channel on ahvclaw.com, never a path under bot.ahvclaw.com.
#   source-dir defaults to /home/ahvproxy/.ahv/src (resolved through symlinks),
#   which must already be at <tag> with a baked AHV_VERSION.
#
# Writes <output-dir>/ahv-cli-<tag>-<platform>.tar.zst and merges the platform
# entry into <output-dir>/manifest.json, recording the glibc and node the tree
# was built against so a host with an older glibc keeps building from source.
set -euo pipefail

tag="${1:?tag}"
out="${2:?output dir}"
src="${3:-/home/ahvproxy/.ahv/src}"
src="$(readlink -f "$src")"

case "$(uname -m)" in
  x86_64) platform="linux-x64" ;;
  aarch64|arm64) platform="linux-arm64" ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

baked="$(sed -n 1p "$src/AHV_VERSION" 2>/dev/null || true)"
[ "$baked" = "$tag" ] || { echo "source at '$src' is '$baked', not $tag" >&2; exit 1; }
[ -f "$src/scripts/prod/ahv-wrapper.sh" ] || { echo "wrapper missing in $src" >&2; exit 1; }
[ -d "$src/node_modules" ] || { echo "node_modules missing in $src (not built)" >&2; exit 1; }
command -v zstd >/dev/null || { echo "zstd missing" >&2; exit 1; }

mkdir -p "$out"
file="ahv-cli-$tag-$platform.tar.zst"
tmp="$out/.$file.part"
# --strip-components=1 on the way in expects one top-level directory.
tar -C "$(dirname "$src")" --exclude="$(basename "$src")/.git" -cf - "$(basename "$src")" \
  | zstd -T0 -3 -q -o "$tmp" --force
sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
size="$(stat -c %s "$tmp")"
mv -f "$tmp" "$out/$file"

glibc="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
node="$(node -v 2>/dev/null || echo unknown)"
# Every tag gets its own manifest (<tag>.json). manifest.json describes the
# stable channel and is only rewritten when this tag is stable — or when no
# channels.json exists yet.
python3 - "$out" "$tag" "$platform" "$file" "$sha" "$size" "$glibc" "$node" <<'PY'
import json
import os
import sys
import time

out, tag, platform, file, sha, size, glibc, node = sys.argv[1:]

def load(path):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}

def write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    os.replace(tmp, path)

entry = {
    "file": file, "sha256": sha, "size": int(size), "glibc": glibc, "node": node,
    "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
tag_path = os.path.join(out, tag + ".json")
manifest = load(tag_path)
if manifest.get("version") != tag:
    manifest = {"version": tag, "packages": {}}
manifest.setdefault("packages", {})[platform] = entry
write(tag_path, manifest)

channels = load(os.path.join(out, "channels.json"))
if not channels or channels.get("stable") == tag:
    write(os.path.join(out, "manifest.json"), manifest)
print(json.dumps({"version": tag, "platform": platform, "file": file, "sha256": sha, "size": int(size)}))
PY
