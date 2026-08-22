#!/usr/bin/env bash
# AHV CLI installer — clone + build fork tại ~/.ahv/src và link `ahv`
# vào PATH. Re-runnable: nếu đã cài sẽ tự pull latest.
#
# Usage:
#   curl -fsSL https://ahvclaw.com/install.sh | bash
#
# Env overrides:
#   AHV_HOME=$HOME/.ahv     — thư mục cài (source, wrapper, env)
#   AHV_BIN=~/.local/bin    — nơi symlink `ahv`
#   AHV_REPO_URL=https://github.com/tranhieu860/AHVclaw.git
#   AHV_BRANCH=master
#
# Yêu cầu: bash, git, Node.js ≥ 22, ~3GB disk. Chạy trên Linux + macOS.

set -euo pipefail

AHV_HOME="${AHV_HOME:-$HOME/.ahv}"
AHV_BIN="${AHV_BIN:-$HOME/.local/bin}"
AHV_REPO_URL="${AHV_REPO_URL:-https://github.com/tranhieu860/AHVclaw.git}"
AHV_BRANCH="${AHV_BRANCH:-master}"

SRC="$AHV_HOME/src"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C1=$'\033[38;5;123m'; C2=$'\033[38;5;147m'
  DIM=$'\033[2m'; BOLD=$'\033[1m'; ERR=$'\033[31m'; OK=$'\033[32m'; RESET=$'\033[0m'
else
  C1=""; C2=""; DIM=""; BOLD=""; ERR=""; OK=""; RESET=""
fi

log()  { printf '%s[ahv-install]%s %s\n' "$C1" "$RESET" "$*"; }
warn() { printf '%s[ahv-install]%s %s\n' "$C2" "$RESET" "$*" >&2; }
fail() { printf '%s[ahv-install] ERROR:%s %s\n' "$ERR" "$RESET" "$*" >&2; exit 1; }

cat <<EOF

${C1}   █████╗ ██╗  ██╗██╗   ██╗${RESET}
${C1}  ██╔══██╗██║  ██║██║   ██║${RESET}
${C1}  ███████║███████║██║   ██║${RESET}   ${BOLD}AHV CLI Installer${RESET}
${C2}  ██╔══██║██╔══██║╚██╗ ██╔╝${RESET}   ${DIM}https://ahvclaw.com${RESET}
${C2}  ██║  ██║██║  ██║ ╚████╔╝ ${RESET}
${C2}  ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ${RESET}

EOF

log "Kiểm tra prerequisites..."

command -v git >/dev/null 2>&1 || fail "Cần \`git\`. Cài: apt install git / brew install git"

if ! command -v node >/dev/null 2>&1; then
  fail "Cần Node.js >= 22. Cài qua nvm:
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    exec \$SHELL -l && nvm install 22"
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js $(node -v) quá cũ. Cần >= 22. Nâng cấp: nvm install 22 && nvm use 22"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log "Cài pnpm 10 qua corepack..."
  if ! corepack enable 2>/dev/null; then
    sudo corepack enable 2>/dev/null || fail "corepack enable fail — cài pnpm thủ công: npm i -g pnpm"
  fi
  corepack prepare pnpm@10.11.0 --activate
fi

PNPM_MAJOR=$(pnpm -v | cut -d. -f1)
if [ "$PNPM_MAJOR" -lt 10 ]; then
  warn "pnpm $(pnpm -v) < 10, đang nâng cấp..."
  corepack prepare pnpm@10.11.0 --activate
fi

log "OK Node $(node -v), pnpm $(pnpm -v), git $(git --version | awk '{print $3}')"

mkdir -p "$AHV_HOME"

if [ -d "$SRC/.git" ]; then
  log "Đã có source tại $SRC — pull latest..."
  cd "$SRC"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "Source có thay đổi chưa commit tại $SRC — skip pull. Chạy 'git stash' rồi 'ahv update' thủ công."
  else
    git fetch origin --tags
    git checkout "$AHV_BRANCH"
    git pull --ff-only origin "$AHV_BRANCH"
  fi
else
  log "Clone $AHV_REPO_URL → $SRC (khoảng 100MB)..."
  git clone --branch "$AHV_BRANCH" --depth 1 "$AHV_REPO_URL" "$SRC"
  cd "$SRC"
fi

