#!/usr/bin/env bash
# mirror-prebuilt.sh must bring the GitHub-built archives into the channel.
#
# Two ways it failed on 29/09: (1) the metadata was piped into a `python3 -`
# whose stdin was already the heredoc, so every merge died on empty JSON — the
# arm64 archives sat downloaded in the channel for days and no manifest ever
# named them; (2) the reference machine (glibc 2.39) is the only x64 build the
# channel had, so ten hosts on glibc 2.28–2.35 built v0.2.53 from source and
# broke. The CI x64 archive is built on glibc 2.28 and must replace an x64
# entry that needs a newer glibc — and only then.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MIRROR="$HERE/../mirror-prebuilt.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
ko() { echo "  FAIL  $1"; fail=$((fail+1)); }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

# A fake curl that serves https://github.com/<repo>/releases/download/<tag>/<file>
# from $T/gh/<tag>/<file>, logs every archive it hands out, and ignores options.
mkdir -p "$T/bin"
cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --max-time|--connect-timeout) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
rel="${url#*/releases/download/}"
src="$FAKE_GH/$rel"
[ -f "$src" ] || exit 22
case "$src" in *.tar.zst) echo "$rel" >> "$FAKE_GH/fetched.log" ;; esac
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
EOF
chmod +x "$T/bin/curl"

setup() { # fresh channel + fake GitHub
  rm -rf "$T/ch" "$T/gh"; mkdir -p "$T/ch" "$T/gh/v1.0.1"
  export FAKE_GH="$T/gh"
}
gh_asset() { # tag platform glibc content
  local tag="$1" platform="$2" glibc="$3" content="$4" file sha size
  file="ahv-cli-$tag-$platform.tar.zst"
  printf '%s' "$content" > "$T/gh/$tag/$file"
  sha="$(sha256sum "$T/gh/$tag/$file" | cut -d' ' -f1)"; size="$(stat -c %s "$T/gh/$tag/$file")"
  printf '{"version":"%s","packages":{"%s":{"file":"%s","sha256":"%s","size":%s,"glibc":"%s","node":"v22"}}}\n' \
    "$tag" "$platform" "$file" "$sha" "$size" "$glibc" > "$T/gh/$tag/$tag-$platform.json"
}
local_x64() { # tag glibc content  — what release-cli.sh on the reference machine wrote
  local tag="$1" glibc="$2" content="$3" file sha
  file="ahv-cli-$tag-linux-x64.tar.zst"
  printf '%s' "$content" > "$T/ch/$file"
  sha="$(sha256sum "$T/ch/$file" | cut -d' ' -f1)"
  printf '{"version":"%s","packages":{"linux-x64":{"file":"%s","sha256":"%s","size":%s,"glibc":"%s","node":"v22"}}}\n' \
    "$tag" "$file" "$sha" "${#content}" "$glibc" > "$T/ch/$tag.json"
}
run_mirror() { PATH="$T/bin:$PATH" AHV_MIRROR_PLATFORMS="linux-x64 linux-arm64" bash "$MIRROR" "$T/ch" > "$T/out.log" 2>&1; }
entry() { # tag platform key  — from the channel's <tag>.json
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["packages"].get(sys.argv[2],{}).get(sys.argv[3],""))' "$T/ch/$1.json" "$2" "$3" 2>/dev/null
}
fetched() { cat "$T/gh/fetched.log" 2>/dev/null | grep -c "$1"; }

echo "== arm64 is merged into the tag manifest (the stdin bug)"
setup
printf '{"stable":"v1.0.0","canary":"v1.0.1"}\n' > "$T/ch/channels.json"
local_x64 v1.0.1 2.28 "x64-local"
gh_asset v1.0.1 linux-arm64 2.39 "arm-bytes"
run_mirror; rc=$?
check "mirror exits 0" '[ "$rc" = 0 ]'
check "arm64 entry lands in v1.0.1.json" '[ "$(entry v1.0.1 linux-arm64 glibc)" = "2.39" ]'
check "arm64 file named by the entry exists" 'f="$(entry v1.0.1 linux-arm64 file)"; [ -n "$f" ] && [ "$(cat "$T/ch/$f")" = "arm-bytes" ]'
check "x64 entry built on 2.28 is kept as is" '[ "$(entry v1.0.1 linux-x64 file)" = "ahv-cli-v1.0.1-linux-x64.tar.zst" ]'
check "no x64 fetch when the local x64 already needs no newer glibc" '[ "$(fetched linux-x64)" = 0 ]'
check "no mirror line crashes" '! grep -q Traceback "$T/out.log"'

