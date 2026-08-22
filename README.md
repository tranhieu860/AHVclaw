<div align="center">

<pre>
   █████╗ ██╗  ██╗██╗   ██╗
  ██╔══██╗██║  ██║██║   ██║
  ███████║███████║██║   ██║   <b>AHV CLI</b>
  ██╔══██║██╔══██║╚██╗ ██╔╝   <i>Agentic dev terminal cho developer Việt</i>
  ██║  ██║██║  ██║ ╚████╔╝
  ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝
</pre>

[![Latest release](https://img.shields.io/github/v/tag/tranhieu860/AHVclaw?label=release&color=06b6d4&style=flat-square)](https://github.com/tranhieu860/AHVclaw/releases/latest)
[![Website](https://img.shields.io/badge/site-ahvclaw.com-a78bfa?style=flat-square)](https://ahvclaw.com)
[![Web UI](https://img.shields.io/badge/live-ahv.ahvclaw.com-06b6d4?style=flat-square)](https://ahv.ahvclaw.com)
[![Plugin registry](https://img.shields.io/badge/registry-10%20plugin-a78bfa?style=flat-square)](https://ahvclaw.com/admin)
[![License MIT](https://img.shields.io/badge/license-MIT-16a34a?style=flat-square)](./LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-16a34a?style=flat-square)](https://nodejs.org/)

**Cài 1 dòng. Chạy bất cứ đâu. 50+ plugin sẵn. Bot-ready contract.**

Multi-provider (AHV Router / ChatGPT Codex / Claude Pro / Grok Premium / mọi OpenAI-compat) · Tool-calling native · Session persist + resume · JSONL adapter cho Telegram/automation bot.

[**Cài đặt →**](#-cài) · [**Bot integration →**](#-cho-bot--automation) · [**Docs →**](https://ahvclaw.com) · [**Releases →**](https://github.com/tranhieu860/AHVclaw/releases)

</div>

---

## ⚡ Cài

```bash
curl -fsSL https://ahvclaw.com/install.sh | bash
```

Yêu cầu Node ≥22. Cần API key AHV Router — [xin miễn phí tại ahvclaw.com/apply](https://ahvclaw.com/apply).

## 🎯 Dùng

```bash
ahv "task"                        # one-shot chat
ahv web                           # web UI local :3080
ahv update                        # pull latest + rebuild
ahv --version                     # ahv v0.2.0-p2 (commit c4b1b07, dsh 0.1.1-rc.1)
```

## 🔌 Plugin cài sẵn

Base bundle của dsh mang ~40 plugin core (bash, fs, web, subagent, todo, plan, skill, workflow). AHV thêm **10 plugin** cho toolbelt xịn ngay từ đầu:

| Nhóm | Plugin | Mục đích |
|---|---|---|
| 🖥 Terminal | `dsh-terminal`, `-terminal-bash`, `-tool-terminal` | Persistent PTY session — SSH lâu dài, tmux-flow, long-running scripts. 6 tool. |
| 🧬 Self-modify | `cordis-host-runner`, `tool-cordis` | Agent inspect + mount plugin ad-hoc in-memory. 5 tool. |
| 🛒 Plugin Market | `dshmarket` | Browse + one-click install 1.5k+ community plugin. Web mode. |
| 🦸 Superpowers | `superpowers-dsh` | 14 curated skill: TDD, debugging, planning, git-worktrees, code-review flow. |
| 🔑 Subscriptions | `dsh-plugin-subscriptions` | ChatGPT Codex / Claude Pro / Grok Premium làm LLM provider — không cần API key thêm. |
| 🤖 Bot adapter | `bot-runner`, `bot-startup` | JSONL streamer cho Telegram/automation. Contract pin theo git tag. |

Full catalog live tại **[ahvclaw.com/admin](https://ahvclaw.com/admin)** — auto-track version pinned vs latest mỗi 6h, badge stale/latest cho từng plugin.

## 🔑 Subscription providers (không cần API key)

Đã có ChatGPT Pro/Codex, Claude Pro, Grok Premium? Login OAuth 1 lần qua browser:

```bash
ahv login url grok       # trả URL, mở browser
ahv login status --json  # {providers: {grok: {logged_in: true, ...}}}
ahv models list --json   # thấy grok-4.6, grok-4.5, ... trong catalog
ahv "reply just OK" --model grok-4.6
```

Model của subscription auto-mount vào harness sau login, `ahv models list --json` cover full 15+ model từ mọi provider.

## 🤖 Cho bot / automation

Pin git tag → JSONL contract stable, bot integrate như engine thứ 4 ngang Claude Code / Codex / Grok:

```bash
git -C ~/.ahv/src checkout v0.2.0-p2
ahv run --prompt-file X --cwd DIR --output jsonl --session-id ID --no-color --no-banner
```

**Event taxonomy:** `session_meta` → `assistant_delta` → `tool_status` → `assistant_final` → `turn_end` → `error {code, terminal, retry_after_sec, message}`

**Error codes:** `missing_credential` · `not_logged_in` · `quota_limit` · `rate_limit` · `network_transient` · `model_unavailable` · `context_too_large` · `permission_denied` · `tool_error` · `internal_error`

**Exit codes:** `0` completed · `1` terminal · `2` recoverable · `124` SIGTERM

Full contract chi tiết: [**Releases v0.2.0-p2 →**](https://github.com/tranhieu860/AHVclaw/releases/tag/v0.2.0-p2)

## 🔄 Update tự động

`ahv update` tự pull latest commit + tag, cài lại deps, rebuild lib, refresh skin, bake version file. Không phải re-clone.

```bash
$ ahv update
[ahv update] pulling latest từ github.com/tranhieu860/AHVclaw
Fast-forward — 3 files changed, 98 insertions(+), 26 deletions(-)
✓ built in 2.8s
[ahv update] done → v0.2.0-p2
```

Rollback dễ: `git -C ~/.ahv/src reset --hard v0.2.0-p1 && pnpm install`.

## 📊 So với các CLI khác

| | AHV CLI | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|---|
| Cài | curl 1 dòng | curl 1 dòng | npm | brew/npm |
| Provider | Multi (5+ router) | Anthropic only | OpenAI only | Google only |
| Subscription login | ✅ Grok/Codex/Claude | — | ✅ Codex | — |
| Plugin ecosystem | 50+ (dshmarket 1.5k+) | — | — | — |
| Persistent PTY | ✅ | — | — | — |
| Session resume | ✅ genuine | ✅ | ✅ | ✅ |
| Bot JSONL contract | ✅ pin tag | — | — | — |
| Tiếng Việt-first | ✅ | — | — | — |

## 🌐 Links

- **Landing + install:** [ahvclaw.com](https://ahvclaw.com)
- **Web UI live:** [ahv.ahvclaw.com](https://ahv.ahvclaw.com)
- **Plugin registry (version tracking):** [ahvclaw.com/admin](https://ahvclaw.com/admin)
- **GitHub Releases:** [github.com/tranhieu860/AHVclaw/releases](https://github.com/tranhieu860/AHVclaw/releases)
- **Owner:** [tranhieu860@gmail.com](mailto:tranhieu860@gmail.com)

## 📁 Về repo này

Soft-fork của [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) — giữ nguyên workspace/vendor upstream để merge không xung đột.

AHV overlay ở:
- `packages/bundle/ahv/` — bundle config (LLM router, persona, plugin insert, bot runner)
- `scripts/prod/` — deployment snapshots (install.sh, wrapper, systemd, admin backend)
- `apps/cli/` — `ahv` bin alias

Phần còn lại (`vendor/ docs/ examples/ python/ native/ website/ patches/`) là upstream — hide khỏi GitHub language stats qua `.gitattributes`.

Xem [PULLING_UPSTREAM.md](./PULLING_UPSTREAM.md) cho quy trình merge upstream. Full dev doc: [AGENTS.md](./AGENTS.md).

## 📜 License

MIT (giữ nguyên upstream). "DeepSeek Harness" là trademark của DeepSeek — AHV dùng tên "AHV" cho fork, không dùng trademark trực tiếp.

<div align="center">

Made with ❤ by [Hiếu](mailto:tranhieu860@gmail.com) · Vietnam

</div>
