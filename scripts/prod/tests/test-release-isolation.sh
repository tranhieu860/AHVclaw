#!/usr/bin/env bash
# The release build must not borrow anything from the live install.
#
# The admin service exports AHV_FORK for the live fork. That leaked into the
# smoke doctor, which compares the profile plugin farm against AHV_FORK, so
# every release failed with "profile dang nap plugin tu <build tree>, khong
# phai ban da install tai <live fork>" — and worse, the builder relinked the
# shared ~/.dsh farm at the build tree, so the live CLI would have loaded
# plugins from ~/.ahv-build.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../release-cli.sh"
fails=0
check() { # name, pattern
  if grep -q -- "$2" "$SCRIPT"; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); fi
}
check 'build env pins AHV_FORK to the build tree' 'AHV_FORK="$BUILD_HOME/src"'
check 'build env pins DSH_HOME to the build tree' 'DSH_HOME="$BUILD_HOME/dsh"'
check 'build uses the pinned env' 'run_as env \\'
for step in '"$smoke" --version' '"$smoke" doctor' '"$smoke" login usage'; do
  line="$(grep -F "$step" "$SCRIPT" | head -1)"
  if printf '%s' "$line" | grep -q 'BUILD_ENV\[@\]'; then
    printf '  PASS  smoke step uses the pinned env: %s\n' "$step"
  else
    printf '  FAIL  smoke step inherits the ambient env: %s\n' "$step"
    fails=$((fails + 1))
  fi
done
# A rolled-back tag gets re-cut with the same name; a clone that fetched the
# first one refuses the second ("would clobber existing tag") and every later
# build on that clone fails — which is exactly what happened to the builder.
INSTALL="$HERE/../install.sh"
if grep -q 'git fetch origin --tags --force' "$INSTALL"; then
  printf '  PASS  install pull force-fetches tags\n'
else
  printf '  FAIL  install pull refuses a re-cut tag\n'; fails=$((fails + 1))
fi
if grep -n 'git fetch origin --tags$' "$INSTALL" >/dev/null; then
  printf '  FAIL  install still has a non-forced tag fetch\n'; fails=$((fails + 1))
else
  printf '  PASS  no non-forced tag fetch remains\n'
fi

[ "$fails" -eq 0 ] && { echo "test-release-isolation: OK"; exit 0; }
echo "test-release-isolation: $fails failed"; exit 1
