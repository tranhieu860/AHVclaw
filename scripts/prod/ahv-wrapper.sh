#!/usr/bin/env bash
# AHV CLI wrapper — installed by ahvclaw.com/install.sh
set -e
FORK="/home/claudeproxy/.ahv/src"
BIN="apps/cli/src/bin.ts"
PATCH="$FORK/packages/bundle/ahv/cordis.patch.yml"
PATCH_WEB="$FORK/packages/bundle/ahv/cordis.patch.web.yml"
DEFAULT_AGENTS_MD="$FORK/packages/bundle/ahv/AGENTS.md"

if [ -t 1 ] && [ -z "$NO_COLOR" ]; then
  C1=$'\033[38;5;123m'; C2=$'\033[38;5;147m'
  DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  C1=""; C2=""; DIM=""; BOLD=""; RESET=""
fi

if [ ! -f "$FORK/$BIN" ]; then
  echo "ahv: source missing at $FORK/$BIN — reinstall: curl -fsSL https://ahvclaw.com/install.sh | bash" >&2
  exit 127
fi

[ -f "$HOME/.ahv/env" ] && . "$HOME/.ahv/env"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
INSTALL_MARKER="$DSH_HOME/.ahv-agents-installed"
if [ -f "$DEFAULT_AGENTS_MD" ] && [ ! -f "$INSTALL_MARKER" ]; then
  mkdir -p "$DSH_HOME"
  [ ! -f "$DSH_HOME/AGENTS.md" ] && cp "$DEFAULT_AGENTS_MD" "$DSH_HOME/AGENTS.md" && \
    echo "ahv: cài default agent rules → $DSH_HOME/AGENTS.md" >&2
  touch "$INSTALL_MARKER"
fi

print_banner() {
  local model="${AHV_MODEL:-ahv-qwen38}"
  local version
  version=$(node -p "require('$FORK/apps/cli/package.json').version" 2>/dev/null || echo "?")
  cat >&2 <<EOF

${C1}   █████╗ ██╗  ██╗██╗   ██╗${RESET}
${C1}  ██╔══██╗██║  ██║██║   ██║${RESET}
${C1}  ███████║███████║██║   ██║${RESET}   ${BOLD}AHV CLI${RESET}${DIM}  v${version}${RESET}
${C2}  ██╔══██║██╔══██║╚██╗ ██╔╝${RESET}   ${DIM}Model: ${RESET}${C1}${model}${RESET}
${C2}  ██║  ██║██║  ██║ ╚████╔╝ ${RESET}   ${DIM}Docs:  ${RESET}${C1}https://ahvclaw.com/docs${RESET}
${C2}  ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ${RESET}
EOF
}

cd "$FORK"

AHV_BOT="$HOME/.ahv/bin/ahv-bot.mjs"

case "${1:-}" in
  auth|login|doctor|sessions|models|version|run)
    exec node "$AHV_BOT" "$@"
    ;;
  web)
    shift
    exec node --import tsx/esm "$BIN" --profile web --patch "$PATCH_WEB" "$@"
    ;;
  plugin)
    exec node --import tsx/esm "$BIN" "$@"
    ;;
  update)
    echo "${C1}[ahv update]${RESET} pulling latest từ $(git -C "$FORK" remote get-url origin)"
    # fetch --tags để git describe hiển thị đúng AHV tag (v0.2.0-p1 etc)
    # thay vì chỉ short SHA. Bot team pin theo tag.
    git -C "$FORK" fetch origin --tags --force
    if ! git -C "$FORK" diff --quiet || ! git -C "$FORK" diff --cached --quiet; then
      echo "ahv update: source dirty tại $FORK, skip pull. Chạy 'git -C $FORK status' để xem." >&2
      exit 1
    fi
    git -C "$FORK" pull --ff-only
    (cd "$FORK" && pnpm install --prefer-offline || true)
    (cd "$FORK" && PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm run build)
    [ -x "$FORK/scripts/install-ahv-skin.sh" ] && bash "$FORK/scripts/install-ahv-skin.sh" || true
    # Bake version vào $FORK/AHV_VERSION (2 dòng: tag, short SHA) để
    # wrapper --version không lệ thuộc git command runtime.
    printf '%s\n%s\n' \
      "$(git -C "$FORK" describe --tags --always --dirty)" \
      "$(git -C "$FORK" rev-parse --short HEAD)" > "$FORK/AHV_VERSION"
    echo "${C1}[ahv update]${RESET} done → $(sed -n 1p "$FORK/AHV_VERSION")"
    ;;
  --version|-v)
    # AHV CLI version = git tag/short SHA + dsh underlying. Bot pin theo
    # AHV tag. Ưu tiên file $FORK/AHV_VERSION (bake bởi install.sh/ahv
    # update) để wrapper không lệ thuộc git command sẵn trong PATH lúc
    # runtime (systemd env, container, git bị strip khỏi image, ...).
    AHV_TAG=""
    AHV_SHA=""
    if [ -f "$FORK/AHV_VERSION" ]; then
      AHV_TAG=$(sed -n 1p "$FORK/AHV_VERSION" 2>/dev/null)
      AHV_SHA=$(sed -n 2p "$FORK/AHV_VERSION" 2>/dev/null)
    fi
    [ -z "$AHV_TAG" ] && AHV_TAG=$(git -C "$FORK" describe --tags --always --dirty 2>/dev/null)
    [ -z "$AHV_SHA" ] && AHV_SHA=$(git -C "$FORK" rev-parse --short HEAD 2>/dev/null)
    [ -z "$AHV_TAG" ] && AHV_TAG="unknown"
    [ -z "$AHV_SHA" ] && AHV_SHA="unknown"
    DSH_VER=$(node -p "require('$FORK/apps/cli/package.json').version" 2>/dev/null || echo unknown)
    echo "ahv $AHV_TAG (commit $AHV_SHA, dsh $DSH_VER)"
    exit 0
    ;;
  --help|-h|--dump-config|--dump-default-config)
    exec node --import tsx/esm "$BIN" "$@"
    ;;
  '')
    print_banner
    cat >&2 <<HINT
  Usage:
    ${BOLD}ahv "task"${RESET}                 gõ task, model chạy 1 lượt rồi exit
    ${BOLD}ahv web${RESET}                    mở web UI local (127.0.0.1:3080)
    ${BOLD}ahv update${RESET}                 kéo bản mới nhất từ GitHub
    ${BOLD}ahv --help${RESET}                 xem toàn bộ dsh options
    ${BOLD}ahv plugin add <pkg>${RESET}       cài plugin từ npm / GitHub

  Ví dụ:
    ${DIM}ahv "tìm file lớn nhất trong /var/log rồi tail 20 dòng"${RESET}
    ${DIM}ahv "explain what this repo does"${RESET}

HINT
    exit 0
    ;;
  *)
    exec node --import tsx/esm "$BIN" --profile headless --patch "$PATCH" "$@"
    ;;
esac
