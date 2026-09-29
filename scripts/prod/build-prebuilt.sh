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
# entry into <output-dir>/manifest.json, recording the glibc the archive needs
# (the builder's, raised by any ELF in the tree that links a newer GLIBC_x.y;
# optional npm prebuilds listed in prebuilt-glibc-optional.txt are recorded
# as glibc_optional instead) and the node it was built with. The promote gate
# only sends a tag to hosts whose glibc meets that floor.
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

build_glibc="${AHV_BUILD_GLIBC:-$(getconf GNU_LIBC_VERSION | awk '{print $2}')}"
scan="$(python3 - "$src" "$build_glibc" "$(dirname "$0")/prebuilt-glibc-optional.txt" <<'PY'
import json, os, platform, re, sys
root, floor, optional_path = sys.argv[1:]
# e_machine of the ELF files this archive runs: x86-64 = 62, aarch64 = 183.
machine = {"x86_64": 62, "aarch64": 183, "arm64": 183}[platform.machine()]
try:
    optional = {l.strip() for l in open(optional_path, encoding="utf-8") if l.strip() and not l.startswith("#")}
except OSError:
    optional = set()
def key(v):
    return tuple(int(p) for p in v.split("."))
need = re.compile(rb"GLIBC_(\d+\.\d+(?:\.\d+)?)\0")
top, top_file, extra = floor, "", {}
for base, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d != ".git"]
    for name in files:
        path = os.path.join(base, name)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        try:
            with open(path, "rb") as stream:
                head = stream.read(20)
                if head[:4] != b"\x7fELF" or len(head) < 20 or int.from_bytes(head[18:20], "little") != machine:
                    continue
                data = head + stream.read()
        except OSError:
            continue
        versions = [v.decode() for v in need.findall(data)]
        if not versions:
            continue
        v = max(versions, key=key)
        rel = os.path.relpath(path, root)
        parts = rel.split(os.sep)
        # node_modules/.pnpm/<store-name>@<version>/...: the store name decides "optional".
        store = parts[2].rsplit("@", 1)[0] if len(parts) > 2 and parts[0] == "node_modules" and parts[1] == ".pnpm" else ""
        if store in optional:
            if key(v) > key(extra.get(store, "0")):
                extra[store] = v
            continue
        if key(v) > key(top):
            top, top_file = v, rel
if top_file:
    print(f"{top_file} needs GLIBC_{top} (builder has {floor})", file=sys.stderr)
print(json.dumps({"glibc": top, "optional": extra}))
PY
)" || { echo "glibc scan failed" >&2; exit 1; }
glibc="$(printf '%s' "$scan" | python3 -c 'import json,sys; print(json.load(sys.stdin)["glibc"])')"
glibc_optional="$(printf '%s' "$scan" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["optional"]))')"
node="$(node -v 2>/dev/null || echo unknown)"
# AHV_PREBUILT_REQUIRE_GLIBC: publish the archive only when it runs on hosts
# this old. release-cli.sh sets the fleet's floor: the reference machine's own
# build (glibc 2.39) then stays out of the channel and the platform is left to
# the glibc 2.28 CI build (mirror-prebuilt.sh) — so the canary host runs, and
# the promote gate judges, the very archive stable will get.
if [ -n "${AHV_PREBUILT_REQUIRE_GLIBC:-}" ] && ! python3 -c 'import sys; k=lambda v: tuple(int(p) for p in v.split(".")); sys.exit(0 if k(sys.argv[1]) <= k(sys.argv[2]) else 1)' "$glibc" "$AHV_PREBUILT_REQUIRE_GLIBC"; then
  echo "prebuilt $platform needs glibc $glibc > $AHV_PREBUILT_REQUIRE_GLIBC; not published (the CI build supplies it)" >&2
  mkdir -p "$out"
  python3 - "$out" "$tag" <<'PY'
import json, os, sys
out, tag = sys.argv[1:]
path = os.path.join(out, tag + ".json")
try:
    manifest = json.load(open(path, encoding="utf-8"))
except Exception:
    manifest = {}
if manifest.get("version") != tag:
    manifest = {"version": tag, "packages": {}}
manifest.setdefault("packages", {})
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as stream:
    json.dump(manifest, stream, indent=2)
    stream.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
print(json.dumps({"version": tag, "platform": None, "skipped": "glibc"}))
PY
  exit 0
fi

mkdir -p "$out"
file="ahv-cli-$tag-$platform.tar.zst"
tmp="$out/.$file.part"
# --strip-components=1 on the way in expects one top-level directory.
tar -C "$(dirname "$src")" --exclude="$(basename "$src")/.git" -cf - "$(basename "$src")" \
  | zstd -T0 -3 -q -o "$tmp" --force
sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
size="$(stat -c %s "$tmp")"
mv -f "$tmp" "$out/$file"

# Every tag gets its own manifest (<tag>.json). manifest.json describes the
# stable channel and is only rewritten when this tag is stable — or when no
# channels.json exists yet.
python3 - "$out" "$tag" "$platform" "$file" "$sha" "$size" "$glibc" "$node" "$build_glibc" "$glibc_optional" <<'PY'
import json
import os
import sys
import time

out, tag, platform, file, sha, size, glibc, node, build_glibc, glibc_optional = sys.argv[1:]

def load(path):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}

def write(path, data):
    # os.replace installs a brand-new inode, so it takes the writer's umask
    # rather than the mode of the file it replaces. Releases run under umask
    # 077, which left these 600 and made the web server answer 403 — every
    # host then fell back to its pinned tag. Set the mode explicitly.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)

entry = {
    "file": file, "sha256": sha, "size": int(size), "glibc": glibc, "node": node,
    "glibc_build": build_glibc, "glibc_optional": json.loads(glibc_optional),
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
