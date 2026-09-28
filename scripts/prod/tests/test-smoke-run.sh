#!/usr/bin/env bash
# The release smoke must fail a build whose `ahv run` cannot answer.
#
# v0.2.50 passed `--version` and `doctor`, then every real run died at plugin
# load; the CMS promoted it anyway. These fakes stand in for the broken and the
# good CLI so the verdict is proven both ways.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SMOKE="$HERE/../smoke-run.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
fake() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$T/$1"; chmod +x "$T/$1"; }
expect() { # name, want(0|1), bin, [timeout]
  local out rc; out="$(bash "$SMOKE" "$T/$3" "${4:-20}")"; rc=$?
  if [ "$rc" = "$2" ]; then echo "  PASS  $1 ($out)"; pass=$((pass+1)); else echo "  FAIL  $1 rc=$rc $out"; fail=$((fail+1)); fi
}
fake good 'for a; do :; done; echo "{\"type\":\"session_meta\",\"session_id\":\"s\"}"; echo "{\"type\":\"assistant_final\",\"text\":\"PONG\"}"; echo "{\"type\":\"turn_end\",\"reason\":\"completed\"}"'
fake v0250 'echo "TypeError: z.boolean(...).default(...).volatile is not a function" >&2; exit 1'
fake errorevent 'echo "{\"type\":\"error\",\"code\":\"internal_error\",\"message\":\"dsh spawn failed\"}"; exit 1'
fake hang 'sleep 30'
fake noanswer 'echo "{\"type\":\"turn_end\",\"reason\":\"completed\"}"'
fake wrong 'echo "{\"type\":\"assistant_final\",\"text\":\"xin chao\"}"; echo "{\"type\":\"turn_end\",\"reason\":\"completed\"}"'
fake flags 'case "$*" in *"--prompt-file "*"--cwd "*"--output jsonl --no-color --no-banner"*) echo "{\"type\":\"assistant_final\",\"text\":\"PONG\"}"; echo "{\"type\":\"turn_end\",\"reason\":\"completed\"}";; *) exit 3;; esac'
expect 'a CLI that answers PONG passes' 0 good
expect 'the v0.2.50 crash fails' 1 v0250
expect 'a JSONL error event fails' 1 errorevent
expect 'a run that never ends fails at the timeout' 1 hang 3
expect 'no answer fails' 1 noanswer
expect 'a wrong answer fails' 1 wrong
expect 'it calls run with the bot flags' 0 flags
echo; echo "  $pass passed, $fail failed"; [ "$fail" -eq 0 ]
