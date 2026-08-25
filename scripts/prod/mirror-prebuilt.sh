#!/usr/bin/env bash
# Pull platform archives GitHub Actions attached to a release into the
# channel directory on ahvclaw.com and merge them into that tag's manifest.
# The reference machine builds linux-x64 itself; this is how linux-arm64 (and
# any platform it cannot build) reaches the channel. Idempotent; run from a
# timer. Only tags named in channels.json are considered.
#
# Usage: scripts/prod/mirror-prebuilt.sh [channel-dir]
set -euo pipefail
dir="${1:-/srv/ahvclaw.com/releases/ahv-cli}"
repo="${AHV_GITHUB_REPO:-tranhieu860/AHVclaw}"
platforms="${AHV_MIRROR_PLATFORMS:-linux-arm64}"
tags="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(" ".join(sorted(set(v for v in d.values() if isinstance(v,str)))))' "$dir/channels.json" 2>/dev/null || true)"
for tag in $tags; do
  for platform in $platforms; do
    file="ahv-cli-$tag-$platform.tar.zst"
    [ -f "$dir/$file" ] && continue
    meta="$(curl -fsSL --max-time 30 "https://github.com/$repo/releases/download/$tag/$tag-$platform.json" 2>/dev/null || true)"
    [ -n "$meta" ] || continue
    sha="$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][sys.argv[1]]["sha256"])' "$platform" 2>/dev/null || true)"
    [ -n "$sha" ] || continue
    echo "mirror: fetching $file"
    curl -fsSL --max-time 900 "https://github.com/$repo/releases/download/$tag/$file" -o "$dir/$file.part" || { rm -f "$dir/$file.part"; continue; }
    if [ "$(sha256sum "$dir/$file.part" | cut -d' ' -f1)" != "$sha" ]; then
      echo "mirror: checksum mismatch for $file, discarding" >&2
      rm -f "$dir/$file.part"; continue
    fi
    mv -f "$dir/$file.part" "$dir/$file"; chmod 644 "$dir/$file"
    printf '%s' "$meta" | python3 - "$dir" "$tag" "$platform" <<'PY'
import json, os, sys
d, tag, platform = sys.argv[1:]
meta = json.load(sys.stdin)
path = os.path.join(d, tag + ".json")
manifest = json.load(open(path)) if os.path.exists(path) else {"version": tag, "packages": {}}
manifest["packages"][platform] = meta["packages"][platform]
tmp = path + ".tmp"; json.dump(manifest, open(tmp, "w"), indent=2); open(tmp, "a").write("\n"); os.replace(tmp, path)
channels = json.load(open(os.path.join(d, "channels.json")))
if channels.get("stable") == tag:
    json.dump(manifest, open(os.path.join(d, "manifest.json.tmp"), "w"), indent=2)
    os.replace(os.path.join(d, "manifest.json.tmp"), os.path.join(d, "manifest.json"))
print("mirror: merged", platform, "into", tag + ".json")
PY
  done
done
