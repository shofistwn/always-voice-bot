## 🎵 Music Commands

Control music playback directly through Discord text chat using the configured prefix (default `!`):

| Command | Alias | Description |
|---|---|---|
| `!play <query/url>` | `!p` | Search and play a song or add a playlist to queue. |
| `!search <query>` | `!find` | Search songs interactively and pick from top 10 results (auto-cancels and cleans up in 30s). |
| `!remove <index>` | `!rm`, `!del` | Remove a specific song from queue by its 1-based index. |
| `!undo` | | Remove the last added song from the queue. |
| `!autoplay` | `!ap` | Toggle infinite autoplay for related recommendations. |
| `!loop [count]` | `!l`, `!repeat` | Repeat the current track indefinitely or N times. |
| `!stop` | | Stop playback, clear the queue, and restore voice mute. |
| `!skip` | `!s` | Skip to the next song in the queue. |
| `!pause` | | Pause current playback. |
| `!resume` | | Resume paused playback. |
| `!queue` | `!q` | View currently playing track and upcoming songs. |
| `!nowplaying` | `!np` | View details and link of the current track. |
| `!volume <0-100>` | `!vol` | Adjust playback volume. |
| `!help` | | Display the list of music commands. |

### 🔒 Access Control & Restrictions

- **Same Voice Channel Requirement**: Users must be in the exact same voice channel as the bot to run playback commands (`play`, `search`, `skip`, `stop`, etc.).
- **User Whitelist (`MUSIC_ALLOWED_USER_IDS`)**: Optional comma-separated Discord user IDs in `.env` (e.g. `MUSIC_ALLOWED_USER_IDS=123456789012345678,987654321098765432`). If defined, only authorized users can trigger music commands. If left blank, any user in the same voice channel can use the bot.
