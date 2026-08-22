# AHV CLI

[![Latest](https://img.shields.io/github/v/tag/tranhieu860/AHVclaw?label=latest&color=06b6d4)](https://github.com/tranhieu860/AHVclaw/releases/latest)
[![Website](https://img.shields.io/badge/site-ahvclaw.com-06b6d4)](https://ahvclaw.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

**Agentic dev terminal cho developer Việt.** Cài 1 dòng, gõ `ahv`, có ngay
tool-calling REPL + 50+ plugin (persistent terminal, Plugin Market
1.5k+ community, 14 Superpowers skill, ChatGPT/Claude/Grok subscription
providers, bot JSONL adapter).

## Cài

```bash
curl -fsSL https://ahvclaw.com/install.sh | bash
```

Yêu cầu Node ≥22. Cần API key AHV Router — [xin miễn phí](https://ahvclaw.com/apply).

## Dùng

```bash
ahv "task"                  # one-shot chat
ahv web                     # web UI local :3080
ahv update                  # pull latest + rebuild
ahv login url grok          # OAuth Grok Premium
ahv models list --json      # full harness catalog
```

## Cho bot / automation

Pin tag → JSONL contract stable:

```bash
git -C ~/.ahv/src checkout v0.2.0-p2
ahv run --prompt-file X --cwd DIR --output jsonl --session-id ID
```

Contract chi tiết: [Releases v0.2.0-p2](https://github.com/tranhieu860/AHVclaw/releases/latest).

## Links

- **Docs & install:** <https://ahvclaw.com>
- **Web UI live:** <https://ahv.ahvclaw.com>
- **Plugin registry (version tracking):** <https://ahvclaw.com/admin>
- **Owner:** tranhieu860@gmail.com

## Về repo này

Soft-fork của [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).
AHV overlay ở `packages/bundle/ahv/`, `scripts/prod/`, `apps/cli/`. Phần
còn lại (`vendor/`, `docs/`, `examples/`, `python/`, `native/`,
`website/`) là upstream, giữ nguyên để merge upstream không xung đột —
xem [PULLING_UPSTREAM.md](./PULLING_UPSTREAM.md).

Full dev doc upstream: [AGENTS.md](./AGENTS.md).

MIT License. "DeepSeek Harness" là trademark của DeepSeek — AHV dùng
tên "AHV" cho fork của mình, không dùng trademark trực tiếp.
