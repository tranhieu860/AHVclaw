#!/usr/bin/env bash
# Pull platform archives GitHub Actions attached to a release into the
# channel directory on ahvclaw.com and merge them into that tag's manifest.
# linux-arm64 only exists there. linux-x64 is also built there, inside a
# glibc 2.28 container, and replaces the reference machine's own x64 build
# (glibc 2.39) whenever it needs an older glibc: one archive then serves every
# host, and no host falls back to building the CLI from source — which a
# dsh 0.2 core cannot do on a small or old host (29/09: #5 #6 broke, #1 hit
# 3.6 GB). The CI archive keeps a name of its own so a host already
# downloading the reference archive is not cut off mid-file.
# Idempotent; run from a timer. Only tags named in channels.json are considered.
#
# Usage: scripts/prod/mirror-prebuilt.sh [channel-dir]
set -euo pipefail
dir="${1:-/srv/ahvclaw.com/releases/ahv-cli}"
repo="${AHV_GITHUB_REPO:-tranhieu860/AHVclaw}"
platforms="${AHV_MIRROR_PLATFORMS:-linux-arm64 linux-x64}"
tags="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(" ".join(sorted(set(v for v in d.values() if isinstance(v,str)))))' "$dir/channels.json" 2>/dev/null || true)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Prints "<local-file> <sha256>" when the CI entry should be mirrored, nothing otherwise.
plan() {
  python3 - "$dir" "$1" "$2" "$work/meta.json" <<'PY'
import json, os, re, sys
d, tag, platform, meta_path = sys.argv[1:]
def parse(value):
    return tuple(int(p) for p in str(value).split("."))
ci = json.load(open(meta_path))["packages"][platform]
# The name becomes a path in the channel and part of a URL: only the exact
# asset name this workflow produces, with a hex sha256 and a numeric glibc.
if (ci.get("file") != f"ahv-cli-{tag}-{platform}.tar.zst" or not re.fullmatch(r"v\d+\.\d+\.\d+", tag)
        or not re.fullmatch(r"[0-9a-f]{64}", str(ci.get("sha256", ""))) or not re.fullmatch(r"\d+(\.\d+)+", str(ci.get("glibc", "")))):
    sys.exit(1)
try:
    current = json.load(open(os.path.join(d, tag + ".json")))["packages"].get(platform)
except (OSError, ValueError, KeyError):
    current = None
if current and current.get("sha256") == ci["sha256"]:
    sys.exit(0)  # already merged
if current and parse(ci.get("glibc", "999")) >= parse(current.get("glibc", "0")):
    sys.exit(0)  # the channel's archive already runs on every host the CI one would
name = ci["file"]
if current and current.get("file") == name:
    # Same name as the reference build: give the CI bytes their own.
    name = name.replace(".tar.zst", f"-glibc{ci.get('glibc', 'ci')}.tar.zst")
print(name, ci["sha256"])
PY
}

merge() { # tag platform local-file
  python3 - "$dir" "$1" "$2" "$3" "$work/meta.json" <<'PY'
import json, os, sys
d, tag, platform, name, meta_path = sys.argv[1:]
entry = dict(json.load(open(meta_path))["packages"][platform], file=name)
def write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
path = os.path.join(d, tag + ".json")
try:
    manifest = json.load(open(path))
except (OSError, ValueError):
    manifest = {}
if manifest.get("version") != tag:
    manifest = {"version": tag, "packages": {}}
manifest.setdefault("packages", {})[platform] = entry
write(path, manifest)
channels = json.load(open(os.path.join(d, "channels.json")))
if channels.get("stable") == tag:
    write(os.path.join(d, "manifest.json"), manifest)
print(f"mirror: merged {platform} ({name}, glibc {entry.get('glibc')}) into {tag}.json")
PY
}

for tag in $tags; do
  for platform in $platforms; do
    curl -fsSL --max-time 30 "https://github.com/$repo/releases/download/$tag/$tag-$platform.json" -o "$work/meta.json" 2>/dev/null || continue
    decision="$(plan "$tag" "$platform" 2>/dev/null)" || { echo "mirror: unusable metadata for $tag $platform" >&2; continue; }
    [ -n "$decision" ] || continue
    read -r file sha <<< "$decision"
    case "$file" in */*|*..*|"") echo "mirror: unsafe file name for $tag $platform" >&2; continue ;; esac
    if [ ! -f "$dir/$file" ] || [ "$(sha256sum "$dir/$file" | cut -d' ' -f1)" != "$sha" ]; then
      echo "mirror: fetching $file"
      asset="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"][sys.argv[2]]["file"])' "$work/meta.json" "$platform")"
      curl -fsSL --max-time 900 "https://github.com/$repo/releases/download/$tag/$asset" -o "$dir/$file.part" || { rm -f "$dir/$file.part"; continue; }
      if [ "$(sha256sum "$dir/$file.part" | cut -d' ' -f1)" != "$sha" ]; then
        echo "mirror: checksum mismatch for $file, discarding" >&2
        rm -f "$dir/$file.part"; continue
      fi
      mv -f "$dir/$file.part" "$dir/$file"
    fi
    chmod 644 "$dir/$file"
    merge "$tag" "$platform" "$file"
  done
done
