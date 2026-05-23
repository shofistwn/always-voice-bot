import sys
import json
import time
from threading import Thread
from websocket import create_connection

from config import (
    TOKEN, GUILD_ID, CHANNEL_ID, STATUS,
    SELF_MUTE, SELF_DEAF,
    AUTO_REPLY, REPLY_TRIGGER,
    AI_ENABLED, AI_ALLOWED_USER_IDS,
    VOICE_LIMIT, RICH_PRESENCE_ENABLED,
    RICH_PRESENCE_UPDATE_INTERVAL
)
from utils import log
from presence import build_rich_presence_activities
from api import send_reply_async, send_ai_reply_async

class AlwaysVoiceBot:
    """
    Manages the Discord WebSocket connection, voice state presence, 
    and optional auto-reply functionality.
    """

    def __init__(self):
        self.ws = None
        self.heartbeat_interval = None
        self.heartbeat_count = 0
        self.is_running = True
        self.is_in_voice = False
        self.user_id = None
        self.username = "Unknown"
        self.session_id = None
        self.last_sequence = None
        self.resume_gateway_url = None
        self.voice_users = set()
        self.last_join_attempt = 0
        self.start_timestamp = int(time.time() * 1000)
        self.headers = {
            "Authorization": TOKEN,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }

    def update_presence(self):
        """Sends a presence update (OP 3) to refresh the Rich Presence activity."""
        if not RICH_PRESENCE_ENABLED or not self.ws:
            return

        try:
            activities = build_rich_presence_activities(self.start_timestamp)
            self.ws.send(json.dumps({
                "op": 3,
                "d": {
                    "since": 0,
                    "activities": activities,
                    "status": STATUS,
                    "afk": False
                }
            }))
            log("INFO", "Rich Presence updated successfully")
        except Exception as e:
            log("ERROR", f"Failed to update Rich Presence: {e}")

    def presence_updater(self):
        """
        Runs in a background thread to periodically refresh the Rich Presence
        activity, ensuring it stays visible.
        """
        while self.is_running and self.ws:
            try:
                time.sleep(RICH_PRESENCE_UPDATE_INTERVAL)
                if self.ws and self.ws.connected:
                    self.update_presence()
            except Exception:
                break

    def send_heartbeat(self):
        """
        Runs in a separate thread to periodically send heartbeat (OP 1) 
        payloads to the Discord Gateway to maintain the connection.
        """
        while self.is_running and self.ws:
            try:
                if self.heartbeat_interval:
                    time.sleep(self.heartbeat_interval / 1000)
                    if self.ws and self.ws.connected:
                        self.ws.send(json.dumps({"op": 1, "d": self.last_sequence}))
                        self.heartbeat_count += 1
            except Exception:
                # Allow thread to terminate silently on error.
                # The main message receiver will detect the broken pipe and trigger a crash.
                break

    def join_voice(self):
        """Sends the payload (OP 4) to join the configured voice channel."""
        if time.time() - self.last_join_attempt < 10:
            return

        if self.ws and not self.is_in_voice:
            try:
                self.ws.send(json.dumps({
                    "op": 4,
                    "d": {
                        "guild_id": GUILD_ID,
                        "channel_id": CHANNEL_ID,
                        "self_mute": SELF_MUTE,
                        "self_deaf": SELF_DEAF
                    }
                }))
                log("INFO", f"Joining Voice Channel: {CHANNEL_ID}")
                self.last_join_attempt = time.time()
            except Exception as e:
                log("ERROR", f"Voice join failed: {e}")

    def leave_voice(self):
        """Sends the payload (OP 4) to disconnect from the current voice channel."""
        if self.ws and self.is_in_voice:
            try:
                self.is_in_voice = False
                self.ws.send(json.dumps({
                    "op": 4,
                    "d": {
                        "guild_id": GUILD_ID,
                        "channel_id": None,
                        "self_mute": False,
                        "self_deaf": False
                    }
                }))
                log("INFO", "Leaving Voice Channel due to limit.")
            except Exception as e:
                log("ERROR", f"Voice leave failed: {e}")
                self.is_in_voice = True

    def check_voice_limit(self):
        """Evaluates the current channel population against the VOICE_LIMIT."""
        if VOICE_LIMIT == 0:
            return
        
        current_count = len(self.voice_users)
        if current_count < VOICE_LIMIT:
            if not self.is_in_voice:
                log("INFO", "Voice limit safe. Joining.")
                self.join_voice()
        elif current_count > VOICE_LIMIT:
            if self.is_in_voice:
                log("WARN", f"Over limit ({current_count} > {VOICE_LIMIT}). Leaving immediately.")
                self.leave_voice()

    def handle_messages(self):
        """
        Main loop for listening to incoming WebSocket messages.
        Exits the process entirely (sys.exit) upon encountering fatal opcodes or socket closure.
        """
        while self.is_running and self.ws:
            try:
                msg = self.ws.recv()
                if not msg: 
                    log("ERROR", "Websocket connection closed unexpectedly. Crashing...")
                    sys.exit(1)

                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    continue

                op, t, d, s = data.get('op'), data.get('t'), data.get('d', {}), data.get('s')

                if s: 
                    self.last_sequence = s
                if op == 11: 
                    continue

                # Terminate process on invalid session (9) or reconnect request (7)
                if op == 9: 
                    log("ERROR", "Invalid session (OP 9). Cannot resume. Crashing to trigger Docker restart...")
                    sys.exit(1)

                if op == 7: 
                    log("ERROR", "Discord requested reconnect (OP 7). Crashing to trigger Docker restart...")
                    sys.exit(1)

                if t == 'READY':
                    self.session_id = d.get('session_id')
                    self.resume_gateway_url = d.get('resume_gateway_url')
                    self.user_id = d.get('user', {}).get('id')
                    log("SUCCESS", f"Connected as {d.get('user', {}).get('username')}")
                    
                    self.start_timestamp = int(time.time() * 1000)
                    self.is_in_voice = False
                    self.last_join_attempt = 0
                    self.join_voice()

                    # Activate Rich Presence after successful connection
                    if RICH_PRESENCE_ENABLED:
                        time.sleep(2)
                        self.update_presence()
                        Thread(target=self.presence_updater, daemon=True).start()
                        log("SUCCESS", "Rich Presence activated")

                elif t == 'RESUMED':
                    log("SUCCESS", f"Session resumed successfully (seq: {self.last_sequence})")
                    self.is_in_voice = False
                    self.last_join_attempt = 0
                    self.join_voice()

                    # Refresh Rich Presence after session resume
                    if RICH_PRESENCE_ENABLED:
                        time.sleep(2)
                        self.update_presence()
                        log("SUCCESS", "Rich Presence refreshed after resume")

                elif t == 'GUILD_CREATE':
                    if d.get('id') != GUILD_ID:
                        continue
                    self.voice_users = set()
                    for vs in d.get('voice_states', []):
                        if vs.get('channel_id') == CHANNEL_ID:
                            self.voice_users.add(str(vs.get('user_id')))
                    self.check_voice_limit()

                elif t == 'VOICE_STATE_UPDATE':
                    # Handle bot's own voice state
                    if str(d.get('user_id')) == self.user_id:
                        was_in_voice = self.is_in_voice
                        self.is_in_voice = d.get('channel_id') is not None
                        
                        if was_in_voice and not self.is_in_voice:
                            log("WARN", "Bot disconnected from voice. Force rejoining in 5 seconds...")
                            def _delayed_rejoin():
                                time.sleep(5)
                                self.last_join_attempt = 0
                                self.join_voice()
                            Thread(target=_delayed_rejoin, daemon=True).start()
                            continue

                    # Track channel population for limit enforcement
                    if d.get('channel_id') == CHANNEL_ID:
                        self.voice_users.add(str(d.get('user_id')))
                    else:
                        user_id_str = str(d.get('user_id'))
                        if user_id_str in self.voice_users:
                            self.voice_users.remove(user_id_str)
                    self.check_voice_limit()

                elif t == 'MESSAGE_CREATE':
                    author_id = str(d.get('author', {}).get('id'))
                    raw_content = d.get('content', '')
                    channel_id = d.get('channel_id')
                    mentions = [m.get('id') for m in d.get('mentions', [])]

                    if author_id != self.user_id and self.user_id in mentions:
                        content = raw_content.lower()

                        if AUTO_REPLY and REPLY_TRIGGER in content:
                            send_reply_async(channel_id, self.headers)
                        elif AI_ENABLED:
                            if AI_ALLOWED_USER_IDS and author_id not in AI_ALLOWED_USER_IDS:
                                log("WARN", f"AI request denied for user {author_id}")
                            else:
                                send_ai_reply_async(channel_id, raw_content, d, self.user_id, self.headers)

            except Exception as e:
                log("ERROR", f"Message receiver encountered a fatal error: {e}. Crashing...")
                sys.exit(1)

    def connect(self):
        """
        Establishes the WebSocket connection to the Discord Gateway.
        Attempts to resume a previous session if session details are available.
        """
        try:
            if self.ws:
                try: 
                    self.ws.close()
                except Exception: 
                    pass

            attempting_resume = bool(self.session_id and self.last_sequence and self.resume_gateway_url)

            if attempting_resume:
                gateway_url = f"{self.resume_gateway_url}?v=10&encoding=json"
                log("INFO", "Connecting to resume gateway...")
            else:
                gateway_url = 'wss://gateway.discord.gg/?v=10&encoding=json'
                log("INFO", "Connecting to Discord Gateway (v10)...")

            self.ws = create_connection(gateway_url, timeout=60)
            hello = json.loads(self.ws.recv())
            self.heartbeat_interval = hello['d']['heartbeat_interval']

            if attempting_resume:
                log("RETRY", f"Sending RESUME (session: {self.session_id[:16]}...)")
                self.ws.send(json.dumps({
                    "op": 6,
                    "d": {
                        "token": TOKEN,
                        "session_id": self.session_id,
                        "seq": self.last_sequence
                    }
                }))
            else:
                log("INFO", "Sending IDENTIFY for new session...")
                self.ws.send(json.dumps({
                    "op": 2,
                    "d": {
                        "token": TOKEN,
                        "properties": {
                            "$os": "Windows",
                            "$browser": "Chrome",
                            "$device": "PC"
                        },
                        "presence": {
                            "status": STATUS,
                            "afk": False,
                            "activities": build_rich_presence_activities(self.start_timestamp) if RICH_PRESENCE_ENABLED else [],
                            "since": 0
                        },
                        # Intents: GUILDS (1) | GUILD_VOICE_STATES (128) | GUILD_MESSAGES (512) = 641
                        "intents": 641 
                    }
                }))

            Thread(target=self.send_heartbeat, daemon=True).start()
            return True

        except Exception as e:
            log("ERROR", f"Connection failed: {e}. Crashing...")
            sys.exit(1)

    def start(self):
        """
        Entry point for the bot. Initiates a single connection attempt.
        If the connection breaks or the loop finishes, it forces a process exit.
        """
        if not TOKEN:
            log("ERROR", "No token provided. Please set the TOKEN environment variable.")
            sys.exit(1)

        # Single execution flow: Connect once, handle messages, and crash if interrupted.
        if self.connect():
            time.sleep(2)
            self.handle_messages()

        log("ERROR", "Bot process ended unexpectedly. Crashing for Docker restart...")
        sys.exit(1)
