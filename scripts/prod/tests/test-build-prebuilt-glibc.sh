#!/usr/bin/env bash
# The manifest's glibc must be what the archive needs, not what the builder had.
#
# build-prebuilt.sh used to write `getconf GNU_LIBC_VERSION` of the build host.
# Built on glibc 2.28, a tree can still carry a native module that links
# GLIBC_2.34 (node-pty 1.1.0 compiled on the reference machine did), and the
# promote gate would then send it to a 2.28 host. The packager now scans the
# tree's ELF files for the current architecture and records the highest
# GLIBC_x.y any of them needs; optional npm prebuilds known to need more
# (listed in prebuilt-glibc-optional.txt) are recorded separately.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/../build-prebuilt.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if eval "$2"; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
command -v zstd >/dev/null || { echo "  SKIP  zstd missing"; exit 0; }
case "$(uname -m)" in x86_64) MACHINE=62; OTHER=3 ;; aarch64|arm64) MACHINE=183; OTHER=62 ;; *) echo "  SKIP  arch"; exit 0 ;; esac

# A minimal ELF-looking file: magic, 64-bit little endian, e_machine at offset 18,
# then the version-need strings the dynamic linker would check.
elf() { # path machine versions...
  local path="$1" machine="$2"; shift 2
  mkdir -p "$(dirname "$path")"
  python3 - "$path" "$machine" "$@" <<'PY'
import struct, sys
path, machine, *versions = sys.argv[1:]
head = b"\x7fELF" + bytes([2, 1, 1]) + bytes(9) + struct.pack("<HH", 3, int(machine))
body = b"\0".join(("GLIBC_" + v).encode() for v in versions) + b"\0GLIBCXX_3.4.30\0"
open(path, "wb").write(head + bytes(64) + body)
PY
}
tree() { # fresh tree at $T/b/src
  rm -rf "$T/b" "$T/out"; mkdir -p "$T/b/src/scripts/prod" "$T/b/src/node_modules/x" "$T/out"
  printf 'v9.9.9\nabc\n' > "$T/b/src/AHV_VERSION"; printf '#!/bin/bash\n' > "$T/b/src/scripts/prod/ahv-wrapper.sh"
}
build() { AHV_BUILD_GLIBC="${1:-2.28}" bash "$BUILD" v9.9.9 "$T/out" "$T/b/src" > "$T/log" 2>&1; }
field() { python3 -c 'import json,sys; e=list(json.load(open(sys.argv[1]))["packages"].values())[0]; v=e.get(sys.argv[2]); print(json.dumps(v) if isinstance(v,dict) else v)' "$T/out/v9.9.9.json" "$1"; }

echo "== no native code: the builder's glibc"
tree; build 2.28; rc=$?; check "build ok" '[ "$rc" = 0 ]'
check "glibc 2.28" '[ "$(field glibc)" = 2.28 ]'

echo "== a module compiled against a newer glibc raises the floor"
tree; elf "$T/b/src/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build/Release/pty.node" $MACHINE 2.2.5 2.14 2.34 2.28
build 2.28
check "glibc 2.34" '[ "$(field glibc)" = 2.34 ]'
check "the builder glibc is kept too" '[ "$(field glibc_build)" = 2.28 ]'
check "the log names the file" 'grep -q "pty.node needs GLIBC_2.34" "$T/log"'

echo "== versions compare as numbers"
tree; elf "$T/b/src/a.so" $MACHINE 2.9; elf "$T/b/src/b.so.1" $MACHINE 2.10
build 2.2
check "2.10 beats 2.9" '[ "$(field glibc)" = 2.10 ]'

echo "== another architecture's prebuild is ignored"
tree; elf "$T/b/src/node_modules/.pnpm/zip@1/node_modules/zip/index.linux-other.node" $OTHER 2.40
build 2.28
check "glibc 2.28" '[ "$(field glibc)" = 2.28 ]'

echo "== known optional npm prebuilds are recorded, not counted"
tree
elf "$T/b/src/node_modules/.pnpm/sherpa-onnx-linux-x64@1.13.8/node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node" $MACHINE 2.32
elf "$T/b/src/node_modules/.pnpm/sherpa-onnx-linux-arm64@1.13.8/node_modules/sherpa-onnx-linux-arm64/sherpa-onnx.node" $MACHINE 2.32
build 2.28
check "glibc 2.28" '[ "$(field glibc)" = 2.28 ]'
check "optional recorded" 'field glibc_optional | grep -q "\"sherpa-onnx-linux-x64\": \"2.32\""'

echo "== an optional name elsewhere in the path does not hide a real module"
tree; elf "$T/b/src/packages/sherpa-onnx-linux-x64-fake/build/Release/x.node" $MACHINE 2.33
build 2.28
check "glibc 2.33" '[ "$(field glibc)" = 2.33 ]'

echo "== the archive and its sha still match"
check "sha" 'f="$(field file)"; [ "$(field sha256)" = "$(sha256sum "$T/out/$f" | cut -d" " -f1)" ]'

echo; echo "  $pass passed, $fail failed"; [ "$fail" -eq 0 ]
