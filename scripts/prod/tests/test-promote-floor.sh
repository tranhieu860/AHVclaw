#!/usr/bin/env bash
# promote.sh never moves stable under the store-safe floor ("sàn an toàn kho").
#
# 30/09: v0.2.49 and v0.2.53–v0.2.55 drop an account from the store when
# refreshing its token fails; v0.2.56 is the first that keeps them all.
# Promoting an older tag is a rollback of stable, so promote.sh refuses a tag
# under channels.json's "store_floor" (the CMS writes it), or under v0.2.56
# when that is unset or unreadable. Runs on temp channel dirs only.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROMOTE="$HERE/../promote.sh"
fails=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

setup() { # dir, channels-json
  rm -rf "$1"; mkdir -p "$1"
  for t in v0.2.49 v0.2.54 v0.2.55 v0.2.56 v0.2.57; do
    printf '{"version": "%s", "packages": {}}\n' "$t" > "$1/$t.json"
  done
  [ -n "$2" ] && printf '%s\n' "$2" > "$1/channels.json"
  return 0
}
stable() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("stable"))' "$1/channels.json" 2>/dev/null; }
expect() { # name, want-rc(0|1), dir, tag, want-stable
  local out rc
  out="$(bash "$PROMOTE" "$4" "$3" 2>&1)"; rc=$?
  if { [ "$2" = 0 ] && [ "$rc" = 0 ]; } || { [ "$2" = 1 ] && [ "$rc" != 0 ]; }; then
    if [ "$(stable "$3")" = "$5" ]; then printf '  PASS  %s\n' "$1"; return; fi
  fi
  printf '  FAIL  %s (rc=%s stable=%s) %s\n' "$1" "$rc" "$(stable "$3")" "$out"; fails=$((fails + 1))
}

d="$tmp/a"
setup "$d" '{"stable": "v0.2.56", "canary": "v0.2.56", "store_floor": "v0.2.56"}'
for t in v0.2.49 v0.2.54 v0.2.55; do expect "refuses $t under the published floor" 1 "$d" "$t" v0.2.56; done
expect "promotes the floor tag itself" 0 "$d" v0.2.56 v0.2.56
expect "promotes above the floor" 0 "$d" v0.2.57 v0.2.57
if grep -q '"store_floor": "v0.2.56"' "$d/channels.json"; then printf '  PASS  keeps store_floor in channels.json\n'; else printf '  FAIL  store_floor lost\n'; fails=$((fails + 1)); fi
out="$(bash "$PROMOTE" v0.2.49 "$d" 2>&1)"
if printf '%s' "$out" | grep -q 'under the store-safe floor v0.2.56' && ! grep -q v0.2.49 "$d/manifest.json" 2>/dev/null; then
  printf '  PASS  says why, and manifest.json is untouched\n'
else printf '  FAIL  reason/manifest: %s\n' "$out"; fails=$((fails + 1)); fi

d="$tmp/b"
setup "$d" '{"stable": "v0.2.56", "canary": "v0.2.56"}'
expect "no store_floor: default v0.2.56 applies" 1 "$d" v0.2.49 v0.2.56
setup "$d" '{"stable": "v0.2.56", "store_floor": "v0.2.4５"}'
expect "junk store_floor: default applies, never no floor" 1 "$d" v0.2.55 v0.2.56
setup "$d" 'not json'
expect "unreadable channels.json: default applies" 1 "$d" v0.2.49 ""
setup "$d" '{"stable": "v0.2.56", "store_floor": "v0.2.49"}'
expect "a floor lowered in the CMS lets promote.sh go down" 0 "$d" v0.2.49 v0.2.49
setup "$d" '{"stable": "v0.2.56", "store_floor": "v0.2.57"}'
expect "a higher published floor wins" 1 "$d" v0.2.56 v0.2.56
setup "$d" '{"stable": "v0.2.56"}'
printf '{"version": "v0.2.4５", "packages": {}}\n' > "$d/v0.2.4５.json"
expect "a non-ASCII tag is refused" 1 "$d" "v0.2.4５" v0.2.56

# release-cli.sh writes canary with the same rule: run its channels.json step as is.
step="$tmp/canary-step.py"
sed -n '/^python3 - "$RELEASE_DIR\/channels.json" "$next" <<.PY./,/^PY$/p' "$HERE/../release-cli.sh" | sed '1d;$d' > "$step"
canary() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("canary"))' "$1"; }
printf '{"stable": "v0.2.56", "canary": "v0.2.56", "store_floor": "v0.2.57"}\n' > "$tmp/c.json"
if [ -s "$step" ] && ! python3 "$step" "$tmp/c.json" v0.2.56 >/dev/null 2>&1 && [ "$(canary "$tmp/c.json")" = v0.2.56 ] \
  && python3 "$step" "$tmp/c.json" v0.2.58 >/dev/null 2>&1 && [ "$(canary "$tmp/c.json")" = v0.2.58 ] \
  && grep -q '"store_floor": "v0.2.57"' "$tmp/c.json"; then
  printf '  PASS  release-cli.sh refuses a canary under the floor and keeps store_floor\n'
else printf '  FAIL  release-cli.sh canary step (%s lines)\n' "$(wc -l < "$step")"; fails=$((fails + 1)); fi

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
