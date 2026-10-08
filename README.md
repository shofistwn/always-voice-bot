# 🎙️ AlwaysVoiceBot

A lightweight, modular Discord self-bot written in **TypeScript** designed to maintain a persistent presence in a specific voice channel. Built with a **fail-fast** architecture — any connection drop, invalid session, or unhandled exception will terminate the process, relying on Docker's `restart: unless-stopped` policy (or a process manager) for automatic recovery.

## ✨ Features

- **Auto-Join Voice Channel** — Automatically connects and stays inside a configured voice channel.
- **Auto-Rejoin** — Reconnects automatically if disconnected from voice (with a 5-second backoff).
- **Music Bot (Powered by NodeLink)** — Plays songs and playlists directly in voice with real-time text commands (`!play`, `!skip`, `!queue`, etc.) via a lightweight [NodeLink](https://github.com/PerformanC/NodeLink) standalone audio node.
- **Auto-Watch Streaming** — Automatically detects screen share / Go Live streams in the channel and watches them (OP 20 `STREAM_WATCH`) with zero video decoding overhead.
- **Voice Limit** — Monitors channel occupancy; leaves if user count exceeds `VOICE_LIMIT`, and rejoins once it is safe.
- **Auto-Reply (Static)** — Replies with a predefined message when mentioned with a trigger phrase.
- **Smart Wake-Up (Deafen Toggle)** — When mentioned with trigger phrase while `SELF_DEAF=True`, automatically undeafens the bot for a random duration (default 5–15 minutes) before re-deafening.
- **Modular TypeScript Architecture** — Completely decoupled modules for Gateway, Voice, Auto-Reply, Stream Watcher, Music/NodeLink, Cache, and Configuration.
- **Structured Scoped Logging** — Colorized, padded, scoped log output with configurable log filtering and entity name resolution.

## 🚀 Quick Start

### Prerequisites

- [Docker & Docker Compose](https://www.docker.com/) or [Podman & Podman Compose](https://podman.io/) (recommended) OR [Node.js](https://nodejs.org/) v20+
- A Discord user token

### Setup with Docker / Podman (Recommended)

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

3. Start the bot and NodeLink server:
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

## 🎵 Music Commands

Control music playback directly through Discord text chat using the configured prefix (default `!`):

| Command | Alias | Description |
|---|---|---|
| `!play <query/url>` | `!p` | Search and play a song or add a playlist to queue. |
| `!stop` | | Stop playback, clear the queue, and restore voice mute. |
| `!skip` | `!s` | Skip to the next song in the queue. |
| `!pause` | | Pause current playback. |
| `!resume` | | Resume paused playback. |
| `!queue` | `!q` | View currently playing track and upcoming songs. |
| `!nowplaying` | `!np` | View details and link of the current track. |
| `!volume <0-100>` | `!vol` | Adjust playback volume. |
| `!help` | | Display the list of music commands. |

## ⚙️ Configuration

All configuration is handled via environment variables in the `.env` file:

### Core Settings

| Variable | Default | Description |
|---|---|---|
| `TOKEN` | *(required)* | Your Discord user token. |
| `GUILD_ID` | *(required)* | Target server (guild) ID. |
| `CHANNEL_ID` | *(required)* | Target voice channel ID. |
| `STATUS` | `dnd` | Online status (`online`, `idle`, `dnd`, `invisible`). |
| `SELF_MUTE` | `True` | Mute yourself in the voice channel (auto un-mutes during music). |
| `SELF_DEAF` | `False` | Deafen yourself in the voice channel. |
| `LOG_LEVEL` | `info` | Minimum log level (`debug`, `info`, `warn`, `error`). |
| `AUTO_WATCH_STREAM` | `True` | Automatically watch screen shares / Go Live streams in the channel. |

### Music (NodeLink) Settings

| Variable | Default | Description |
|---|---|---|
| `MUSIC_ENABLED` | `True` | Enable/disable music playback and chat commands. |
| `MUSIC_PREFIX` | `!` | Prefix for music text commands in chat. |
| `NODELINK_HOST` | `nodelink` | Host address of the NodeLink server (`localhost` if running locally). |
| `NODELINK_PORT` | `2333` | Port of the NodeLink server. |
| `NODELINK_PASSWORD` | `youshallnotpass` | Authorization password for NodeLink. |

### Voice Limit

| Variable | Default | Description |
|---|---|---|
| `VOICE_LIMIT` | `0` | Max users before leaving (0 = disabled). Leaves if count > limit, rejoins when count < limit. |

### Auto-Reply (Static) & Wake-Up

| Variable | Default | Description |
|---|---|---|
| `AUTO_REPLY` | `False` | Enable/disable static auto-reply. |
| `REPLY_TRIGGER` | `hey wake up!` | Trigger phrase (case-insensitive) to send the reply. |
| `REPLY_MESSAGE` | `yes` | Static reply message content. |
| `REPLY_DELAY` | `5` | Seconds to wait before replying. |
| `UNDEAFEN_MIN_SECONDS` | `300` | Minimum duration (seconds) to stay undeafened when woken up (default: 5m). |
| `UNDEAFEN_MAX_SECONDS` | `900` | Maximum duration (seconds) to stay undeafened when woken up (default: 15m). |

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
│   │   └── voice-manager.ts    # Voice channel join/leave & temporary undeafen logic
│   ├── features/
│   │   ├── auto-reply.ts       # Mention-based static auto-reply service
│   │   ├── stream-watcher.ts   # Go Live / Screen share auto-viewer (OP 20)
│   │   └── music/
│   │       ├── nodelink-client.ts # NodeLink WebSocket & Lavalink v4 REST client
│   │       └── music-service.ts   # Queue manager & chat command parser
│   ├── logger/
│   │   └── index.ts            # Colorized timestamped scoped logger
│   └── types/
│       ├── config.ts           # Bot configuration interfaces
│       ├── discord.ts          # Discord Gateway and event payload types
│       └── nodelink.ts         # Lavalink v4 / NodeLink track and player types
├── Dockerfile                  # Multi-stage container image (Node.js 22 Alpine)
├── docker-compose.yml          # Docker Compose orchestration (Bot + NodeLink)
├── Makefile                    # Workflow command automation (auto-detects docker/podman)
├── package.json                # Project dependencies & scripts
└── tsconfig.json               # TypeScript compiler configuration
```

### Fail-Fast Strategy

The bot deliberately avoids complex nested retry loops. Fatal gateway states or unhandled network crashes trigger immediate process termination (`process.exit(1)`). When deployed in Docker/Podman, `restart: unless-stopped` provides instant, clean recovery.

| Event | Action |
|---|---|
| OP 7 (Reconnect) | `process.exit(1)` → Container restart |
| OP 9 (Invalid Session) | `process.exit(1)` → Container restart |
| WebSocket closed unexpectedly | `process.exit(1)` → Container restart |
| Voice disconnected | Auto-rejoins after a 5-second delay |

## ⚠️ Disclaimer

This is a **self-bot** that uses a Discord user account token for automation. Automating user accounts violates [Discord's Terms of Service](https://discord.com/terms). Use at your own risk.

## 📄 License

This project is for personal and educational use only.
