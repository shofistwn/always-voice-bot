import os
import sys
import json
import time
import requests
from websocket import create_connection
from threading import Thread
from datetime import datetime

# --- Configuration ---
TOKEN = os.getenv("TOKEN")
GUILD_ID = os.getenv("GUILD_ID")
CHANNEL_ID = os.getenv("CHANNEL_ID")
STATUS = os.getenv("STATUS", "dnd")
AUTO_REPLY = os.getenv("AUTO_REPLY", "True").lower() == "true"
REPLY_TRIGGER = os.getenv("REPLY_TRIGGER", "hey wake up!").lower()
REPLY_MESSAGE = os.getenv("REPLY_MESSAGE", "yes")

class AlwaysVoiceBot:
    def __init__(self):
        self.ws = None
        self.user_id = None
        self.headers = {
            "Authorization": TOKEN,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

    def log(self, level, message):
        """Standardized logging with timestamps and colors."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        colors = {
            "INFO": "\033[94m",    # Blue
            "SUCCESS": "\033[92m", # Green
            "WARN": "\033[93m",    # Yellow
            "ERROR": "\033[91m",   # Red
            "HEARTBEAT": "\033[90m", # Gray
            "RESET": "\033[0m"
        }
        color = colors.get(level, colors["RESET"])
        print(f"[{timestamp}] [{color}{level}{colors['RESET']}] {message}")
        sys.stdout.flush()

    def send_heartbeat(self, interval):
        """Periodic heartbeat with logging."""
        try:
            while True:
                time.sleep(interval / 1000)
                self.ws.send(json.dumps({"op": 1, "d": None}))
                self.log("HEARTBEAT", "Keep-alive ping sent to Gateway")
        except:
            self.log("ERROR", "Heartbeat failed. Triggering container restart...")
            os._exit(1)

    def send_reply(self, channel_id):
        try:
            requests.post(f"https://discord.com/api/v9/channels/{channel_id}/messages",
                          headers=self.headers, json={"content": REPLY_MESSAGE}, timeout=5)
            self.log("SUCCESS", f"Sent auto-reply to channel {channel_id}")
        except Exception as e:
            self.log("ERROR", f"Failed to send reply: {e}")

    def run(self):
        if not TOKEN:
            self.log("ERROR", "No TOKEN provided!")
            sys.exit(1)

        self.log("INFO", "Connecting to Discord Gateway...")
        try:
            self.ws = create_connection('wss://gateway.discord.gg/?v=9&encoding=json')
            
            hello = json.loads(self.ws.recv())
            interval = hello['d']['heartbeat_interval']
            
            # Start the heartbeat thread
            self.log("INFO", f"Heartbeat interval set to {interval}ms")
            Thread(target=self.send_heartbeat, args=(interval,), daemon=True).start()

            self.ws.send(json.dumps({"op": 2, "d": {
                "token": TOKEN,
                "properties": {"$os": "Windows", "$browser": "Chrome", "$device": "PC"},
                "presence": {"status": STATUS, "afk": False, "activities": []},
                "intents": 641
            }}))

            # JOIN VOICE
            self.ws.send(json.dumps({
                "op": 4,
                "d": {
                    "guild_id": GUILD_ID,
                    "channel_id": CHANNEL_ID,
                    "self_mute": True,
                    "self_deaf": False
                }
            }))
            self.log("SUCCESS", f"Attempted to join Voice Channel: {CHANNEL_ID}")

            while True:
                msg = self.ws.recv()
                if not msg: break
                data = json.loads(msg)
                t, d = data.get('t'), data.get('d', {})

                if t == 'READY':
                    self.user_id = d.get('user', {}).get('id')
                    self.log("SUCCESS", f"Logged in as {d.get('user', {}).get('username')}")

                elif t == 'VOICE_STATE_UPDATE':
                    if d.get('user_id') == self.user_id and d.get('channel_id') is None:
                        self.log("WARN", "Left voice channel. Restarting...")
                        sys.exit(1)

                elif t == 'MESSAGE_CREATE' and AUTO_REPLY:
                    content = d.get('content', '').lower()
                    author_id = d.get('author', {}).get('id')
                    # Check if bot is mentioned
                    mentions = [m.get('id') for m in d.get('mentions', [])]
                    if author_id != self.user_id and self.user_id in mentions:
                        if REPLY_TRIGGER in content:
                            self.send_reply(d.get('channel_id'))

        except Exception as e:
            self.log("ERROR", f"Connection error: {e}")
            sys.exit(1)

if __name__ == "__main__":
    AlwaysVoiceBot().run()