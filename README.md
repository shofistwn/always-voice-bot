## 🎵 Music Commands

Control music playback directly through Discord text chat using the configured prefix (default `!`):

| Command | Alias | Description |
|---|---|---|
| `!play <query/url>` | `!p` | Search and play a song or add a playlist to queue. |
| `!search <query>` | `!find` | Search songs interactively and pick from top 5 results (auto-cancels and cleans up in 60s). |
| `!remove <index>` | `!rm`, `!del` | Remove a specific song from queue by its 1-based index. |
| `!undo` | | Remove the last added song from the queue. |
| `!autoplay` | `!ap` | Toggle infinite autoplay for related recommendations. |
| `!loop [count]` | `!l`, `!repeat` | Repeat the current track indefinitely or N times. |
| `!stop` | | Stop playback, clear the queue, and restore voice mute. |
| `!skip` | `!s`, `!next` | Skip to the next song in the queue. |
| `!jump <index>` | `!j`, `!skipto` | Jump to a specific song in the queue. |
| `!pause` | | Pause current playback. |
| `!resume` | | Resume paused playback. |
| `!queue [page]` | `!q` | View currently playing track and upcoming songs. |
| `!nowplaying` | `!np` | View details and link of the current track. |
| `!volume <0-100>` | `!vol` | Adjust playback volume. |
| `!join [id]` | `!move`, `!connect` | Move bot to user's voice channel or specified channel ID (admins only). |
| `!leave` | `!dc`, `!disconnect` | Disconnect bot from voice and clear saved state (admins only). |
| `!help` | `!h` | Display the list of music commands. |

### 🔒 Access Control & Restrictions

- **Same Voice Channel Requirement**: Any server member can run music commands (`play`, `search`, `skip`, `pause`, `help`, etc.) as long as they are in the exact same voice channel as the bot. If not in the same voice channel, commands are silently ignored.
- **Voice Admin Whitelist (`VOICE_ALLOWED_USER_IDS`)**: Comma-separated Discord user IDs allowed to run voice management commands (`join`, `leave`). Unauthorized attempts are silently ignored.
