#!/usr/bin/env bash
# The installer must raise Node's heap ceiling before building on a small host.
#
# #8 (3.6 GB) aborted `pnpm run build` with "JavaScript heap out of memory"
# three nights running while 7.7 GB and 128 GB hosts built fine. The abort came
# *after* tsc emitted .d.ts files, so apps/cli/lib had types but no bin.js and
# `ahv --version` still answered — the break stayed invisible until doctor was
# readable again. These cases exercise the sizing function for real against a
# fake /proc/meminfo rather than grepping for the flag.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/../install.sh"
UPDATER="${AHV_UPDATER_SH:-$HOME/bot-src/extracted/telegram-cli-bot-setup-f227690/install-package-update-linux.sh}"
fails=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
meminfo() { # mb -> path
  printf 'MemTotal:       %d kB\nMemFree: 100 kB\n' "$(( $1 * 1024 ))" >"$tmp/meminfo.$1"
  printf '%s' "$tmp/meminfo.$1"
}

# Lift the sizing block out of the installer so we run the shipped code, not a
# copy of it. A `sed` range would run to end-of-file when the closing marker is
# gone, and sourcing *that* executes the real installer — during development
# this test cloned the repo and started a pnpm build before it was killed. So
# emit nothing unless both markers are seen, and refuse to source a block that
# carries installer commands.
extract_between() { # file, start-regex, end-regex
  awk -v s="$2" -v e="$3" '
    $0 ~ e { if (f) { printf "%s", buf; exit } }
    $0 ~ s { f = 1; buf = "" }
    f      { buf = buf $0 ORS }
  ' "$1"
}
refuse_if_dangerous() { # file, label
  if grep -qE '(^|[^[:alnum:]_])(git|pnpm|curl|npm|corepack|rm)[[:space:]]' "$1"; then
    fail "$2 extraction pulled in installer commands — refusing to source it"
    printf '\n%d FAILED\n' "$fails"; exit 1
  fi
}

extract_between "$INSTALL" '^AHV_BUILD_HEAP_FLOOR_MB=' '^apply_build_heap_limit$' >"$tmp/heap.sh"
if [ ! -s "$tmp/heap.sh" ]; then
  fail 'installer no longer carries the heap sizing block'
  printf '\n%d FAILED\n' "$fails"; exit 1
fi
refuse_if_dangerous "$tmp/heap.sh" 'installer'
pass 'installer carries the heap sizing block'

run_installer() { # ram_mb, preset_node_options -> echoes resulting NODE_OPTIONS
  local mi; mi="$(meminfo "$1")"
  env -i PATH="$PATH" HOME="$HOME" AHV_MEMINFO="$mi" NODE_OPTIONS="$2" \
    bash -c 'log() { :; }; set -euo pipefail; . "$1"; apply_build_heap_limit; printf "%s" "${NODE_OPTIONS:-}"' \
    bash "$tmp/heap.sh"
}

# 3654 MB is #8's real total: 70% is 2557, which cleared the OOM by hand.
got="$(run_installer 3654 '')"
case "$got" in
  *--max-old-space-size=2557*) pass "small host (3654MB) gets a raised heap: $got" ;;
  *) fail "small host (3654MB) got '$got'" ;;
esac

# A 7.7 GB host built fine on Node's own default — do not touch it.
got="$(run_installer 7680 '')"
if [ -z "$got" ]; then pass 'big host (7680MB) keeps Node default'
else fail "big host (7680MB) was given '$got'"; fi

got="$(run_installer 128258 '')"
if [ -z "$got" ]; then pass 'huge host (128GB) keeps Node default'
else fail "huge host (128GB) was given '$got'"; fi

# An operator who set a ceiling on purpose must win, with no second flag added.
got="$(run_installer 3654 '--max-old-space-size=1024')"
if [ "$got" = '--max-old-space-size=1024' ]; then pass 'explicit NODE_OPTIONS wins untouched'
else fail "explicit NODE_OPTIONS became '$got'"; fi

