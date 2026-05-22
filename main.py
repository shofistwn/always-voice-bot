"""
AlwaysVoiceBot Module

A Discord self-bot script designed to maintain a presence in a specific voice channel.
This script employs a "fail-fast" architecture: any connection drop, invalid session, 
or unhandled exception will immediately terminate the process (sys.exit(1)). 
This relies on Docker's `restart: unless-stopped` policy to handle clean recoveries.
"""

import os
import sys
import json
import time
import requests
from websocket import create_connection
from datetime import datetime
from threading import Thread

# Configuration variables loaded from environment
STATUS = os.getenv("STATUS", "dnd")
GUILD_ID = os.getenv("GUILD_ID", "")
CHANNEL_ID = os.getenv("CHANNEL_ID", "")
TOKEN = os.getenv("TOKEN")
SELF_MUTE = os.getenv("SELF_MUTE", "True").lower() == "true"
SELF_DEAF = os.getenv("SELF_DEAF", "False").lower() == "true"
AUTO_REPLY = os.getenv("AUTO_REPLY", "True").lower() == "true"
REPLY_TRIGGER = os.getenv("REPLY_TRIGGER", "hey wake up!").lower()
REPLY_MESSAGE = os.getenv("REPLY_MESSAGE", "yes")
REPLY_DELAY = int(os.getenv("REPLY_DELAY", "5"))
VOICE_LIMIT = int(os.getenv("VOICE_LIMIT", "0"))

