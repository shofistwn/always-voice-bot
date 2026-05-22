# 🎙️ AlwaysVoiceBot

A Discord self-bot designed to maintain a persistent presence in a specific voice channel. Built with a **fail-fast** architecture — any connection drop or unhandled exception will terminate the process, relying on Docker's `restart: unless-stopped` policy for automatic recovery.

## Features

- **Auto-Join Voice Channel** — Automatically joins and stays in a configured voice channel
- **Auto-Rejoin** — Reconnects if disconnected (with a 5-second delay)
- **Voice Limit** — Leaves the channel if user count exceeds a configurable limit
- **Auto-Reply** — Responds to messages when mentioned with a trigger phrase
- **Rich Presence** — Displays custom activity status (e.g., promoting your service)
- **Session Resume** — Attempts to resume sessions instead of creating new ones

## Quick Start

### Prerequisites

- Docker & Docker Compose
- A Discord user token

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/shofistwn/always-voice-bot.git
   cd always-voice-bot
   ```

2. Copy and configure environment variables:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env` with your configuration (see [Configuration](#configuration)).

4. Start the bot:

   ```bash
   make up
   ```

### Makefile Commands

| Command | Description |
|---------|-------------|
| `make build` | Build Docker image |
| `make up` | Start the bot in background |
| `make down` | Stop the bot |
| `make restart` | Restart the bot |
| `make logs` | Show bot logs (live) |
| `make clean` | Remove containers, images, and volumes |
| `make status` | Show container status |

## Configuration

All configuration is done via environment variables in the `.env` file:

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN` | *(required)* | Your Discord user token |
| `GUILD_ID` | *(required)* | Target server (guild) ID |
| `CHANNEL_ID` | *(required)* | Target voice channel ID |
| `STATUS` | `dnd` | Online status (`online`, `idle`, `dnd`, `invisible`) |
| `SELF_MUTE` | `True` | Mute yourself in voice |
| `SELF_DEAF` | `False` | Deafen yourself in voice |

### Voice Limit

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE_LIMIT` | `0` | Max users before leaving (0 = disabled) |

### Auto-Reply

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_REPLY` | `True` | Enable/disable auto-reply |
| `REPLY_TRIGGER` | `hey wake up!` | Trigger phrase (case-insensitive) |
| `REPLY_MESSAGE` | `yes` | Reply message content |
| `REPLY_DELAY` | `5` | Seconds to wait before replying |

### Rich Presence

| Variable | Default | Description |
|----------|---------|-------------|
| `RICH_PRESENCE_ENABLED` | `True` | Enable/disable Rich Presence |
| `RICH_PRESENCE_APP_ID` | *(empty)* | Discord Application ID for full RPC |
| `RICH_PRESENCE_LARGE_IMAGE` | `logo_large` | Asset key for large image |
| `RICH_PRESENCE_SMALL_IMAGE` | `logo_small` | Asset key for small image |
| `RICH_PRESENCE_UPDATE_INTERVAL` | `300` | Presence refresh interval (seconds) |

## Architecture

```
┌─────────────────────────────────────┐
│  Docker Container                   │
│  restart: unless-stopped            │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  main.py (AlwaysVoiceBot)     │  │
│  │                               │  │
│  │  ├─ Main Thread               │  │
│  │  │  └─ handle_messages()      │  │
│  │  │     ├─ READY → join voice  │  │
│  │  │     ├─ VOICE_STATE_UPDATE  │  │
│  │  │     └─ MESSAGE_CREATE      │  │
│  │  │                            │  │
│  │  ├─ Heartbeat Thread          │  │
│  │  │  └─ OP 1 every ~41.25s    │  │
│  │  │                            │  │
│  │  ├─ Presence Thread           │  │
│  │  │  └─ OP 3 every 5min       │  │
│  │  │                            │  │
│  │  └─ Reply Threads (on demand) │  │
│  │     └─ HTTP POST per trigger  │  │
│  └───────────────────────────────┘  │
│            │                        │
│            ▼                        │
│  Discord Gateway (WSS v10)          │
└─────────────────────────────────────┘
```

### Fail-Fast Strategy

The bot uses **no internal retry logic**. Any fatal error triggers `sys.exit(1)`, and Docker automatically restarts the container. This keeps the codebase simple and recovery predictable.

| Event | Action |
|-------|--------|
| OP 7 (Reconnect) | `sys.exit(1)` → Docker restart |
| OP 9 (Invalid Session) | `sys.exit(1)` → Docker restart |
| WebSocket closed | `sys.exit(1)` → Docker restart |
| Connection failed | `sys.exit(1)` → Docker restart |
| Voice disconnected | Auto-rejoin after 5s delay |

## ⚠️ Disclaimer

This is a **self-bot** that uses a Discord user token for automation. This violates [Discord's Terms of Service](https://discord.com/terms). Use at your own risk — your account may be suspended or banned.

## License

This project is for personal and educational use only.