echo "== store_floor in channels.json is not a tag to mirror"
setup
printf '{"stable":"v1.0.1","canary":"v1.0.1","store_floor":"v1.0.0"}\n' > "$T/ch/channels.json"
local_x64 v1.0.1 2.28 "x64-local"
gh_asset v1.0.0 linux-arm64 2.39 "old-arm-bytes"
gh_asset v1.0.1 linux-arm64 2.39 "arm-bytes"
run_mirror; rc=$?
check "mirror exits 0 with store_floor present" '[ "$rc" = 0 ]'
check "the floor tag is not fetched" '[ "$(fetched v1.0.0)" = 0 ] && [ ! -e "$T/ch/v1.0.0.json" ]'
check "the channel tag still is" '[ "$(entry v1.0.1 linux-arm64 glibc)" = "2.39" ]'

echo "== an archive already downloaded but never merged is merged without a refetch"
setup
printf '{"stable":"v1.0.0","canary":"v1.0.1"}\n' > "$T/ch/channels.json"
local_x64 v1.0.1 2.28 "x64-local"
gh_asset v1.0.1 linux-arm64 2.39 "arm-bytes"
cp "$T/gh/v1.0.1/ahv-cli-v1.0.1-linux-arm64.tar.zst" "$T/ch/"
run_mirror
check "arm64 entry lands" '[ "$(entry v1.0.1 linux-arm64 glibc)" = "2.39" ]'
check "arm64 archive not fetched again" '[ "$(fetched linux-arm64)" = 0 ]'

echo "== the CI x64 (glibc 2.28) replaces the reference build (glibc 2.39)"
setup
printf '{"stable":"v1.0.1","canary":"v1.0.1"}\n' > "$T/ch/channels.json"
local_x64 v1.0.1 2.39 "x64-reference"
cp "$T/ch/v1.0.1.json" "$T/ch/manifest.json"
gh_asset v1.0.1 linux-x64 2.28 "x64-ci"
run_mirror
check "x64 entry now says glibc 2.28" '[ "$(entry v1.0.1 linux-x64 glibc)" = "2.28" ]'
check "x64 entry points at a file holding the CI bytes" 'f="$(entry v1.0.1 linux-x64 file)"; [ "$(cat "$T/ch/$f" 2>/dev/null)" = "x64-ci" ]'
check "the CI archive gets its own name (hosts mid-download keep theirs)" '[ "$(entry v1.0.1 linux-x64 file)" != "ahv-cli-v1.0.1-linux-x64.tar.zst" ] && [ "$(cat "$T/ch/ahv-cli-v1.0.1-linux-x64.tar.zst")" = "x64-reference" ]'
check "sha in the entry matches the file" 'f="$(entry v1.0.1 linux-x64 file)"; [ "$(entry v1.0.1 linux-x64 sha256)" = "$(sha256sum "$T/ch/$f" | cut -d" " -f1)" ]'
check "manifest.json (stable) follows" '[ "$(python3 -c "import json;print(json.load(open(\"$T/ch/manifest.json\"))[\"packages\"][\"linux-x64\"][\"glibc\"])")" = "2.28" ]'
check "files are world-readable" '[ "$(stat -c %a "$T/ch/v1.0.1.json")" = 644 ] && [ "$(stat -c %a "$T/ch/$(entry v1.0.1 linux-x64 file)")" = 644 ]'
run_mirror
check "second run fetches nothing new" '[ "$(fetched linux-x64)" = 1 ]'

