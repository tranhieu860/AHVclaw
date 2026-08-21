#!/usr/bin/env bash
# ahv-update — sync upstream dsh into the current fork, rebuild, and
# report what changed. Safe to re-run; refuses to move if the working
# tree is dirty (would clobber uncommitted work).
#
# Usage: ./scripts/ahv-update.sh [--dry-run]
#
# Prerequisites:
#   - `upstream` remote points at deepseek-ai/deepseek-harness
#   - git credentials in place (~/.git-credentials or SSH)
#   - pnpm 10+

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

log() { printf '\033[36m[ahv-update]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ahv-update]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[ahv-update]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. sanity ────────────────────────────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "working tree dirty — commit or stash before updating"
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  log "adding upstream remote"
  [[ $DRY -eq 0 ]] && git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
fi

# ── 2. fetch ─────────────────────────────────────────────────────────────
log "fetching upstream/master"
[[ $DRY -eq 0 ]] && git fetch upstream --tags

behind=$(git rev-list --count HEAD..upstream/master 2>/dev/null || echo 0)
if [[ $behind -eq 0 ]]; then
  log "already at upstream HEAD — nothing to do"
  exit 0
fi
log "$behind new commit(s) from upstream"

# ── 3. show diff summary ─────────────────────────────────────────────────
log "commit summary:"
git log --oneline HEAD..upstream/master | head -20
if [[ $behind -gt 20 ]]; then log "…and $((behind - 20)) more"; fi

log "files changed:"
git diff --stat HEAD upstream/master | tail -5

if [[ $DRY -eq 1 ]]; then
  log "--dry-run: stopping before merge"
  exit 0
fi

# ── 4. merge ─────────────────────────────────────────────────────────────
log "merging upstream/master"
if ! git merge upstream/master --no-edit; then
  warn "merge conflict — resolve then re-run pnpm install && pnpm run build && commit"
  warn "typical conflict files (safe to keep ours):"
  warn "  - README.md"
  warn "  - apps/cli/src/bin.ts (keep the withAhvDefaultProfile block)"
  warn "  - packages/boot/app-boot/src/profile.ts (keep the PROFILE_TEMPLATES.ahv row)"
  exit 2
fi

# ── 5. rebuild ───────────────────────────────────────────────────────────
log "pnpm install (workspace deps may have moved)"
pnpm install

log "pnpm run build"
pnpm run build

log "pnpm run typecheck"
pnpm run typecheck || warn "typecheck failed — inspect before pushing"

# ── 6. push ──────────────────────────────────────────────────────────────
log "pushing to origin"
git push origin master

log "done — synced $behind commits"
