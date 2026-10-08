# 🎙️ AlwaysVoiceBot

A lightweight, modular Discord self-bot written in **TypeScript** designed to maintain a persistent presence in a specific voice channel. Built with a **fail-fast** architecture — any connection drop, invalid session, or unhandled exception will terminate the process, relying on Docker's `restart: unless-stopped` policy (or a process manager) for automatic recovery.

## ✨ Features

- **Auto-Join Voice Channel** — Automatically connects and stays inside a configured voice channel.
- **Auto-Rejoin** — Reconnects automatically if disconnected from voice (with a 5-second backoff).
- **Auto-Watch Streaming** — Automatically detects screen share / Go Live streams in the channel and watches them (OP 20 `STREAM_WATCH`) with zero video decoding overhead.
- **Voice Limit** — Monitors channel occupancy; leaves if user count exceeds `VOICE_LIMIT`, and rejoins once it is safe.
- **Auto-Reply (Static)** — Replies with a predefined message when mentioned with a trigger phrase.
- **Session Resume** — Automatically attempts to resume existing Discord Gateway sessions on reconnection.
- **Modular TypeScript Architecture** — Completely decoupled modules for Gateway, Voice, Auto-Reply, Stream Watcher, and Configuration.
- **Structured Scoped Logging** — Colorized, padded, scoped log output with configurable log filtering.

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
   Edit `.env` with your Discord token, guild ID, and voice channel ID.

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
│   ├── gateway/
│   │   ├── gateway-client.ts   # Discord Gateway WSS client (v10) & event emitter
│   │   ├── heartbeat.ts        # Heartbeat manager (OP 1)
│   │   └── session.ts          # Gateway session state (resume tokens & sequence)
│   ├── voice/
│   │   └── voice-manager.ts    # Voice channel join/leave & population limit tracking
│   ├── features/
│   │   ├── auto-reply.ts       # Mention-based static auto-reply service
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
