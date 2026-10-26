#!/usr/bin/env bash
# The web profile's skin-center must be the version this install's closure pins.
#
# install-ahv-skin.sh looked for that pin in the dsh 0.1 profile farm, found
# nothing under dsh 0.2 and installed "latest" (0.4.8). That release requires
# dsh >= 0.2.1-rc.2, so dsh 0.2.1 loads it, and it paints its own default skin
# (a whale with Chinese captions) over the AHV brand.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../../install-ahv-skin.sh"
pass=0; fail=0
check() { if [ "$2" = pass ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1${3:+ -- $3}"; fail=$((fail+1)); fi; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
PKG="@linxin666/dsh-client-ui-skin-center"

# A minimal install closure: bundle → dsh-web-ui-all → skin-center 0.2.9.
FORK="$SANDBOX/src"
STORE="$FORK/node_modules/.pnpm/@linxin666+dsh-web-ui-all@0.2.9/node_modules"
mkdir -p "$FORK/packages/bundle/ahv/skin-assets" "$FORK/packages/bundle/ahv/node_modules/@linxin666" \
         "$STORE/@linxin666/dsh-web-ui-all" "$STORE/$PKG"
echo '{}' > "$FORK/packages/bundle/ahv/skin-assets/skin.json"
echo '{"name":"@ahvclaw/dsh-bundle-ahv"}' > "$FORK/packages/bundle/ahv/package.json"
echo '{"name":"@linxin666/dsh-web-ui-all","version":"0.2.9"}' > "$STORE/@linxin666/dsh-web-ui-all/package.json"
echo "{\"name\":\"$PKG\",\"version\":\"0.2.9\"}" > "$STORE/$PKG/package.json"
ln -s "$STORE/@linxin666/dsh-web-ui-all" "$FORK/packages/bundle/ahv/node_modules/@linxin666/dsh-web-ui-all"

# pnpm stand-in: records its arguments and installs the requested version.
mkdir -p "$SANDBOX/bin"
cat > "$SANDBOX/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$PNPM_LOG"
spec="${!#}"; version="${spec##*@}"
mkdir -p "node_modules/@linxin666/dsh-client-ui-skin-center"
echo "{\"name\":\"@linxin666/dsh-client-ui-skin-center\",\"version\":\"$version\"}" > node_modules/@linxin666/dsh-client-ui-skin-center/package.json
EOF
chmod +x "$SANDBOX/bin/pnpm"

run() { # profile state: none | <version>
  local dsh="$SANDBOX/dsh-$1"; local profile="$dsh/profiles/web"
  mkdir -p "$profile"
  if [ "$1" != none ]; then
    mkdir -p "$profile/node_modules/$PKG"
    echo "{\"name\":\"$PKG\",\"version\":\"$1\"}" > "$profile/node_modules/$PKG/package.json"
  fi
  export PNPM_LOG="$dsh/pnpm.log"; : > "$PNPM_LOG"
  PATH="$SANDBOX/bin:$PATH" FORK="$FORK" DSH_HOME="$dsh" PROFILE="$profile" bash "$SCRIPT" > "$dsh/out.log" 2>&1
  INSTALLED="$(node -p "require('$profile/node_modules/$PKG/package.json').version" 2>/dev/null)"
  CALLS="$(cat "$PNPM_LOG")"
}

run none
[ "$INSTALLED" = 0.2.9 ] && check "a profile without skin-center gets the closure's 0.2.9" pass || check "a profile without skin-center gets the closure's 0.2.9" fail "installed=$INSTALLED calls=$CALLS"
case "$CALLS" in *latest*) check 'never asks pnpm for "latest"' fail "$CALLS" ;; *) check 'never asks pnpm for "latest"' pass ;; esac

run 0.4.8
[ "$INSTALLED" = 0.2.9 ] && check "a profile holding 0.4.8 is moved back to 0.2.9" pass || check "a profile holding 0.4.8 is moved back to 0.2.9" fail "installed=$INSTALLED calls=$CALLS"

run 0.2.9
[ -z "$CALLS" ] && check "a profile already on 0.2.9 runs no pnpm" pass || check "a profile already on 0.2.9 runs no pnpm" fail "$CALLS"

echo "$pass passed, $fail failed"
exit $((fail > 0))
