#!/usr/bin/env bash
# `ahv web` may drop dsh 0.2's launch token only for a loopback bind.
#
# The fleet binds ahv-web to 127.0.0.1 behind the ahv-web-ui-auth login gate;
# there the token (printed to the journal, new each restart) locked every user
# out. Anywhere else the token is the only thing between the UI and the network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(sed -n '/^web_auth_mode()/,/^}/p' "$HERE/../ahv-wrapper.sh")"
pass=0; fail=0
expect() { local want="$1"; shift; local got; got="$(web_auth_mode "$@")"
  if [ "$got" = "$want" ]; then echo "  PASS  $* -> $want"; pass=$((pass+1)); else echo "  FAIL  $* -> $got (want $want)"; fail=$((fail+1)); fi; }
declare -f web_auth_mode >/dev/null || { echo "  FAIL  web_auth_mode missing"; exit 1; }
expect external
expect external --host 127.0.0.1 --port 3080 --no-open --trusted-host ahv.ahvclaw.com
expect external --host=localhost
expect external --host ::1
expect token --host 0.0.0.0 --port 3080
expect token --host=203.0.113.7
expect token --host 127.0.0.1 --host 0.0.0.0
expect external --trusted-host 0.0.0.0
echo; echo "  $pass passed, $fail failed"; [ "$fail" -eq 0 ]
