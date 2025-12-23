import os
import sys
import json
import time
import requests
from websocket import create_connection
from datetime import datetime
from threading import Thread

# --- Configuration ---
# Environment variables for bot behavior and authentication
STATUS = os.getenv("STATUS", "dnd")
GUILD_ID = os.getenv("GUILD_ID", "")
CHANNEL_ID = os.getenv("CHANNEL_ID", "")
TOKEN = os.getenv("TOKEN")
SELF_MUTE = os.getenv("SELF_MUTE", "True").lower() == "true"
SELF_DEAF = os.getenv("SELF_DEAF", "False").lower() == "true"
AUTO_REPLY = os.getenv("AUTO_REPLY", "True").lower() == "true"
REPLY_TRIGGER = os.getenv("REPLY_TRIGGER", "hey wake up!").lower()
REPLY_MESSAGE = os.getenv("REPLY_MESSAGE", "yes")

class AlwaysVoiceBot:
    """
    A Discord bot class that maintains a persistent voice channel presence 
    and supports session resuming to prevent being kicked during disconnects.
    """
    def __init__(self):
        self.ws = None
        self.heartbeat_interval = None
        self.heartbeat_count = 0
        self.is_running = True
        self.is_in_voice = False
        self.user_id = None
        self.username = "Unknown"
        self.session_id = None  # Captured from READY event for RESUME
        self.last_sequence = None # Sequence number tracker for Gateway Resume
        self.headers = {
            "Authorization": TOKEN,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }

    def log(self, level, message):
        """Standardized console logging with timestamps and colors."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        colors = {
            "INFO": "\033[92m", "WARN": "\033[93m", 
            "ERROR": "\033[91m", "SUCCESS": "\033[96m", "RETRY": "\033[94m"
        }
        reset = "\033[0m"
        color = colors.get(level, "")
        print(f"[{timestamp}] [{color}{level}{reset}] {message}")
        sys.stdout.flush()

    def send_heartbeat(self):
        """Sends periodic heartbeats to maintain the Gateway connection."""
        while self.is_running and self.ws:
            try:
                if self.heartbeat_interval:
                    time.sleep(self.heartbeat_interval / 1000)
                    # Include the last sequence number to allow for resuming
                    self.ws.send(json.dumps({"op": 1, "d": self.last_sequence}))
                    self.heartbeat_count += 1
            except:
                break

    def join_voice(self):
        """Sends the OP 4 payload to join the configured voice channel."""
        if not self.is_in_voice:
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
            except Exception as e:
                self.log("ERROR", f"Voice join failed: {e}")

    def handle_messages(self):
        """Listens for Gateway events and manages session states."""
        while self.is_running and self.ws:
            try:
                msg = self.ws.recv()
                if not msg: break
                
                data = json.loads(msg)
                op, t, d, s = data.get('op'), data.get('t'), data.get('d', {}), data.get('s')

                # Store sequence number for future RESUME attempts
                if s: self.last_sequence = s 

                if op == 11: continue # Heartbeat ACK

                if op == 9: # OP 9: Invalid Session. Must re-identify
                    self.log("WARN", "Invalid session detected. Resetting session ID...")
                    self.session_id = None
                    break

                if t == 'READY':
                    self.session_id = d.get('session_id')
                    self.user_id = d.get('user', {}).get('id')
                    self.log("SUCCESS", f"Connected as {d.get('user', {}).get('username')}")

                elif t == 'RESUMED':
                    self.log("SUCCESS", "Gateway session resumed successfully.")

                elif t == 'VOICE_STATE_UPDATE':
                    if str(d.get('user_id')) == self.user_id:
                        was_in_voice = self.is_in_voice
                        self.is_in_voice = d.get('channel_id') is not None

                        if was_in_voice and not self.is_in_voice:
                            self.log("WARN", "Disconnected from voice. Rejoining in 3 seconds...")
                            time.sleep(3)
                            self.join_voice()

                elif t == 'MESSAGE_CREATE' and AUTO_REPLY:
                    if str(d.get('author', {}).get('id')) != self.user_id:
                        content = d.get('content', '').lower()
                        # Auto-reply if bot is mentioned and trigger matches
                        if self.user_id in [m.get('id') for m in d.get('mentions', [])] and REPLY_TRIGGER in content:
                            self.send_reply(d.get('channel_id'))

            except Exception as e:
                self.log("ERROR", f"Message receiver error: {e}")
                break

    def send_reply(self, channel_id):
        """Sends a text message reply to a specific channel."""
        def callback():
            time.sleep(10)
            try:
                requests.post(
                    f"https://discord.com/api/v9/channels/{channel_id}/messages",
                    headers=self.headers,
                    json={"content": REPLY_MESSAGE},
                    timeout=5
                )
                self.log("SUCCESS", f"Sent auto-reply to channel {channel_id}")
            except:
                self.log("ERROR", "HTTP request for auto-reply failed.")
        
        Thread(target=callback, daemon=True).start()

    def connect(self):
        """Establishes or re-establishes a connection to the Discord Gateway."""
        try:
            # Close existing connection safely before reconnecting
            if self.ws:
                try: self.ws.close()
                except: pass

            self.log("INFO", "Connecting to Discord Gateway...")
            self.ws = create_connection('wss://gateway.discord.gg/?v=9&encoding=json')
            
            hello = json.loads(self.ws.recv())
            self.heartbeat_interval = hello['d']['heartbeat_interval']
            
            # Check if we can resume the previous session
            if self.session_id and self.last_sequence:
                self.log("RETRY", f"Attempting to resume session: {self.session_id}")
                self.ws.send(json.dumps({
                    "op": 6,
                    "d": {
                        "token": TOKEN,
                        "session_id": self.session_id,
                        "seq": self.last_sequence
                    }
                }))
            else:
                # Standard Identity payload (OP 2)
                self.ws.send(json.dumps({
                    "op": 2,
                    "d": {
                        "token": TOKEN,
                        "properties": {"$os": "Windows", "$browser": "Chrome", "$device": "PC"},
                        "presence": {"status": STATUS, "afk": False, "activities": []},
                        "intents": 641 
                    }
                }))
            
            # Restart background heartbeat thread
            Thread(target=self.send_heartbeat, daemon=True).start()
            return True
        except Exception as e:
            self.log("ERROR", f"Connection failed: {e}")
            return False

    def start(self):
        """Main loop that handles startup and automatic reconnection."""
        if not TOKEN:
            self.log("ERROR", "No token provided. Please set the TOKEN environment variable.")
            return

        while self.is_running:
            if self.connect():
                # Pause briefly to ensure connection is stable before joining voice
                time.sleep(2)
                self.join_voice()
                # handle_messages runs on the main thread to catch disconnects
                self.handle_messages() 
            
            # Delay before attempting to reconnect to avoid rate limiting
            self.log("WARN", "Gateway connection lost. Retrying in 5 seconds...")
            time.sleep(5)

if __name__ == "__main__":
    bot = AlwaysVoiceBot()
    try:
        bot.start()
    except KeyboardInterrupt:
        bot.is_running = False
        print("\nShutting down bot process...")