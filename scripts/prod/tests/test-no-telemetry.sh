#!/usr/bin/env bash
# Nothing may leave an AHV machine for DeepSeek.
#
# dsh 0.2 turned session telemetry on by default (FEEDBACK_ONLY): one thumbs
# up/down in the web uploaded the session-log prefix to DeepSeek's collector.
# Composes the real profiles the AHV CLI runs (web; headless + bot) and checks
# the rows are disabled, and that the wrapper exports the process-wide opt-out.
# Usage: test-no-telemetry.sh [tree] [--strict]   (--strict: an uninstalled tree fails)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; STRICT=0
for a in "$@"; do case "$a" in --strict) STRICT=1 ;; *) ROOT="$a" ;; esac; done
fail=0
if [ ! -d "$ROOT/node_modules" ]; then
  echo "  $([ $STRICT = 1 ] && echo FAIL || echo SKIP)  tree not installed ($ROOT)"; exit $STRICT
fi
grep -q '^export DSH_TELEMETRY_DISABLED=1$' "$ROOT/scripts/prod/ahv-wrapper.sh" \
  && echo "  PASS  wrapper exports DSH_TELEMETRY_DISABLED" || { echo "  FAIL  wrapper does not export DSH_TELEMETRY_DISABLED"; fail=1; }
home="$(mktemp -d)"; trap 'rm -rf "$home"' EXIT
check_profile() { # label, rows..., -- dsh args
  local label="$1"; shift; local rows=(); while [ "$1" != "--" ]; do rows+=("$1"); shift; done; shift
  local dump; dump="$(cd "$ROOT" && env -u DSH_TELEMETRY_DISABLED HOME="$home" DSH_HOME="$home/.dsh" timeout 120 node --import tsx/esm apps/cli/src/bin.ts "$@" --dump-config 2>/dev/null)" \
    || { echo "  FAIL  $label: dump-config failed"; fail=1; return; }
  for row in "${rows[@]}"; do
    state="$(printf '%s\n' "$dump" | python3 -c '
import re,sys
s=sys.stdin.read(); m=re.search(r"- id: "+re.escape(sys.argv[1])+r"\n((?:  .*\n)*)", s)
print("absent" if not m else ("disabled" if "disabled: true" in m.group(1) else "ENABLED"))' "$row")"
    if [ "$state" = disabled ]; then echo "  PASS  $label: $row disabled"; else echo "  FAIL  $label: $row is $state (renamed upstream? re-check what now sends data out)"; fail=1; fi
  done
}
check_profile web session-telemetry-otel otel session-log-deepseek deepseek-account ui-settings-account account-controller -- \
  --profile web --patch packages/bundle/ahv/cordis.patch.web.yml
check_profile bot session-telemetry-otel otel session-log-deepseek deepseek-account -- \
  --profile headless --patch packages/bundle/ahv/cordis.patch.yml --patch packages/bundle/ahv/cordis.patch.bot.yml
exit $fail
