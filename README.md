# 🎙️ AlwaysVoiceBot

A Discord self-bot designed to maintain a persistent presence in a specific voice channel. Built with a **fail-fast** architecture — any connection drop or unhandled exception will terminate the process, relying on Docker's `restart: unless-stopped` policy for automatic recovery.

Additionally, this bot features a smart **AI-Powered Chat** using OpenRouter to intelligently answer mentions, with robust context awareness (handling replied-to message texts and complex embedded structures), as well as a customizable **Rich Presence** to showcase activities and services.

## Features

- **Auto-Join Voice Channel** — Automatically joins and stays in a configured voice channel.
- **Auto-Rejoin** — Reconnects if disconnected (with a 5-second delay).
- **Voice Limit** — Leaves the channel if user count exceeds a configurable limit, and automatically rejoins once it is safe.
- **Auto-Reply** — Responds with a predefined static message when mentioned with a trigger phrase.
- **AI Chat (OpenRouter)** — Dynamically responds to mentions using state-of-the-art AI models when not matching the static auto-reply trigger.
- **Context-Aware Replies** — Understands referenced/replied-to messages, extracting both plain text and detailed fields from Discord Embeds to provide high-quality AI responses.
- **Rich Presence** — Displays custom activity status (e.g. promoting your service, custom details, state, and up to 2 clickable buttons with a continuous uptime timer).
- **Session Resume** — Attempts to resume existing sessions on gateway reconnection instead of creating new ones.

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
| `TOKEN` | *(required)* | Your Discord user token. |
| `GUILD_ID` | *(required)* | Target server (guild) ID. |
| `CHANNEL_ID` | *(required)* | Target voice channel ID. |
| `STATUS` | `dnd` | Online status (`online`, `idle`, `dnd`, `invisible`). |
| `SELF_MUTE` | `True` | Mute yourself in voice channel. |
| `SELF_DEAF` | `False` | Deafen yourself in voice channel. |

### Voice Limit

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE_LIMIT` | `0` | Max users before leaving (0 = disabled). Leaves if count > limit, rejoins when count < limit. |

### Auto-Reply (Static)

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_REPLY` | `True` | Enable/disable static auto-reply. |
| `REPLY_TRIGGER` | `hey wake up!` | Trigger phrase (case-insensitive) to send the static message. |
| `REPLY_MESSAGE` | `yes` | Static reply message content. |
| `REPLY_DELAY` | `5` | Seconds to wait before replying. |

### AI Chat (OpenRouter)

When the bot is mentioned and the message does not contain the static `REPLY_TRIGGER`, the AI chat handles the response if enabled.

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_ENABLED` | `False` | Enable/disable dynamic AI chat via OpenRouter. |
| `OPENROUTER_API_KEY` | *(empty)* | Your OpenRouter API Key. |
| `AI_MODEL` | `google/gemini-3.1-flash-lite` | The LLM model to query on OpenRouter. |
| `AI_SYSTEM_PROMPT` | *(see below)* | Instruction prompt given to the AI. |
| `AI_MAX_TOKENS` | `500` | Maximum response token limit. |
| `AI_ALLOWED_USER_IDS`| *(empty)* | Comma-separated list of allowed user IDs (empty = everyone allowed). |

*Note: Default `AI_SYSTEM_PROMPT` asks the bot to be casual, natural, and straight to the point while answering in the user's language.*

### Rich Presence

| Variable | Default | Description |
|----------|---------|-------------|
| `RICH_PRESENCE_ENABLED` | `True` | Enable/disable Rich Presence. |
| `RICH_PRESENCE_APP_ID` | *(empty)* | Discord Application ID (required for full RPC features/buttons). |
| `RICH_PRESENCE_NAME` | `Rich Presence` | Activity / Game name. |
| `RICH_PRESENCE_DETAILS` | *(empty)* | Upper description line. |
| `RICH_PRESENCE_STATE` | *(empty)* | Lower description line. |
| `RICH_PRESENCE_BUTTON1_LABEL` | *(empty)* | First clickable button label. |
| `RICH_PRESENCE_BUTTON1_URL` | *(empty)* | First clickable button redirect URL. |
| `RICH_PRESENCE_BUTTON2_LABEL` | *(empty)* | Second clickable button label. |
| `RICH_PRESENCE_BUTTON2_URL` | *(empty)* | Second clickable button redirect URL. |
| `RICH_PRESENCE_UPDATE_INTERVAL`| `500` | Presence refresh interval in seconds. |

## Project Structure & Architecture

```
├── main.py            # Entry point of the application
├── bot.py             # Main AlwaysVoiceBot manager (handles Discord Gateway & WS connections)
├── config.py          # Configuration parser & loader for environment variables
├── presence.py        # Rich Presence activity builder
├── api.py             # API handler for auto-replies, OpenRouter AI, & Discord Embed parsers
├── utils.py           # Logging and simple utility helpers
├── requirements.txt   # Python package dependencies
├── Makefile           # Task runner for Docker workflows
├── Dockerfile         # Container image manifest
└── docker-compose.yml # Service container orchestration
```

### Gateway Architecture

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
│  │  │  └─ OP 3 every 500s       │  │
│  │  │                            │  │
│  │  └─ Reply Threads (on demand) │  │
│  │     ├─ Static Reply (POST)    │  │
│  │     └─ AI Reply (OpenRouter)  │  │
│  └───────────────────────────────┘  │
│            │                        │
│            ▼                        │
│  Discord Gateway (WSS v10)          │
└─────────────────────────────────────┘
```

### Fail-Fast Strategy

The bot utilizes **no internal retry loops** for WebSocket or session failures. Any fatal gateway error or unhandled exception immediately triggers `sys.exit(1)`. Docker then automatically restarts the container according to its restart policy. This ensures a lightweight codebase and highly predictable recovery behavior.

| Event | Action |
|-------|--------|
| OP 7 (Reconnect) | `sys.exit(1)` → Docker restart |
| OP 9 (Invalid Session) | `sys.exit(1)` → Docker restart |
| WebSocket closed | `sys.exit(1)` → Docker restart |
| Connection failed | `sys.exit(1)` → Docker restart |
| Voice disconnected | Auto-rejoin after a 5-second delay |

## ⚠️ Disclaimer

This is a **self-bot** that uses a Discord user token for automation. Automating user accounts violates [Discord's Terms of Service](https://discord.com/terms). Use at your own risk — your account may be suspended or banned.

## License

This project is for personal and educational use only.
