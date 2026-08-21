# AHV CLI

[![Website](https://img.shields.io/badge/site-ahvclaw.com-06b6d4)](https://ahvclaw.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Built on: dsh](https://img.shields.io/badge/built%20on-DeepSeek%20Harness-8b5cf6)](https://github.com/deepseek-ai/deepseek-harness)

**AHV CLI** là agentic dev terminal cho developer Việt, built on
[DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).
Cài một dòng, gõ `ahv`, có ngay tool-calling REPL với router LLM riêng
của AHV Holding — không cần config bên ngoài.

## Cài đặt

```bash
# Từ npm:
npm install -g @ahvclaw/cli

# Hoặc từ source:
git clone https://github.com/tranhieu860/AHVclaw.git
cd AHVclaw
pnpm install
```

Yêu cầu Node.js ^22.19 hoặc >= 24, pnpm 10+.

## Chạy

```bash
export AHV_API_KEY=sk-...                       # key từ AHV Holding

# One-shot terminal (default):
ahv "Tìm file lớn nhất trong /var/log rồi tail 20 dòng"

# Web UI + Plugin Market:
ahv web                          # mở http://127.0.0.1:3080

# Hoặc explicit profile:
dsh --profile ahv "..."
dsh --profile ahv-web            # web mode với AHV router
dsh --profile headless "..."     # dsh gốc, cần DEEPSEEK_API_KEY
```

Lần đầu `ahv` chạy sẽ tự init profile `ahv` tại `$DSH_HOME/profiles/ahv/`
(mặc định `~/.dsh/profiles/ahv/`) và load bundle
[`@ahvclaw/dsh-bundle-ahv`](./packages/bundle/ahv/) — bundle này đè config
default model trỏ vào router `auto.ahvchat.com/v1`, model `AHV-Holding`,
persona tiếng Việt.

## Tính năng

Kế thừa từ dsh + gói riêng AHV:

- **Tool-calling REPL** với bash, filesystem, grep, web-search, workflow,
  subagent (delegate), todo, plan-mode, skill.
- **Multi-provider** qua `pi-ai`: DeepSeek, Anthropic, OpenAI, và mọi
  endpoint OpenAI-compat (bao gồm AHV router).
- **Session persist + resume** tại `$DSH_HOME/sessions/`.
- **Sandbox permissions** (read-only / workspace-write / danger-full-access)
  qua env `DSH_PERMISSION_MODE`.
- **Plugin ecosystem** đầy đủ dsh — `pnpm dsh plugin add <name>` để cài.

## Plugin cài sẵn trong bundle `ahv`

Base bundle của dsh đã bật ~40 plugin (bash, fs, web, subagent, todo,
plan, skill, workflow…). AHV thêm sẵn 7 plugin nữa để user có toolbelt
đầy ngay khi cài:

| Nhóm | Plugin | Mục đích |
|------|--------|----------|
| **Terminal** | `dsh-terminal`, `dsh-terminal-bash`, `dsh-tool-terminal` | Persistent PTY session — mở shell sống xuyên tool call. Dùng cho SSH lâu dài, tmux-style flow, script long-running. 6 tool: `terminal_open/send/read/signal/close/list`. |
| **Self-modify** | `dsh-cordis-host-runner`, `dsh-tool-cordis` | Agent inspect runtime của chính mình và mount plugin ad-hoc in-memory. 5 tool: `cordis_inspect/define/run/stop/undefine`. Không ghi file, không survive restart. |
| **Plugin Market** | `dshmarket` ([dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)) | UI browse + one-click install 1.5k+ community plugin. Hot-toggle enable/disable. Backup/restore. Chỉ active trong web mode (`ahv web`). |
| **Superpowers** | `superpowers-dsh` ([LayneChai/superpowers-dsh](https://github.com/LayneChai/superpowers-dsh)) | 14 curated agent skill — TDD, systematic-debugging, brainstorming, writing/executing-plans, subagent-driven-dev, git-worktrees, dispatching-parallel-agents, code-review flow, verification-before-completion, using-superpowers. Adapt từ [obra/superpowers](https://github.com/obra/superpowers) của Claude Code. Model gọi qua `skill_list` / `skill_load` tự động. |

Xem [bundle README](./packages/bundle/ahv/README.md) cho row-by-row config
và [`docs/plugins.html`](https://ahvclaw.com/docs/plugins.html) cho hướng
dẫn cài thêm plugin từ npm ecosystem.

## Hai profile

`ahv` bin hỗ trợ 2 profile theo cú pháp bạn gõ:

| Command | Profile | Mode | Dùng khi |
|---------|---------|------|----------|
| `ahv "task"` | `ahv` | Headless one-shot | Task nhanh trong terminal, không cần UI |
| `ahv web` | `ahv-web` | Web UI local :3080 | Cần Plugin Market UI, browse conversation, models page |

## Auto-update

Sync upstream dsh + rebuild:

```bash
./scripts/ahv-update.sh
# hoặc: pnpm run ahv:update  (nếu có script trong root package.json)
```

Xem [PULLING_UPSTREAM.md](./PULLING_UPSTREAM.md) cho quy trình chi tiết
+ cách handle conflict.

## Cấu hình

Ba lớp, sau đè trước:

1. **Bundle** (built-in) — `packages/bundle/ahv/cordis.patch.yml`.
2. **Profile user layer** — `$DSH_HOME/profiles/ahv/cordis.patch.yml`.
3. **Settings** — `$DSH_HOME/settings.yaml` (dsh Models page ghi vào đây).

Credentials: `AHV_API_KEY` env var hoặc `$DSH_HOME/.credentials.yaml`.

## Quan hệ với upstream

Repo này là **soft fork** của `deepseek-ai/deepseek-harness`:

- Giữ **nguyên** kiến trúc, package names `@deepseek-ai/*`, và workspace
  layout — để merge upstream không xung đột.
- **Thêm**: `packages/bundle/ahv/` (bundle config riêng), `ahv` bin alias
  trong `apps/cli`, `PROFILE_TEMPLATES.ahv` trong `packages/boot/app-boot`.
- **Docs**: [`README.dsh-upstream.md`](./README.dsh-upstream.md) là README
  gốc dsh; [`PULLING_UPSTREAM.md`](./PULLING_UPSTREAM.md) là quy trình
  merge upstream định kỳ.

Full dev doc từ upstream: [`AGENTS.md`](./AGENTS.md) (test, build,
snapshot, plugin authoring, capability seam, v.v.).

## License

MIT (giữ nguyên upstream). Xem [LICENSE](./LICENSE).

"DeepSeek Harness" là trademark của DeepSeek — tuân thủ
[BRAND_GUIDELINES.md](./BRAND_GUIDELINES.md). AHV CLI dùng tên "AHV" cho
fork của mình, không dùng trademark trực tiếp.

## Liên hệ

- Landing: <https://ahvclaw.com>
- Repo: <https://github.com/tranhieu860/AHVclaw>
- Owner: Hiếu (`tranhieu860@gmail.com`)