echo "== a CI x64 that needs a newer glibc than the channel's never replaces it"
setup
printf '{"stable":"v1.0.0","canary":"v1.0.1"}\n' > "$T/ch/channels.json"
local_x64 v1.0.1 2.28 "x64-local"
gh_asset v1.0.1 linux-x64 2.39 "x64-ci-new"
run_mirror
check "x64 entry unchanged" '[ "$(entry v1.0.1 linux-x64 file)" = "ahv-cli-v1.0.1-linux-x64.tar.zst" ] && [ "$(entry v1.0.1 linux-x64 glibc)" = "2.28" ]'
check "the archive was not even downloaded" '[ "$(fetched linux-x64)" = 0 ]'

echo "== a checksum mismatch is discarded"
setup
printf '{"stable":"v1.0.0","canary":"v1.0.1"}\n' > "$T/ch/channels.json"
local_x64 v1.0.1 2.39 "x64-reference"
gh_asset v1.0.1 linux-x64 2.28 "x64-ci"
printf 'tampered' > "$T/gh/v1.0.1/ahv-cli-v1.0.1-linux-x64.tar.zst"
run_mirror
check "x64 entry still the reference build" '[ "$(entry v1.0.1 linux-x64 glibc)" = "2.39" ]'
check "no partial or tampered file left" '! ls "$T/ch" | grep -q -E "\.part$|glibc2\.28"'
check "mismatch is logged" 'grep -q "checksum mismatch" "$T/out.log"'

echo "== metadata naming another file, or with a junk sha/glibc, is refused"
for field in 'file="../../../tmp/evil.tar.zst"' 'file="channels.json"' 'file="ahv-cli-v1.0.0-linux-x64.tar.zst"' 'sha256="../x"' 'glibc="2.28; rm"'; do
  setup
  printf '{"stable":"v1.0.0","canary":"v1.0.1"}\n' > "$T/ch/channels.json"
  local_x64 v1.0.1 2.39 "x64-reference"
  gh_asset v1.0.1 linux-x64 2.28 "x64-ci"
  python3 - "$T/gh/v1.0.1/v1.0.1-linux-x64.json" "$field" <<'PY'
import json, sys
path, assign = sys.argv[1:]
key, value = assign.split("=", 1)
d = json.load(open(path)); d["packages"]["linux-x64"][key] = json.loads(value); json.dump(d, open(path, "w"))
PY
  run_mirror
  check "refused: $field" '[ "$(entry v1.0.1 linux-x64 glibc)" = 2.39 ] && [ ! -e "$T/tmp/evil.tar.zst" ] && [ "$(fetched linux-x64)" = 0 ] && [ "$(python3 -c "import json;print(json.load(open(\"$T/ch/channels.json\"))[\"canary\"])")" = v1.0.1 ]'
done

echo "== the asset name is checked, not just its path (the fake GitHub serves the file, sha matching)"
setup
printf '{"stable":"v1.0.0","canary":"v1.0.1"}\n' > "$T/ch/channels.json"
cp "$T/ch/channels.json" "$T/channels.orig"
local_x64 v1.0.1 2.39 "x64-reference"
printf '{"stable":"v6.6.6"}' > "$T/gh/v1.0.1/channels.json"
sha="$(sha256sum "$T/gh/v1.0.1/channels.json" | cut -d' ' -f1)"
printf '{"version":"v1.0.1","packages":{"linux-x64":{"file":"channels.json","sha256":"%s","size":1,"glibc":"2.28"}}}\n' "$sha" > "$T/gh/v1.0.1/v1.0.1-linux-x64.json"
PATH="$T/bin:$PATH" AHV_MIRROR_PLATFORMS="linux-x64" bash "$MIRROR" "$T/ch" > "$T/out.log" 2>&1
check "channels.json not overwritten by a served asset" 'cmp -s "$T/ch/channels.json" "$T/channels.orig"'
check "entry unchanged" '[ "$(entry v1.0.1 linux-x64 glibc)" = 2.39 ]'

echo "== tags outside channels.json are ignored"
setup
printf '{"stable":"v1.0.0","canary":"v1.0.0"}\n' > "$T/ch/channels.json"
gh_asset v1.0.1 linux-arm64 2.39 "arm-bytes"
run_mirror
check "nothing fetched for v1.0.1" '[ ! -f "$T/gh/fetched.log" ]'

echo; echo "  $pass passed, $fail failed"; [ "$fail" -eq 0 ]
