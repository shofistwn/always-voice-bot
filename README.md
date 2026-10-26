# 🎙️ AlwaysVoiceBot

A lightweight, modular Discord self-bot written in **TypeScript** designed to maintain a persistent presence in a voice channel. Built with a **fail-fast** architecture — any connection drop, invalid session, or unhandled exception will terminate the process, relying on Docker's `restart: unless-stopped` policy (or a process manager) for automatic recovery.

## ✨ Features

- **Auto-Rejoin** — Reconnects automatically if disconnected from voice (with a 5-second backoff).
- **Auto-Watch Streaming** — Automatically detects screen share / Go Live streams in the channel and watches them (OP 20 `STREAM_WATCH`) with zero video decoding overhead.
- **Voice Limit** — Monitors channel occupancy; leaves if user count exceeds `VOICE_LIMIT`, and rejoins once it is safe.
- **Auto-Reply (Static)** — Replies with a predefined message when mentioned with a trigger phrase.
- **OwO Quest Assistant** — Natural language assistant for OwO bot daily quests (cookie, pray, curse) with multiplier support (`3x`, `3 kali`), 5-second battle duel auto-accept (`wb @mention`, `owob @mention`, `owo b @mention`), restart resilience, and concurrency mutex locks to prevent race conditions.
- **Modular TypeScript Architecture** — Decoupled modules for Gateway, Voice, Auto-Reply, Stream Watcher, OwO Assistant, Cache, and Configuration.
- **Structured Scoped Logging** — Colorized, padded, scoped log output with configurable log filtering and entity name resolution.

## 🚀 Quick Start

### Prerequisites

- [Docker & Docker Compose](https://www.docker.com/) (recommended) OR [Node.js](https://nodejs.org/) v20+
- A Discord user token

### Setup with Docker (Recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/shofistwn/always-voice-bot.git
   cd always-voice-bot
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your Discord token, guild ID, and channel ID.

3. Start the bot:
   ```bash
   make up
   ```

### Setup Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build TypeScript:
   ```bash
   npm run build
   ```

3. Start the bot:
   ```bash
   npm start
   ```
   *(Or run in development mode with `npm run dev`)*

## ⚙️ Configuration

All configuration is handled via environment variables in the `.env` file:

### Core Settings

| Variable | Default | Description |
|---|---|---|
| `TOKEN` | *(required)* | Your Discord user token. |
| `GUILD_ID` | *(required)* | Target server (guild) ID. |
| `CHANNEL_ID` | *(required)* | Target voice channel ID. |
| `STATUS` | `dnd` | Online status (`online`, `idle`, `dnd`, `invisible`). |
| `SELF_MUTE` | `True` | Mute yourself in the voice channel. |
| `SELF_DEAF` | `False` | Deafen yourself in the voice channel. |
| `LOG_LEVEL` | `info` | Minimum log level (`debug`, `info`, `warn`, `error`). |
| `AUTO_WATCH_STREAM` | `True` | Automatically watch screen shares / Go Live streams in the channel. |

### Voice Limit

| Variable | Default | Description |
|---|---|---|
| `VOICE_LIMIT` | `0` | Max users before leaving (0 = disabled). Leaves if count > limit, rejoins when count < limit. |

### Auto-Reply (Static)

| Variable | Default | Description |
|---|---|---|
| `AUTO_REPLY` | `False` | Enable/disable static auto-reply. |
| `REPLY_TRIGGER` | `hey wake up!` | Trigger phrase (case-insensitive) to send the reply. |
| `REPLY_MESSAGE` | `yes` | Static reply message content. |
| `REPLY_DELAY` | `5` | Seconds to wait before replying. |

### OwO Quest Assistant

| Variable | Default | Description |
|---|---|---|
| `OWO_ASSISTANT` | `True` | Enable/disable OwO Quest Assistant. Commands are automatically dispatched to whatever channel the bot is mentioned in. |

#### Usage & Natural Commands

Mention the bot in text chat to trigger quests dynamically targeting yourself:
- **Cookie**: `@Bot kasih gw cookie`, `@Bot bagi kue dong`, `@Bot cookie 2x`
- **Pray**: `@Bot bantu pray dong`, `@Bot pray gw 3x`, `@Bot bantu pray 3 kali`
- **Curse**: `@Bot bantu curse 2x`, `@Bot tolong curse`
- **Battle Duel Accept**: Saat ada yang mengirim `wb @Bot`, `owob @Bot`, atau `owo b @Bot`, bot memberi jeda 5 detik lalu membalas dengan `owo ab` di channel tersebut.

#### Resilience & Cooldown Handling
- **Restart Resilience**: Queue progress and `nextRun` timestamps are persistently stored in `owo-queue.json`. If the bot restarts or crashes mid-queue, pending tasks resume accurately based on elapsed cooldown time.
- **Race Condition Prevention**: Employs an execution mutex and global cooldown tracking so that pray/curse commands respect OwO's 5-minute cooldown pool without concurrent conflict.
- **Humanized Simulation**: Random jitter (5–15s) and realistic Discord typing indicators are simulated prior to sending commands.

## 🏗️ Project Architecture

```
always-voice-bot/
├── src/
│   ├── index.ts                # Application entry point & process signal handling
│   ├── bot.ts                  # Bot orchestrator connecting modules
│   ├── config/
│   │   └── index.ts            # Environment loader & typed config parser
│   ├── constants/
│   │   └── discord.ts          # Gateway opcodes, URLs, and intents
│   ├── cache/
│   │   └── entity-cache.ts     # In-memory channel and username resolver
│   ├── gateway/
│   │   ├── gateway-client.ts   # Discord Gateway WSS client (v10) & event emitter
│   │   └── heartbeat.ts        # Heartbeat manager (OP 1)
│   ├── voice/
│   │   └── voice-manager.ts    # Voice channel join/leave logic
│   ├── features/
│   │   ├── auto-reply.ts       # Mention-based static auto-reply service
│   │   ├── owo-assistant.ts    # OwO quest helper & battle challenge auto-accept
│   │   └── stream-watcher.ts   # Go Live / Screen share auto-viewer (OP 20)
│   ├── logger/
│   │   └── index.ts            # Colorized timestamped scoped logger
│   └── types/
│       ├── config.ts           # Bot configuration interfaces
│       └── discord.ts          # Discord Gateway and event payload types
├── Dockerfile                  # Multi-stage container image (Node.js 22 Alpine)
├── docker-compose.yml          # Docker Compose orchestration
├── Makefile                    # Workflow command automation
├── package.json                # Project dependencies & scripts
└── tsconfig.json               # TypeScript compiler configuration
```

### Fail-Fast Strategy

The bot deliberately avoids complex nested retry loops. Fatal gateway states or unhandled network crashes trigger immediate process termination (`process.exit(1)`). When deployed in Docker, `restart: unless-stopped` provides instant, clean recovery.

| Event | Action |
|---|---|
| OP 7 (Reconnect) | `process.exit(1)` → Docker restart |
| OP 9 (Invalid Session) | `process.exit(1)` → Docker restart |
| WebSocket closed unexpectedly | `process.exit(1)` → Docker restart |
| Voice disconnected | Auto-rejoins after a 5-second delay |

## ⚠️ Disclaimer

This is a **self-bot** that uses a Discord user account token for automation. Automating user accounts violates [Discord's Terms of Service](https://discord.com/terms). Use at your own risk.

## 📄 License

This project is for personal and educational use only.
