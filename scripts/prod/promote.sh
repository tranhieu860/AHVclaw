#!/usr/bin/env bash
# Promote a released AHV CLI tag to the stable channel: every host on stable
# picks it up at its next update run. The tag must already have a manifest in
# the channel directory (i.e. release-cli.sh built and packaged it).
#
# Usage: scripts/prod/promote.sh <tag> [channel-dir]
set -euo pipefail
tag="${1:?tag}"
dir="${2:-/srv/ahvclaw.com/releases/ahv-cli}"
[ -f "$dir/$tag.json" ] || { echo "no manifest for $tag in $dir — release it first" >&2; exit 1; }
python3 - "$dir" "$tag" <<'PY'
import json, os, shutil, sys
d, tag = sys.argv[1:]
manifest = json.load(open(os.path.join(d, tag + ".json"), encoding="utf-8"))
assert manifest.get("version") == tag, manifest.get("version")
path = os.path.join(d, "channels.json")
try:
    channels = json.load(open(path, encoding="utf-8"))
except Exception:
    channels = {}
channels["stable"] = tag
channels.setdefault("canary", tag)
tmp = path + ".tmp"
json.dump(channels, open(tmp, "w", encoding="utf-8"), indent=2); open(tmp, "a").write("\n")
os.replace(tmp, path)
shutil.copyfile(os.path.join(d, tag + ".json"), os.path.join(d, "manifest.json"))
print("stable →", tag, "| channels:", json.dumps(channels))
PY
