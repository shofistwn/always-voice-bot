import os

# Configuration variables loaded from environment
GUILD_ID = os.getenv("GUILD_ID", "")
CHANNEL_ID = os.getenv("CHANNEL_ID", "")
TOKEN = os.getenv("TOKEN")
VOICE_LIMIT = int(os.getenv("VOICE_LIMIT", "0"))
STATUS = os.getenv("STATUS", "dnd")
SELF_MUTE = os.getenv("SELF_MUTE", "True").lower() == "true"
SELF_DEAF = os.getenv("SELF_DEAF", "False").lower() == "true"

# Auto Reply configuration
AUTO_REPLY = os.getenv("AUTO_REPLY", "False").lower() == "true"
REPLY_TRIGGER = os.getenv("REPLY_TRIGGER", "hey wake up!").lower()
REPLY_MESSAGE = os.getenv("REPLY_MESSAGE", "yes")
REPLY_DELAY = int(os.getenv("REPLY_DELAY", "5"))

# AI Chat configuration (OpenRouter)
AI_ENABLED = os.getenv("AI_ENABLED", "False").lower() == "true"
AI_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
AI_MODEL = os.getenv("AI_MODEL", "google/gemini-3.1-flash-lite")
AI_SYSTEM_PROMPT = os.getenv("AI_SYSTEM_PROMPT", "You are a helpful assistant. Respond concisely in the same language as the user.")
AI_MAX_TOKENS = int(os.getenv("AI_MAX_TOKENS", "500"))
AI_ALLOWED_USER_IDS = [uid.strip() for uid in os.getenv("AI_ALLOWED_USER_IDS", "").split(",") if uid.strip()]

# Rich Presence configuration
RICH_PRESENCE_ENABLED = os.getenv("RICH_PRESENCE_ENABLED", "False").lower() == "true"
RICH_PRESENCE_APP_ID = os.getenv("RICH_PRESENCE_APP_ID", "")
RICH_PRESENCE_NAME = os.getenv("RICH_PRESENCE_NAME", "Rich Presence")
RICH_PRESENCE_DETAILS = os.getenv("RICH_PRESENCE_DETAILS", "")
RICH_PRESENCE_STATE = os.getenv("RICH_PRESENCE_STATE", "")
RICH_PRESENCE_BUTTON1_LABEL = os.getenv("RICH_PRESENCE_BUTTON1_LABEL", "")
RICH_PRESENCE_BUTTON1_URL = os.getenv("RICH_PRESENCE_BUTTON1_URL", "")
RICH_PRESENCE_BUTTON2_LABEL = os.getenv("RICH_PRESENCE_BUTTON2_LABEL", "")
RICH_PRESENCE_BUTTON2_URL = os.getenv("RICH_PRESENCE_BUTTON2_URL", "")
RICH_PRESENCE_UPDATE_INTERVAL = int(os.getenv("RICH_PRESENCE_UPDATE_INTERVAL", "500"))
