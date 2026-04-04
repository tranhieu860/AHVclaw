<div align="center">

# 🧠 AHVclaw

### Autonomous AI Agent Platform

*An intelligent, self-improving AI system with autonomous decision-making, multi-channel communication, and cognitive memory.*

[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white)](https://postgresql.org)
[![License](https://img.shields.io/badge/License-Proprietary-red)]()
[![Version](https://img.shields.io/badge/Version-1.0.0-blue)]()

---

**20,500+ lines of Go** · **8,500+ lines of TypeScript** · **45 database tables** · **22 AI tools** · **116 Go source files**

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Configuration](#-configuration)
- [API Reference](#-api-reference)
- [Autonomous System](#-autonomous-system)
- [Security](#-security)
- [Roadmap](#-roadmap)

---

## 🌟 Overview

AHVclaw is an **autonomous AI agent platform** built from the ground up in Go. It goes beyond simple chatbots by implementing a full cognitive architecture with:

- **Proactive intelligence** — The system wakes up every 5 minutes to monitor, analyze, and act
- **Self-reflection** — Daily AI-powered analysis of its own performance with pattern detection
- **Trust-based autonomy** — A dynamic trust scoring system that learns which actions to auto-execute vs. ask for approval
- **Cognitive memory** — Vector-based semantic search with cross-referencing and automatic consolidation
- **Multi-channel presence** — Simultaneously active on Web, Telegram, Zalo, and Discord

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (Next.js 16)                 │
│  Chat · Dashboard · Servers · Inbox · Settings · Bots   │
└───────────────────────┬─────────────────────────────────┘
                        │ WebSocket + REST
┌───────────────────────┴─────────────────────────────────┐
│                   Backend (Go Fiber v2)                  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ Handlers │ │  Engine   │ │ Channels │ │   Tools   │  │
│  │ (80+ API)│ │ (Chat    │ │ (Telegram│ │ (22 tools)│  │
│  │          │ │  Loop)   │ │  Zalo    │ │           │  │
│  │          │ │          │ │  Discord │ │           │  │
│  │          │ │          │ │  Web)    │ │           │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │Autonomous│ │ Cognitive│ │ Security │ │    AI     │  │
│  │(Heartbeat│ │ (RAG +   │ │(Injection│ │ (Router + │  │
│  │ Reflect  │ │  Vector  │ │ Scrubber │ │  Pool +   │  │
│  │ Alerter  │ │  Search) │ │ Policy)  │ │  Combos)  │  │
│  │ Planner) │ │          │ │          │ │           │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │  Audio   │ │ Browser  │ │   SSH    │ │   MCP     │  │
│  │(TTS+STT) │ │(Playwrt) │ │(Manager) │ │ (Bridge)  │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────┴─────────────────────────────────┐
│            PostgreSQL 16 + pgvector (45 tables)         │
└─────────────────────────────────────────────────────────┘
```

---

## ✨ Features

### 🤖 AI Engine
| Feature | Description |
|---------|-------------|
| **Multi-round Tool Loop** | Up to 10 rounds of tool calls per conversation turn |
| **Smart Model Routing** | Connection pool with 4 strategies: round-robin, least-used, priority, cost-optimized |
| **Model Combos** | Chain multiple models with fallback strategies |
| **Streaming** | Real-time SSE streaming for all AI responses |
| **Context Management** | Automatic token estimation, truncation, and summarization |
| **Response Verification** | AI response quality checks with auto-retry |
| **Extended Thinking** | Support for thinking blocks with confidence analysis |

### 🧰 Tool System (22 Tools)
| Category | Tools |
|----------|-------|
| **File Operations** | `file_read`, `file_write`, `file_list`, `file_delete`, `file_search` |
| **Execution** | `terminal_exec`, `server_ssh_exec` |
| **Server Management** | `server_list`, `server_status` |
| **Network** | `http_request` |
| **Browser Automation** | `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_extract` |
| **Memory** | `memory_save`, `memory_search` |
| **Knowledge** | `knowledge_search` |
| **Scheduling** | `manage_scheduled_task` |
| **Delegation** | `delegate_agent` |
| **Skills** | `skill_install` |
| **Files** | `send_file` |

### 🧠 Autonomous System
| Component | Interval | Description |
|-----------|----------|-------------|
| **Heartbeat** | Every 5 min | Proactive monitoring, checks, and actions |
| **Reflection** | Daily | AI self-analysis with lessons, patterns, and goals |
| **Alerter** | On heartbeat | 7 built-in rules with 30-min dedup |
| **Auto-Planner** | On goal creation | Breaks goals into scheduled cron tasks |
| **Trust System** | Continuous | Dynamic trust scoring (execute/notify/ask/block) |
| **Mood Analysis** | Per message | Sentiment, urgency, energy, emotion detection |
| **Daily Digest** | Daily | Automated summary of actions, goals, and patterns |
| **Consolidation** | Daily | Memory dedup, stale pruning, cross-ref discovery |

### 🔊 Voice System
| Feature | Provider |
|---------|----------|
| **Text-to-Speech** | MiniMax Speech-02-HD (sync + streaming) |
| **Speech-to-Text** | 3-provider fallback: Whisper → Groq → Google Speech |
| **Auto Voice Reply** | Configurable per user |
| **Audio Transcription** | Multi-format support (ogg, mp3, wav, webm, m4a) |

### 📬 Multi-Channel
| Channel | Features |
|---------|----------|
| **Web** | WebSocket streaming, file attachments, inline tools |
| **Telegram** | Full bot with voice messages, files, typing indicator |
| **Zalo** | OA integration with message/file support |
| **Discord** | Bot with message routing |

### 📥 Inbox & CRM
- Human takeover / release conversations
- Agent assignment per conversation
- Contact management with multi-channel identity merge
- Conversation archiving

### 🧬 Cognitive Memory (RAG)
- **5 source types**: messages, memories, reflections, patterns, goals
- **Semantic search** with pgvector embeddings
- **Recency weighting** with 7-day half-life exponential decay
- **Cross-reference boost** for related entries
- **Daily consolidation**: dedup, stale pruning, AI-discovered relationships
- **Automatic backfill** of un-embedded messages on startup

### 🔒 Security
| Layer | Description |
|-------|-------------|
| **Injection Detection** | Pattern-based scoring (threshold 30/100) with 8 jailbreak patterns |
| **Credential Scrubbing** | 10 regex patterns detect and redact API keys, tokens, passwords |
| **Tool Policy** | 11 dangerous shell patterns blocked, sensitive path protection |
| **Trust Scoring** | Per-action trust levels with escalation/deescalation and 30-day decay |
| **AES-256-GCM** | Encryption for all stored credentials |
| **JWT + API Key** | Dual authentication with auto-refresh |

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Backend** | Go 1.23, Fiber v2, pgx v5 |
| **Frontend** | Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, Zustand 5 |
| **Database** | PostgreSQL 16 + pgvector |
| **Browser** | Playwright (headless Chromium) |
| **AI Models** | Multi-provider: OpenAI, Anthropic, Google Gemini, MiniMax, custom vLLM |
| **TTS** | MiniMax Speech-02-HD |
| **STT** | OpenAI Whisper, Groq, Google Speech |
| **Auth** | JWT (HS256) + API keys + AES-256-GCM |

---

## 📁 Project Structure

```
ahvclaw/
├── backend/                    # Go backend (20,500+ LOC)
│   ├── main.go                 # Entry point, routes, middleware
│   ├── ai/                     # AI model routing & connection pool
│   │   ├── router.go           # LLM streaming client
│   │   ├── connection_pool.go  # Smart multi-model rotation
│   │   ├── anthropic.go        # Anthropic API adapter
│   │   └── registry.go         # Provider type registry
│   ├── autonomous/             # Autonomous agent system
│   │   ├── heartbeat.go        # 5-min proactive daemon
│   │   ├── reflection.go       # Daily self-analysis
│   │   ├── alerter.go          # Pattern-based alerting
│   │   ├── auto_plan.go        # Goal → task decomposition
│   │   ├── goal_extract.go     # Goal extraction from conversations
│   │   ├── trust.go            # Trust scoring system
│   │   ├── mood.go             # Mood & sentiment analysis
│   │   ├── digest.go           # Daily digest generation
│   │   └── proactive.go        # Goals & patterns CRUD
│   ├── cognitive/              # Cognitive RAG system
│   │   ├── embed.go            # Vector embedding pipeline
│   │   ├── retrieve.go         # Semantic search with scoring
│   │   ├── consolidate.go      # Memory consolidation
│   │   └── crossref.go         # Cross-reference graph
│   ├── engine/                 # Chat processing engine
│   │   ├── engine.go           # Multi-round tool loop
│   │   ├── context.go          # Token management
│   │   ├── verify.go           # Response verification
│   │   ├── thinking.go         # Thinking block parser
│   │   ├── silence_detector.go # Unanswered message retry
│   │   └── summarize.go        # Auto-summarization
│   ├── tools/                  # 22 AI tools
│   ├── handlers/               # 80+ API handlers
│   ├── channels/               # Multi-channel adapters
│   │   ├── telegram/           # Telegram bot
│   │   ├── zalo/               # Zalo OA
│   │   └── discord/            # Discord bot
│   ├── audio/                  # TTS & STT
│   ├── browser/                # Playwright automation
│   ├── security/               # Injection, scrubber, policy
│   ├── mcp/                    # Model Context Protocol bridge
│   ├── scheduler/              # Cron task scheduler
│   ├── db/                     # Database & migrations
│   ├── auth/                   # JWT & middleware
│   ├── crypto/                 # AES-256-GCM encryption
│   └── ssh/                    # SSH client manager
│
├── frontend/                   # Next.js 16 frontend (8,500+ LOC)
│   └── src/
│       ├── app/                # Pages (chat, servers, settings, ...)
│       ├── components/         # React components (20+)
│       └── lib/                # API client, store, utilities
│
├── .gitignore
├── backup.sh                   # Database backup script
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- Go 1.23+
- Node.js 20+
- PostgreSQL 16 with pgvector extension
- Playwright (for browser automation)

### Backend Setup

```bash
cd backend

# Copy environment config
cp .env.example .env
# Edit .env with your database credentials and API keys

# Run database migrations (auto on startup)
go build -o ahvclaw-api .
./ahvclaw-api
```

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Configure API URL
echo 'NEXT_PUBLIC_API_URL=http://localhost:3101' > .env.local

# Build and run
npm run build
npm start
```

### Systemd Services

```ini
# /etc/systemd/system/ahvclaw-api.service
[Unit]
Description=AHVclaw API
After=postgresql.service

[Service]
WorkingDirectory=/opt/ahvclaw/backend
ExecStart=/opt/ahvclaw/backend/ahvclaw-api
Restart=always
User=ahvclaw

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/ahvclaw-frontend.service
[Unit]
Description=AHVclaw Frontend
After=ahvclaw-api.service

[Service]
WorkingDirectory=/opt/ahvclaw/frontend
ExecStart=/usr/bin/npm start
Restart=always
User=ahvclaw
Environment=PORT=3100

[Install]
WantedBy=multi-user.target
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DB_HOST` | PostgreSQL host | ✅ |
| `DB_PORT` | PostgreSQL port | ✅ |
| `DB_USER` | Database user | ✅ |
| `DB_PASS` | Database password | ✅ |
| `DB_NAME` | Database name | ✅ |
| `JWT_SECRET` | JWT signing secret | ✅ |
| `ENCRYPTION_KEY` | AES-256 encryption key | ✅ |
| `ROUTER_URL` | AI router URL | ✅ |
| `ROUTER_API_KEY` | AI router API key | ✅ |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Optional |
| `MINIMAX_API_KEY` | MiniMax TTS API key | Optional |
| `STT_URL` | STT endpoint URL | Optional |
| `STT_API_KEY` | STT API key | Optional |

---

## 📡 API Reference

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/auth/me` | Get current user |

### Conversations & Chat
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/conversations` | List conversations |
| GET | `/api/conversations/:id` | Get conversation with messages |
| DELETE | `/api/conversations/:id` | Delete conversation |
| WS | `/ws/chat` | WebSocket chat (streaming) |
| WS | `/ws/events` | Real-time event stream |

### Autonomous Agent
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/autonomous/status` | Heartbeat status & config |
| PUT | `/api/autonomous/config` | Update heartbeat config |
| POST | `/api/autonomous/stop` | Pause autonomous agent |
| POST | `/api/autonomous/resume` | Resume autonomous agent |
| GET | `/api/goals` | List goals |
| GET | `/api/reflections` | List reflections |
| GET | `/api/patterns` | List detected patterns |
| GET | `/api/trust` | List trust permissions |

### Servers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/servers` | List servers |
| POST | `/api/servers` | Register server |
| GET | `/api/servers/:id/conversation` | Get/create server chat |

### Knowledge & Memory
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge-bases` | List knowledge bases |
| POST | `/api/knowledge-bases/:id/search` | Search knowledge base |
| GET | `/api/cognitive/search` | Semantic cognitive search |
| GET | `/api/cognitive/stats` | Cognitive memory stats |
| GET | `/api/cognitive/graph` | Cross-reference graph |

### Voice
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/voice/settings` | Get voice settings |
| PUT | `/api/voice/settings` | Update voice settings |
| POST | `/api/voice/test-tts` | Test TTS |
| POST | `/api/voice/test-stt` | Test STT |
| POST | `/api/voice/transcribe` | Transcribe audio |
| POST | `/api/voice/synthesize` | Synthesize speech |

### Bots & Channels
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bots` | List bots |
| POST | `/api/bots` | Create bot |
| POST | `/api/bots/:id/start` | Start bot |
| POST | `/api/bots/:id/stop` | Stop bot |

### Inbox (CRM)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inbox` | List inbox conversations |
| POST | `/api/inbox/:id/reply` | Reply to conversation |
| POST | `/api/inbox/:id/takeover` | Human takeover |
| POST | `/api/inbox/:id/release` | Release to bot |

*... and 30+ more endpoints for contacts, providers, connections, combos, tasks, projects, skills, admin, etc.*

---

## 🤖 Autonomous System

### How it works

```
Every 5 minutes:
  ┌─────────────┐
  │  Heartbeat   │ ──→ Check servers, run tools, monitor systems
  └──────┬──────┘
         │ outputs
  ┌──────┴──────┐
  │   Alerter    │ ──→ Evaluate 7 alert rules, notify if triggered
  └──────┬──────┘
         │
  ┌──────┴──────┐
  │  Cognitive   │ ──→ Embed results into vector memory
  └─────────────┘

Once daily:
  ┌─────────────┐
  │  Reflection  │ ──→ Analyze day's actions, extract patterns & goals
  └──────┬──────┘
         │
  ┌──────┴──────┐
  │ Auto-Planner │ ──→ Break new goals into scheduled tasks
  └──────┬──────┘
         │
  ┌──────┴──────┐
  │Consolidation │ ──→ Dedup memory, prune stale, discover cross-refs
  └──────┬──────┘
         │
  ┌──────┴──────┐
  │   Digest     │ ──→ Generate daily summary report
  └─────────────┘
```

### Trust Scoring

Actions are classified into trust levels:

| Trust Score | Decision | Description |
|-------------|----------|-------------|
| 8-10 | `execute` | Auto-execute without asking |
| 4-7 | `notify` | Execute and notify user |
| 1-3 | `ask` | Ask user for approval first |
| 0 | `block` | Block the action |

- **Escalation**: +2 score when user approves (max 10)
- **Deescalation**: -3 score when user rejects (min 0)
- **Decay**: -1 score after 30 days of inactivity

---

## 🔒 Security

- **Prompt Injection Detection** — 8 jailbreak patterns scored 0-100, blocked at ≥30
- **Credential Scrubbing** — 10 regex patterns detect and redact API keys, tokens, passwords
- **Tool Policy Engine** — 11 dangerous shell patterns blocked, sensitive paths protected
- **Trust-based Execution** — Dynamic per-action trust scores control autonomy level
- **AES-256-GCM Encryption** — All stored credentials encrypted at rest
- **JWT Authentication** — Short-lived access tokens (15 min) with refresh rotation
- **API Key Support** — Alternative auth for programmatic access
- **UFW Firewall** — API bound to localhost, Nginx reverse proxy for external access

---

## 🗺 Roadmap

- [x] Core chat engine with multi-round tool loop
- [x] Multi-channel (Telegram, Zalo, Discord, Web)
- [x] Autonomous heartbeat, reflection, and alerting
- [x] Cognitive RAG with vector search and consolidation
- [x] Trust-based autonomy system
- [x] Voice (TTS + STT)
- [x] Browser automation (Playwright)
- [x] Server management via SSH
- [x] MCP bridge (basic)
- [ ] Web search tools (Brave/DuckDuckGo)
- [ ] Document reader (PDF, DOCX)
- [ ] Image generation
- [ ] Agent teams with inter-agent communication
- [ ] OAuth provider integration (ChatGPT, Claude CLI)
- [ ] Advanced MCP with external tool discovery
- [ ] Mobile app

---

## 📊 Stats

| Metric | Value |
|--------|-------|
| Backend LOC | 20,500+ |
| Frontend LOC | 8,500+ |
| Go Source Files | 116 |
| Go Packages | 25 |
| API Endpoints | 80+ |
| Database Tables | 45 |
| AI Tools | 22 |
| Autonomous Components | 8 |

---

<div align="center">

**Built with ❤️ by AHV Holding**

*AHVclaw — Where AI becomes autonomous.*

</div>
