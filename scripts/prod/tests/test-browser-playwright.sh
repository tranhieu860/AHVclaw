#!/usr/bin/env bash
# @anweat/dsh-browser must find the Chromium AHV hosts already have.
#
# The plugin loads the playwright pnpm hoists into node_modules/.pnpm/node_modules,
# not its own dependency. After the dsh 0.2 merge that hoisted copy was 1.61
# (Chromium 1228) while hosts hold Chromium 1234 (playwright 1.62), so every
# browser_open said "chromium is not installed". Checks an installed tree.
# Usage: test-browser-playwright.sh [tree] [--strict]   (--strict: an uninstalled tree fails)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; STRICT=0
for a in "$@"; do case "$a" in --strict) STRICT=1 ;; *) ROOT="$a" ;; esac; done
hoisted="$ROOT/node_modules/.pnpm/node_modules/playwright/package.json"
plugin="$(readlink -f "$ROOT/packages/bundle/ahv/node_modules/@anweat/dsh-browser" 2>/dev/null)"
[ -f "$hoisted" ] && [ -n "$plugin" ] || { echo "  $([ $STRICT = 1 ] && echo FAIL || echo SKIP)  tree not installed ($ROOT)"; exit $STRICT; }
hv="$(node -p "require('$hoisted').version")"
pv="$(node -p "require('$plugin/../../playwright/package.json').version" 2>/dev/null || echo none)"
want="$(sed -n "s/^  'playwright': '\(.*\)'$/\1/p" "$ROOT/pnpm-workspace.yaml")"
fail=0
[ -n "$want" ] && echo "  PASS  pnpm-workspace pins playwright $want" || { echo "  FAIL  no playwright override in pnpm-workspace.yaml"; fail=1; }
[ "$hv" = "$want" ] && echo "  PASS  hoisted playwright is $hv" || { echo "  FAIL  hoisted playwright $hv, want $want"; fail=1; }
[ "$pv" = "$want" ] && echo "  PASS  dsh-browser's own playwright is $pv" || { echo "  FAIL  dsh-browser playwright $pv, want $want"; fail=1; }
exit $fail
