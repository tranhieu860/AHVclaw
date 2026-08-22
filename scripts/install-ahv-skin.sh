#!/bin/bash
# Install AHV skin as built-in in @linxin666/dsh-client-ui-skin-center.
# Run after every `pnpm install` because pnpm regens the store and drops
# skins/ahv/. Idempotent — safe to re-run.

set -e
FORK="${FORK:-/home/claudeproxy/Claude/AHVclaw-fork}"
PROFILE="${PROFILE:-/home/claudeproxy/.dsh/profiles/web}"
SKIN_SRC="$FORK/packages/bundle/ahv/skin-assets"

if [ ! -d "$SKIN_SRC" ]; then
  echo "[ahv-skin] skin assets not found at $SKIN_SRC"
  exit 1
fi

# Both copies: fork's .pnpm virtual + profile's hoisted node_modules
targets=()
[ -d "$FORK/node_modules" ] && \
  targets+=($(ls -d $FORK/node_modules/.pnpm/@linxin666+dsh-client-ui-skin-center@*/node_modules/@linxin666/dsh-client-ui-skin-center 2>/dev/null))
[ -d "$PROFILE/node_modules" ] && \
  targets+=("$PROFILE/node_modules/@linxin666/dsh-client-ui-skin-center")

installed=0
for t in "${targets[@]}"; do
  [ -d "$t" ] || continue
  mkdir -p "$t/skins/ahv"
  cp -r "$SKIN_SRC"/* "$t/skins/ahv/"
  echo "[ahv-skin] installed → $t/skins/ahv/"
  installed=$((installed + 1))
done

if [ $installed -eq 0 ]; then
  echo "[ahv-skin] no skin-center package found; is pnpm install done?"
  exit 1
fi
