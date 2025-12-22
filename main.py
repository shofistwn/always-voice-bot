import os
import sys
import json
import time
import requests
from websocket import create_connection
from datetime import datetime
from threading import Thread

# --- Configuration ---
STATUS = os.getenv("STATUS", "dnd")
GUILD_ID = os.getenv("GUILD_ID", "")
CHANNEL_ID = os.getenv("CHANNEL_ID", "")
TOKEN = os.getenv("TOKEN")
SELF_MUTE = os.getenv("SELF_MUTE", "True").lower() == "true"
SELF_DEAF = os.getenv("SELF_DEAF", "False").lower() == "true"
AUTO_REPLY = os.getenv("AUTO_REPLY", "True").lower() == "true"
REPLY_TRIGGER = os.getenv("REPLY_TRIGGER", "hey wake up!").lower()
REPLY_MESSAGE = os.getenv("REPLY_MESSAGE", "yes")

class DiscordVoiceBot:
    def __init__(self):
        self.ws = None
        self.heartbeat_interval = None
        self.heartbeat_count = 0
        self.is_running = True
        self.is_in_voice = False
        self.user_id = None
        self.username = "Unknown"
        self.headers = {
            "Authorization": TOKEN,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }

    def log(self, level, message):
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
        while self.is_running and self.ws:
            try:
                time.sleep(self.heartbeat_interval / 1000)
                if self.ws:
                    self.ws.send(json.dumps({"op": 1, "d": None}))
                    self.heartbeat_count += 1
            except:
                break

    def join_voice(self):
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
        self.log("INFO", "Message receiver thread started.")
        while self.is_running and self.ws:
            try:
                msg = self.ws.recv()
                if not msg: break
                
                data = json.loads(msg)
                op, t, d = data.get('op'), data.get('t'), data.get('d', {})

                if op == 11: continue # Heartbeat ACK

                # Rejoin if disconnected
                if t == 'VOICE_STATE_UPDATE':
                    if str(d.get('user_id')) == self.user_id:
                        self.is_in_voice = d.get('channel_id') is not None
                        if not self.is_in_voice:
                            self.log("WARN", "Disconnected from voice. Reconnecting...")
                            time.sleep(2)
                            self.join_voice()

                # Auto-Reply Logic
                elif t == 'MESSAGE_CREATE' and AUTO_REPLY:
                    if str(d.get('author', {}).get('id')) != self.user_id:
                        content = d.get('content', '').lower()
                        if self.user_id in [m.get('id') for m in d.get('mentions', [])] and REPLY_TRIGGER in content:
                            self.send_reply(d.get('channel_id'))

            except Exception as e:
                self.log("ERROR", f"Receiver error: {e}")
                break

    def send_reply(self, channel_id):
        try:
            r = requests.post(
                f"https://discord.com/api/v9/channels/{channel_id}/messages",
                headers=self.headers,
                json={"content": REPLY_MESSAGE},
                timeout=5
            )
            if r.status_code == 200:
                self.log("SUCCESS", f"Sent auto-reply to channel {channel_id}")
        except:
            self.log("ERROR", "Failed to send auto-reply.")

    def connect(self):
        try:
            self.log("INFO", "Connecting to Discord Gateway...")
            self.ws = create_connection('wss://gateway.discord.gg/?v=9&encoding=json')
            
            self.heartbeat_count = 0
            
            hello = json.loads(self.ws.recv())
            self.heartbeat_interval = hello['d']['heartbeat_interval']
            
            # Identity Payload
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
                        "activities": []
                    },
                    "intents": 641 
                }
            }))
            
            # Fetch User Data
            me = requests.get('https://discord.com/api/v9/users/@me', headers=self.headers).json()
            self.user_id = me['id']
            self.username = me['username']
            
            # Start Background Threads
            Thread(target=self.send_heartbeat, daemon=True).start()
            Thread(target=self.handle_messages, daemon=True).start()
            
            time.sleep(2)
            self.join_voice()
            return True
        except Exception as e:
            self.log("ERROR", f"Connection failed: {e}")
            return False

    def start(self):
        if not TOKEN:
            self.log("ERROR", "Token not found in environment variables.")
            return

        if self.connect():
            print("\n" + "="*50)
            print("       BOT STARTED SUCCESSFULLY")
            print("="*50)
            print(f" USER        : {self.username}")
            print(f" GUILD       : {GUILD_ID}")
            print(f" CHANNEL     : {CHANNEL_ID}")
            print(f" AUTO REPLY  : {'ENABLED' if AUTO_REPLY else 'DISABLED'}")
            if AUTO_REPLY:
                print(f" TRIGGER     : '{REPLY_TRIGGER}'")
                print(f" REPLY MSG   : '{REPLY_MESSAGE}'")
            print("="*50 + "\n")

            last_hb = 0
            while self.is_running:
                time.sleep(60)
                if self.heartbeat_count == last_hb:
                    self.log("RETRY", "Stalled connection detected. Restarting...")
                    self.connect()
                else:
                    v_status = "CONNECTED" if self.is_in_voice else "WAITING"
                    self.log("INFO", f"Heartbeat: {self.heartbeat_count} | Voice: {v_status}")
                    last_hb = self.heartbeat_count

if __name__ == "__main__":
    bot = DiscordVoiceBot()
    try:
        bot.start()
    except KeyboardInterrupt:
        bot.is_running = False
        print("\nShutting down...")