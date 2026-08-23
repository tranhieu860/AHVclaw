#!/usr/bin/env bash
# AHV CLI wrapper — installed by ahvclaw.com/install.sh
set -e
FORK="__AHV_SRC__"
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

AHV_BOT="__AHV_BIN_DIR__/ahv-bot.mjs"

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
    # A shallow clone (how install.sh creates it) has no tags in reach, so
    # `git describe` below would report a bare SHA as the version.
    if [ "$(git -C "$FORK" rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
      git -C "$FORK" fetch origin --tags --force --depth=500
    else
      git -C "$FORK" fetch origin --tags --force
    fi
    # `pnpm install` rewrites pnpm-lock.yaml on every install, so without this
    # restore the very first update would find the tree dirty and refuse — for
    # good.
    git -C "$FORK" checkout -- pnpm-lock.yaml 2>/dev/null || true
    if ! git -C "$FORK" diff --quiet || ! git -C "$FORK" diff --cached --quiet; then
      echo "ahv update: source dirty tại $FORK, skip pull. Chạy 'git -C $FORK status' để xem." >&2
      exit 1
    fi
    git -C "$FORK" pull --ff-only
    # PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 bypass supply-chain policy cho fresh
    # plugin releases (<24h). AHV pin exact version qua workspace exclude,
    # rủi ro attack chain thấp; fresh plugin (dshmarket, @anweat/dsh-browser)
    # thường patch security nên nên get sớm hơn.
    (cd "$FORK" && PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --prefer-offline || true)
    (cd "$FORK" && PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm run build)
    [ -x "$FORK/scripts/install-ahv-skin.sh" ] && bash "$FORK/scripts/install-ahv-skin.sh" || true
    # Bake version vào $FORK/AHV_VERSION (2 dòng: tag, short SHA) để
    # wrapper --version không lệ thuộc git command runtime.
    printf '%s\n%s\n' \
      "$(git -C "$FORK" describe --tags --always --dirty)" \
      "$(git -C "$FORK" rev-parse --short HEAD)" > "$FORK/AHV_VERSION"
    # Refresh the wrapper and bot adapter too. They live beside the source but
    # are copies, so without this an update pulls new harness code while the
    # CLI surface stays frozen at whatever shipped the day it was installed —
    # every fix we make to the adapter would never reach an existing install.
    # Written via temp + mv: replacing the inode leaves this running script's
    # own file descriptor intact, while truncating in place would corrupt it.
    AHV_BIN_DIR="$(dirname "$AHV_BOT")"
    if [ -f "$FORK/scripts/prod/ahv-wrapper.sh" ] && [ -f "$FORK/scripts/prod/ahv-bot.mjs" ]; then
      TMP_WRAPPER="$AHV_BIN_DIR/.ahv.update.$$"
      sed -e "s|__AHV_SRC__|$FORK|g" -e "s|__AHV_BIN_DIR__|$AHV_BIN_DIR|g" \
        "$FORK/scripts/prod/ahv-wrapper.sh" > "$TMP_WRAPPER"
      if grep -q '__AHV_SRC__\|__AHV_BIN_DIR__' "$TMP_WRAPPER"; then
        rm -f "$TMP_WRAPPER"
        echo "ahv update: wrapper còn placeholder, giữ nguyên bản cũ" >&2
      else
        chmod 755 "$TMP_WRAPPER"
        mv -f "$TMP_WRAPPER" "$AHV_BIN_DIR/ahv"
        TMP_BOT="$AHV_BIN_DIR/.ahv-bot.update.$$"
        cp "$FORK/scripts/prod/ahv-bot.mjs" "$TMP_BOT"
        chmod 755 "$TMP_BOT"
        mv -f "$TMP_BOT" "$AHV_BOT"
        echo "${C1}[ahv update]${RESET} wrapper + bot adapter refreshed"
      fi
    fi
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