log "Cài dependencies (mất 3-8 phút, tốn ~2GB disk)..."
# pnpm 11 exit 1 khi có build scripts bị ignore (cloudflared/cpu-features/ssh2 —
# optional deps của các plugin community, không blocker cho AHV core). Chấp nhận
# non-zero exit ở đây; bước sau (wrapper, skin) sẽ fail rõ ràng nếu thật sự hỏng.
pnpm install --prefer-offline || warn "pnpm install returned non-zero (thường do build scripts optional bị skip, an toàn bỏ qua)"

log "Build workspace (tsc -b + tsdown, mất 5-10 phút)..."
# pnpm 11 chạy runDepsStatusCheck trước mỗi `pnpm run` → gọi lại pnpm install
# → exit 1 nếu build scripts optional bị skip → block build. Tắt check qua
# PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN env để build proceed.
PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm run build || fail "build fail — xem log ở trên"

if [ -x "$SRC/scripts/install-ahv-skin.sh" ]; then
  log "Cài skin AHV..."
  bash "$SRC/scripts/install-ahv-skin.sh" || warn "skin install skipped"
fi

mkdir -p "$AHV_BIN"

WRAPPER="$AHV_HOME/bin/ahv"
mkdir -p "$AHV_HOME/bin"

cat > "$WRAPPER" <<'WRAPPER_EOF'
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

case "${1:-}" in
  web)
    shift
    exec node --import tsx/esm "$BIN" --profile web --patch "$PATCH_WEB" "$@"
    ;;
  plugin)
    exec node --import tsx/esm "$BIN" "$@"
    ;;
  update)
    echo "${C1}[ahv update]${RESET} pulling latest từ $(git -C "$FORK" remote get-url origin)"
    git -C "$FORK" fetch origin --tags
    if ! git -C "$FORK" diff --quiet || ! git -C "$FORK" diff --cached --quiet; then
      echo "ahv update: source dirty tại $FORK, skip pull. Chạy 'git -C $FORK status' để xem." >&2
      exit 1
    fi
    git -C "$FORK" pull --ff-only
    (cd "$FORK" && pnpm install --prefer-offline || true)
    (cd "$FORK" && PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm run build)
    [ -x "$FORK/scripts/install-ahv-skin.sh" ] && bash "$FORK/scripts/install-ahv-skin.sh" || true
    echo "${C1}[ahv update]${RESET} done → v$(node -p "require('$FORK/apps/cli/package.json').version" 2>/dev/null || echo "?")"
    ;;
  --version|-v|--help|-h|--dump-config|--dump-default-config)
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
WRAPPER_EOF

sed -i.bak "s|__AHV_SRC__|$SRC|g" "$WRAPPER" && rm -f "$WRAPPER.bak"
chmod +x "$WRAPPER"

ln -sfn "$WRAPPER" "$AHV_BIN/ahv"
log "OK Wrapper → $WRAPPER"
log "OK Symlink → $AHV_BIN/ahv"

if ! echo ":$PATH:" | grep -q ":$AHV_BIN:"; then
  warn "$AHV_BIN chưa có trong \$PATH. Thêm dòng này vào ~/.bashrc hoặc ~/.zshrc:"
  echo "    ${BOLD}export PATH=\"$AHV_BIN:\$PATH\"${RESET}"
  echo ""
  warn "Rồi chạy lại shell: exec \$SHELL -l"
fi

ENV_FILE="$AHV_HOME/env"
if [ ! -f "$ENV_FILE" ] || ! grep -q "AHV_API_KEY" "$ENV_FILE" 2>/dev/null; then
  echo ""
  warn "Chưa có AHV_API_KEY."
  echo "  Xin key miễn phí tại: ${C1}${BOLD}https://ahvclaw.com/apply${RESET}"
  echo "  Sau khi có key, chạy:"
  echo "    ${BOLD}echo 'export AHV_API_KEY=sk-...' >> $ENV_FILE${RESET}"
  echo "  (Wrapper tự source $ENV_FILE trước mỗi lần chạy.)"
fi

echo ""
printf '%s✓ Cài đặt xong!%s\n' "$OK" "$RESET"
echo ""
echo "  Test: ${BOLD}ahv --version${RESET}"
echo "  Chat: ${BOLD}ahv \"tìm file lớn nhất trong /tmp\"${RESET}"
echo "  Web:  ${BOLD}ahv web${RESET}"
echo "  Update sau này: ${BOLD}ahv update${RESET}"
echo ""
