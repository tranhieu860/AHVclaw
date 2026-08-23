#!/usr/bin/env bash
# The profile's module farm must reach this install's plugins.
#
# dsh builds `~/.dsh/profiles/node_modules` from `apps/cli/node_modules`, which
# does not carry the AHV bundle or the plugins the bundle depends on. On this
# machine the farm happened to be a symlink into another user's home, so the bot
# silently ran that user's older plugin code — an installed upgrade had no
# effect at all, and the only visible symptom was that a fix "did not work".
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/../ahv-wrapper.sh"
pass=0; fail=0
check() { if [ "$2" = pass ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1${3:+ -- $3}"; fail=$((fail+1)); fi; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
FORK="$SANDBOX/src"
mkdir -p "$FORK/packages/bundle/ahv/node_modules/@anweat/dsh-browser" \
         "$FORK/packages/bundle/ahv/node_modules/dshmarket" \
         "$SANDBOX/dsh/profiles/node_modules"
FARM="$SANDBOX/dsh/profiles/node_modules"

# Load just the function under test.
eval "$(sed -n '/^ensure_profile_plugins()/,/^}/p' "$WRAPPER")"

if ! declare -f ensure_profile_plugins >/dev/null; then
  echo "  FAIL  ensure_profile_plugins is not defined in the wrapper"; exit 1
fi

DSH_HOME="$SANDBOX/dsh" ensure_profile_plugins "$FORK"
[ -L "$FARM/@ahvclaw/dsh-bundle-ahv" ] && check "the bundle is linked into the farm" pass || check "the bundle is linked into the farm" fail
[ "$(readlink -f "$FARM/@ahvclaw/dsh-bundle-ahv")" = "$(readlink -f "$FORK/packages/bundle/ahv")" ] &&
  check "it points at this install, not elsewhere" pass || check "it points at this install" fail "$(readlink -f "$FARM/@ahvclaw/dsh-bundle-ahv")"
[ -e "$FARM/dshmarket" ] && check "a plain dependency is linked" pass || check "a plain dependency is linked" fail
[ -e "$FARM/@anweat/dsh-browser" ] && check "a scoped dependency is linked" pass || check "a scoped dependency is linked" fail

# Idempotent: a second call must not fail or duplicate.
DSH_HOME="$SANDBOX/dsh" ensure_profile_plugins "$FORK" &&
  check "running it again is harmless" pass || check "running it again is harmless" fail

# A farm that does not exist yet is left alone: dsh scaffolds it on first run,
# and pre-creating an empty one made the whole plugin tree fail to load.
rm -rf "$SANDBOX/dsh/profiles"
DSH_HOME="$SANDBOX/dsh" ensure_profile_plugins "$FORK"
[ ! -d "$SANDBOX/dsh/profiles/node_modules" ] &&
  check "an absent farm is not created" pass || check "an absent farm is not created" fail

# A dependency this install does not have must not produce a broken link.
rm -rf "$FORK/packages/bundle/ahv/node_modules/dshmarket"
mkdir -p "$FARM"
DSH_HOME="$SANDBOX/dsh" ensure_profile_plugins "$FORK"
[ ! -e "$FARM/dshmarket" ] && check "a missing dependency is skipped, not dangling" pass ||
  check "a missing dependency is skipped" fail

echo ""; echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
