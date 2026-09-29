#!/usr/bin/env bash
# Promote a released AHV CLI tag to the stable channel: every host on stable
# picks it up at its next update run. The tag must already have a manifest in
# the channel directory (i.e. release-cli.sh built and packaged it).
#
# Usage: scripts/prod/promote.sh <tag> [channel-dir]
set -euo pipefail
tag="${1:?tag}"
dir="${2:-/srv/ahvclaw.com/releases/ahv-cli}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "tag must be vN.N.N (ASCII digits): $tag" >&2; exit 1; }
[ -f "$dir/$tag.json" ] || { echo "no manifest for $tag in $dir — release it first" >&2; exit 1; }
# The store-safe floor ("sàn an toàn kho"): v0.2.49 and v0.2.53–v0.2.55 drop an
# account from the store when refreshing its token fails. Promoting an older
# tag is a rollback of stable, so it must not go under the floor either. The
# floor is channels.json's "store_floor", which the CMS writes (Cài đặt — the
# only place it is lowered, with a typed confirmation); unset or unreadable,
# this default. There is no override here.
STORE_FLOOR_DEFAULT="v0.2.56"
python3 - "$dir" "$tag" "$STORE_FLOOR_DEFAULT" <<'PY'
import json, os, re, shutil, sys
d, tag, floor_default = sys.argv[1:]
manifest = json.load(open(os.path.join(d, tag + ".json"), encoding="utf-8"))
assert manifest.get("version") == tag, manifest.get("version")
path = os.path.join(d, "channels.json")
try:
    channels = json.load(open(path, encoding="utf-8"))
except Exception:
    channels = {}
channels = channels if isinstance(channels, dict) else {}
key = lambda t: tuple(int(p) for p in t[1:].split(".")) if isinstance(t, str) and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", t) else None
floor = channels.get("store_floor") if key(channels.get("store_floor")) else floor_default
if key(tag) < key(floor):
    sys.exit(f"refusing {tag}: under the store-safe floor {floor} (tags under it drop accounts from the store); "
             "lower the floor in the CMS (Cài đặt) first if this is really needed")
channels["stable"] = tag
channels.setdefault("canary", tag)
tmp = path + ".tmp"
json.dump(channels, open(tmp, "w", encoding="utf-8"), indent=2); open(tmp, "a").write("\n")
os.chmod(tmp, 0o644)
# promote.sh is also run by the rollout controller as root. Left root-owned,
# these files break the release script's `chmod 644` sweep, which runs as the
# unprivileged release user -- one EPERM aborts the whole release.
def keep_owner(target):
    try:
        owner = os.stat(d)
        os.chown(target, owner.st_uid, owner.st_gid)
    except OSError:
        pass
keep_owner(tmp)
os.replace(tmp, path)
manifest_path = os.path.join(d, "manifest.json")
# Copy then rename: a host fetching manifest.json mid-copy must never read half a file.
staged = manifest_path + ".promote.%d" % os.getpid()  # never the name mirror-prebuilt.sh stages under
shutil.copyfile(os.path.join(d, tag + ".json"), staged)
os.chmod(staged, 0o644)
keep_owner(staged)
os.replace(staged, manifest_path)
print("stable →", tag, "| channels:", json.dumps(channels))
PY