# Unrelated NODE_OPTIONS must be kept, not clobbered.
got="$(run_installer 3654 '--enable-source-maps')"
case "$got" in
  '--enable-source-maps --max-old-space-size=2557') pass 'unrelated NODE_OPTIONS preserved and extended' ;;
  *) fail "unrelated NODE_OPTIONS became '$got'" ;;
esac

# A tiny host still needs a workable floor rather than 70% of almost nothing.
got="$(run_installer 2048 '')"
case "$got" in
  *--max-old-space-size=2048*) pass "tiny host (2048MB) floors at 2048: $got" ;;
  *) fail "tiny host (2048MB) got '$got'" ;;
esac

# An unreadable or junk meminfo must not wedge the install.
got="$(env -i PATH="$PATH" HOME="$HOME" AHV_MEMINFO="$tmp/nope" NODE_OPTIONS="" \
  bash -c 'log() { :; }; set -euo pipefail; . "$1"; apply_build_heap_limit; printf "%s" "${NODE_OPTIONS:-}"' \
  bash "$tmp/heap.sh" 2>/dev/null)"
rc=$?
if [ "$rc" -eq 0 ]; then pass "missing meminfo is survivable (NODE_OPTIONS='$got')"
else fail "missing meminfo exited $rc"; fi

printf 'garbage\n' >"$tmp/junk"
got="$(env -i PATH="$PATH" HOME="$HOME" AHV_MEMINFO="$tmp/junk" NODE_OPTIONS="" \
  bash -c 'log() { :; }; set -euo pipefail; . "$1"; apply_build_heap_limit; printf "%s" "${NODE_OPTIONS:-}"' \
  bash "$tmp/heap.sh" 2>/dev/null)"
rc=$?
if [ "$rc" -eq 0 ] && [ -z "$got" ]; then pass 'junk meminfo is survivable and adds no flag'
else fail "junk meminfo exited $rc with '$got'"; fi

# The sizing must run before the build, not after it.
heap_line="$(grep -n '^apply_build_heap_limit$' "$INSTALL" | head -1 | cut -d: -f1)"
build_line="$(grep -n 'pnpm run build' "$INSTALL" | grep -v ':[[:space:]]*#' | head -1 | cut -d: -f1)"
if [ -n "$heap_line" ] && [ -n "$build_line" ] && [ "$heap_line" -lt "$build_line" ]; then
  pass "sizing runs before the build (line $heap_line < $build_line)"
else
  fail "sizing does not precede the build (heap=$heap_line build=$build_line)"
fi

# ── updater fallback: a host whose CLI clone predates the installer fix still
# reaches install.sh through the updater, so the ceiling is set there too.
if [ ! -f "$UPDATER" ]; then
  printf '  SKIP  updater not present at %s\n' "$UPDATER"
else
  extract_between "$UPDATER" '^AHV_CLI_BUILD_HEAP_FLOOR_MB=' '^}$' >"$tmp/uheap.sh"
  printf '}\n' >>"$tmp/uheap.sh"
  if [ "$(wc -c <"$tmp/uheap.sh")" -le 2 ]; then
    fail 'updater no longer carries the heap sizing helper'
  else
    refuse_if_dangerous "$tmp/uheap.sh" 'updater'
    pass 'updater carries the heap sizing helper'
    u_run() {
      local mi; mi="$(meminfo "$1")"
      env -i PATH="$PATH" HOME="$HOME" AHV_CLI_MEMINFO="$mi" \
        bash -c 'set -uo pipefail; . "$1"; ahv_cli_build_node_options' bash "$tmp/uheap.sh"
    }
    got="$(u_run 3654)"
    if [ "$got" = '--max-old-space-size=2557' ]; then pass "updater sizes a small host: $got"
    else fail "updater small host gave '$got'"; fi
    got="$(u_run 7680)"
    if [ -z "$got" ]; then pass 'updater leaves a big host alone'
    else fail "updater big host gave '$got'"; fi
    if grep -q 'NODE_OPTIONS="\$4"' "$UPDATER"; then
      pass 'updater passes the ceiling into the install script'
    else
      fail 'updater computes a ceiling but never passes it to install.sh'
    fi
  fi
fi

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; else printf '%d FAILED\n' "$fails"; exit 1; fi
