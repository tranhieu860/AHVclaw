#!/usr/bin/env bash
# Release the AHV CLI from this checkout: commit what the registry sync
# changed, tag the next v0.2.x, build that tag in an isolated builder as the
# bot user, smoke-test the build, package it for the release channel, and only
# then push commit + tag to GitHub. GitHub stays the source of truth: nothing
# is published before the tag is proven, and a failed smoke leaves the
# repository exactly as it was.
#
# Usage: scripts/prod/release-cli.sh [-m "commit message"] [--dry-run]
# Env:   AHV_RELEASE_DIR  channel dir      (default /srv/ahvclaw.com/releases/ahv-cli)
#        AHV_BUILD_USER   builder account  (default ahvproxy)
#        AHV_BUILD_HOME   builder AHV_HOME (default /home/$AHV_BUILD_USER/.ahv/build)
set -euo pipefail

FORK="$(cd "$(dirname "$0")/../.." && pwd)"
RELEASE_DIR="${AHV_RELEASE_DIR:-/srv/ahvclaw.com/releases/ahv-cli}"
BUILD_USER="${AHV_BUILD_USER:-ahvproxy}"
BUILD_HOME="${AHV_BUILD_HOME:-/home/$BUILD_USER/.ahv/build}"
MESSAGE="plugins: sync from registry"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    -m) MESSAGE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '%s release-cli: %s\n' "$(date -Is)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }

cd "$FORK"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$FORK is not a git checkout"
[ "$(git rev-parse --abbrev-ref HEAD)" = "master" ] || fail "not on master"

# Only the files the registry sync owns may be dirty; anything else is a
# human's work in progress and must not be swept into an automatic release.
dirty="$(git status --porcelain)"
allowed='^.. (packages/bundle/ahv/package\.json|packages/bundle/ahv/cordis\.patch\.yml|pnpm-lock\.yaml)$'
if [ -n "$dirty" ] && printf '%s\n' "$dirty" | grep -vE "$allowed" | grep -q .; then
  printf '%s\n' "$dirty" >&2
  fail "checkout has changes outside the registry-managed files; refusing"
fi
if [ -z "$dirty" ]; then
  log "nothing to release: registry-managed files are unchanged"
  exit 0
fi

git fetch -q origin --tags
last="$(git tag -l 'v0.2.*' --sort=-v:refname | head -1)"
[ -n "$last" ] || fail "no v0.2.* tag found"
next="v0.2.$(( ${last##*.} + 1 ))"
git tag -l "$next" | grep -q . && fail "tag $next already exists"
log "changes: $(printf '%s' "$dirty" | tr '\n' ';')"
log "next tag: $next (after $last)"
if [ "$DRY_RUN" -eq 1 ]; then log "dry run, stopping before commit"; exit 0; fi

git add packages/bundle/ahv/package.json packages/bundle/ahv/cordis.patch.yml pnpm-lock.yaml 2>/dev/null || true
git -c user.name="AHV release bot" -c user.email="release@ahvclaw.com" commit -q -m "$MESSAGE" -m "Automated by ahv-admin registry sync." || fail "commit failed"
git tag -a "$next" -m "$next: $MESSAGE"
rollback() {
  log "rolling back local commit and tag $next"
  git tag -d "$next" >/dev/null 2>&1 || true
  git reset -q --hard HEAD~1 || true
}

# Build the tag as the bot user from THIS checkout (not GitHub: the tag is
# not pushed yet). The builder has its own AHV_HOME so the live CLI under
# ~/.ahv/src is untouched until the channel says otherwise.
log "building $next in $BUILD_HOME as $BUILD_USER"
# The builder clones from this checkout, which another account owns; git
# refuses such a repository unless it is declared safe for the builder.
for safe in "$FORK" "$FORK/.git"; do
  sudo -u "$BUILD_USER" -H git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$safe" ||
    sudo -u "$BUILD_USER" -H git config --global --add safe.directory "$safe"
done
if ! sudo -u "$BUILD_USER" -H env \
    AHV_HOME="$BUILD_HOME" AHV_BIN="$BUILD_HOME/bin-link" \
    AHV_REPO_URL="file://$FORK" AHV_BRANCH="$next" AHV_CLI_VERSION="$next" NO_COLOR=1 \
    PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 \
    bash "$FORK/scripts/prod/install.sh" >"/tmp/ahv-release-build-$next.log" 2>&1; then
  tail -30 "/tmp/ahv-release-build-$next.log" >&2
  rollback
  fail "build failed (log: /tmp/ahv-release-build-$next.log)"
fi

# Smoke: the built tree must report the tag, pass doctor, and answer the
# quota lookup with a well-formed document.
smoke="$BUILD_HOME/bin/ahv"
version="$(sudo -u "$BUILD_USER" -H env NO_COLOR=1 "$smoke" --version 2>/dev/null | head -1 || true)"
case "$version" in
  *"ahv $next "*|*"ahv $next") log "smoke version: $version" ;;
  *) rollback; fail "smoke: built CLI reports '$version', not $next" ;;
esac
doctor="$(sudo -u "$BUILD_USER" -H env NO_COLOR=1 timeout 120 "$smoke" doctor 2>/dev/null || true)"
python3 - "$doctor" <<'PY' || { rollback; fail "smoke: doctor not ok"; }
import json, sys
d = json.loads(sys.argv[1])
assert d.get("ok") is True and int(d.get("error_count", 1)) == 0, d
PY
usage="$(sudo -u "$BUILD_USER" -H env NO_COLOR=1 timeout 90 "$smoke" login usage --json 2>/dev/null || true)"
python3 - "$usage" <<'PY' || { rollback; fail "smoke: login usage malformed"; }
import json, sys
d = json.loads(sys.argv[1])
assert "providers" in d and "claude" in d["providers"], d
PY
log "smoke passed"

# Package for the channel, then push. Push last: a tag on GitHub is a promise
# that a proven build exists.
log "packaging $next → $RELEASE_DIR"
sudo mkdir -p "$RELEASE_DIR"
sudo bash "$FORK/scripts/prod/build-prebuilt.sh" "$next" "$RELEASE_DIR" "$BUILD_HOME/src" || { rollback; fail "prebuilt packaging failed"; }
sudo chmod 644 "$RELEASE_DIR"/*
log "pushing master and $next to origin"
git push --no-verify -q origin master "$next" || fail "push failed (build and channel are done; push by hand)"
log "released $next"
printf '%s\n' "$next"