# Rich Presence configuration
RICH_PRESENCE_ENABLED = os.getenv("RICH_PRESENCE_ENABLED", "True").lower() == "true"
RICH_PRESENCE_APP_ID = os.getenv("RICH_PRESENCE_APP_ID", "")
RICH_PRESENCE_NAME = os.getenv("RICH_PRESENCE_NAME", "Rich Presence")
RICH_PRESENCE_DETAILS = os.getenv("RICH_PRESENCE_DETAILS", "")
RICH_PRESENCE_STATE = os.getenv("RICH_PRESENCE_STATE", "")
RICH_PRESENCE_BUTTON1_LABEL = os.getenv("RICH_PRESENCE_BUTTON1_LABEL", "")
RICH_PRESENCE_BUTTON1_URL = os.getenv("RICH_PRESENCE_BUTTON1_URL", "")
RICH_PRESENCE_BUTTON2_LABEL = os.getenv("RICH_PRESENCE_BUTTON2_LABEL", "")
RICH_PRESENCE_BUTTON2_URL = os.getenv("RICH_PRESENCE_BUTTON2_URL", "")
RICH_PRESENCE_UPDATE_INTERVAL = int(os.getenv("RICH_PRESENCE_UPDATE_INTERVAL", "300"))

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

    def log(self, level, message):
        """Outputs formatted log messages with timestamps and basic color coding."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        colors = {
            "INFO": "\033[92m", "WARN": "\033[93m",
            "ERROR": "\033[91m", "SUCCESS": "\033[96m", "RETRY": "\033[94m"
        }
        reset = "\033[0m"
        color = colors.get(level, "")
        print(f"[{timestamp}] [{color}{level}{reset}] {message}")
        sys.stdout.flush()

    def build_rich_presence_activities(self):
        """Builds the Rich Presence activity list."""
        if RICH_PRESENCE_APP_ID:
            playing_activity = {
                "name": RICH_PRESENCE_NAME,
                "type": 0,
                "application_id": RICH_PRESENCE_APP_ID,
                "timestamps": {
                    "start": self.start_timestamp
                }
            }
            if RICH_PRESENCE_DETAILS:
                playing_activity["details"] = RICH_PRESENCE_DETAILS
            if RICH_PRESENCE_STATE:
                playing_activity["state"] = RICH_PRESENCE_STATE

            # Add clickable buttons (max 2)
            buttons = []
            button_urls = []
            if RICH_PRESENCE_BUTTON1_LABEL and RICH_PRESENCE_BUTTON1_URL:
                buttons.append(RICH_PRESENCE_BUTTON1_LABEL)
                button_urls.append(RICH_PRESENCE_BUTTON1_URL)
            if RICH_PRESENCE_BUTTON2_LABEL and RICH_PRESENCE_BUTTON2_URL:
                buttons.append(RICH_PRESENCE_BUTTON2_LABEL)
                button_urls.append(RICH_PRESENCE_BUTTON2_URL)
            if buttons:
                playing_activity["buttons"] = buttons
                playing_activity["metadata"] = {"button_urls": button_urls}
        else:
            playing_activity = {
                "name": RICH_PRESENCE_NAME,
                "type": 0,
                "timestamps": {
                    "start": self.start_timestamp
                }
            }
            if RICH_PRESENCE_DETAILS:
                playing_activity["details"] = RICH_PRESENCE_DETAILS

        return [playing_activity]

    def update_presence(self):
        """Sends a presence update (OP 3) to refresh the Rich Presence activity."""
        if not RICH_PRESENCE_ENABLED or not self.ws:
            return

        try:
            activities = self.build_rich_presence_activities()
            self.ws.send(json.dumps({
                "op": 3,
                "d": {
                    "since": 0,
                    "activities": activities,
                    "status": STATUS,
                    "afk": False
                }
            }))
            self.log("INFO", "Rich Presence updated successfully")
        except Exception as e:
            self.log("ERROR", f"Failed to update Rich Presence: {e}")

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
                self.log("INFO", f"Joining Voice Channel: {CHANNEL_ID}")
                self.last_join_attempt = time.time()
            except Exception as e:
                self.log("ERROR", f"Voice join failed: {e}")

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
                self.log("INFO", "Leaving Voice Channel due to limit.")
            except Exception as e:
                self.log("ERROR", f"Voice leave failed: {e}")
                self.is_in_voice = True

    def check_voice_limit(self):
        """Evaluates the current channel population against the VOICE_LIMIT."""
        if VOICE_LIMIT == 0:
            return
        
        current_count = len(self.voice_users)
        if current_count < VOICE_LIMIT:
            if not self.is_in_voice:
                self.log("INFO", "Voice limit safe. Joining.")
                self.join_voice()
        elif current_count > VOICE_LIMIT:
            if self.is_in_voice:
                self.log("WARN", f"Over limit ({current_count} > {VOICE_LIMIT}). Leaving immediately.")
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
                    self.log("ERROR", "Websocket connection closed unexpectedly. Crashing...")
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
                    self.log("ERROR", "Invalid session (OP 9). Cannot resume. Crashing to trigger Docker restart...")
                    sys.exit(1)

                if op == 7: 
                    self.log("ERROR", "Discord requested reconnect (OP 7). Crashing to trigger Docker restart...")
                    sys.exit(1)

                if t == 'READY':
                    self.session_id = d.get('session_id')
                    self.resume_gateway_url = d.get('resume_gateway_url')
                    self.user_id = d.get('user', {}).get('id')
                    self.log("SUCCESS", f"Connected as {d.get('user', {}).get('username')}")
                    
                    self.start_timestamp = int(time.time() * 1000)
                    self.is_in_voice = False
                    self.last_join_attempt = 0
                    self.join_voice()

                    # Activate Rich Presence after successful connection
                    if RICH_PRESENCE_ENABLED:
                        time.sleep(2)
                        self.update_presence()
                        Thread(target=self.presence_updater, daemon=True).start()
                        self.log("SUCCESS", "Rich Presence activated")

                elif t == 'RESUMED':
                    self.log("SUCCESS", f"Session resumed successfully (seq: {self.last_sequence})")
                    self.is_in_voice = False
                    self.last_join_attempt = 0
                    self.join_voice()

                    # Refresh Rich Presence after session resume
                    if RICH_PRESENCE_ENABLED:
                        time.sleep(2)
                        self.update_presence()
                        self.log("SUCCESS", "Rich Presence refreshed after resume")

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
                            self.log("WARN", "Bot disconnected from voice. Force rejoining in 5 seconds...")
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

                elif t == 'MESSAGE_CREATE' and AUTO_REPLY:
                    if str(d.get('author', {}).get('id')) != self.user_id:
                        content = d.get('content', '').lower()
                        mentions = [m.get('id') for m in d.get('mentions', [])]
                        
                        if self.user_id in mentions and REPLY_TRIGGER in content:
                            self.send_reply(d.get('channel_id'))

            except Exception as e:
                self.log("ERROR", f"Message receiver encountered a fatal error: {e}. Crashing...")
                sys.exit(1)

    def send_reply(self, channel_id):
        """
        Dispatches an HTTP POST request in a background thread to send an auto-reply message.
        """
        def callback():
            time.sleep(REPLY_DELAY)
            try:
                requests.post(
                    f"https://discord.com/api/v10/channels/{channel_id}/messages",
                    headers=self.headers,
                    json={"content": REPLY_MESSAGE},
                    timeout=5
                )
                self.log("SUCCESS", f"Sent auto-reply to channel {channel_id}")
            except Exception:
                self.log("ERROR", "HTTP request for auto-reply failed.")

        Thread(target=callback, daemon=True).start()

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
                self.log("INFO", "Connecting to resume gateway...")
            else:
                gateway_url = 'wss://gateway.discord.gg/?v=10&encoding=json'
                self.log("INFO", "Connecting to Discord Gateway (v10)...")

            self.ws = create_connection(gateway_url, timeout=60)
            hello = json.loads(self.ws.recv())
            self.heartbeat_interval = hello['d']['heartbeat_interval']

            if attempting_resume:
                self.log("RETRY", f"Sending RESUME (session: {self.session_id[:16]}...)")
                self.ws.send(json.dumps({
                    "op": 6,
                    "d": {
                        "token": TOKEN,
                        "session_id": self.session_id,
                        "seq": self.last_sequence
                    }
                }))
            else:
                self.log("INFO", "Sending IDENTIFY for new session...")
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
                            "activities": self.build_rich_presence_activities() if RICH_PRESENCE_ENABLED else [],
                            "since": 0
                        },
                        # Intents: GUILDS (1) | GUILD_VOICE_STATES (128) | GUILD_MESSAGES (512) = 641
                        "intents": 641 
                    }
                }))

            Thread(target=self.send_heartbeat, daemon=True).start()
            return True

        except Exception as e:
            self.log("ERROR", f"Connection failed: {e}. Crashing...")
            sys.exit(1)

    def start(self):
        """
        Entry point for the bot. Initiates a single connection attempt.
        If the connection breaks or the loop finishes, it forces a process exit.
        """
        if not TOKEN:
            self.log("ERROR", "No token provided. Please set the TOKEN environment variable.")
            sys.exit(1)

        # Single execution flow: Connect once, handle messages, and crash if interrupted.
        if self.connect():
            time.sleep(2)
            self.handle_messages()

        self.log("ERROR", "Bot process ended unexpectedly. Crashing for Docker restart...")
        sys.exit(1)

if __name__ == "__main__":
    bot = AlwaysVoiceBot()
    try:
        bot.start()
    except KeyboardInterrupt:
        bot.is_running = False
        print("\nShutting down bot process...")