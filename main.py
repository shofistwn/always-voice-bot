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
REPLY_DELAY = int(os.getenv("REPLY_DELAY", "5"))
VOICE_LIMIT = int(os.getenv("VOICE_LIMIT", "0"))

class AlwaysVoiceBot:
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
        self.headers = {
            "Authorization": TOKEN,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
        self.voice_users = set()
        self.last_join_attempt = 0 

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
                if self.heartbeat_interval:
                    time.sleep(self.heartbeat_interval / 1000)
                    if self.ws and self.ws.connected:
                        self.ws.send(json.dumps({"op": 1, "d": self.last_sequence}))
                        self.heartbeat_count += 1
            except Exception:
                break

    def join_voice(self):
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
        while self.is_running and self.ws:
            try:
                msg = self.ws.recv()
                if not msg: break

                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    continue

                op, t, d, s = data.get('op'), data.get('t'), data.get('d', {}), data.get('s')

                if s: self.last_sequence = s
                if op == 11: continue

                if op == 9: 
                    self.log("WARN", "Invalid session (OP 9). Resetting session entirely to prevent loop...")
                    self.session_id = None
                    self.resume_gateway_url = None
                    time.sleep(1)
                    break

                if op == 7: 
                    self.log("WARN", "Discord requested reconnect. Reconnecting immediately...")
                    break

                if t == 'READY':
                    self.session_id = d.get('session_id')
                    self.resume_gateway_url = d.get('resume_gateway_url')
                    self.user_id = d.get('user', {}).get('id')
                    self.log("SUCCESS", f"Connected as {d.get('user', {}).get('username')}")
                    self.is_in_voice = False
                    self.last_join_attempt = 0
                    self.join_voice()

                elif t == 'RESUMED':
                    self.log("SUCCESS", f"Session resumed successfully (seq: {self.last_sequence})")
                    self.is_in_voice = False
                    self.last_join_attempt = 0
                    self.join_voice()

                elif t == 'GUILD_CREATE':
                    if d.get('id') != GUILD_ID:
                        continue
                    self.voice_users = set()
                    for vs in d.get('voice_states', []):
                        if vs.get('channel_id') == CHANNEL_ID:
                            self.voice_users.add(str(vs.get('user_id')))
                    self.check_voice_limit()

                elif t == 'VOICE_STATE_UPDATE':
                    if str(d.get('user_id')) == self.user_id:
                        was_in_voice = self.is_in_voice
                        self.is_in_voice = d.get('channel_id') is not None
                        if was_in_voice and not self.is_in_voice:
                            self.log("WARN", "Bot disconnected from voice. Force rejoining in 5 seconds...")
                            time.sleep(5)
                            self.last_join_attempt = 0
                            self.join_voice()
                            continue

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
                self.log("ERROR", f"Message receiver error: {e}")
                break

    def send_reply(self, channel_id):
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
        try:
            if self.ws:
                try: self.ws.close()
                except: pass

            attempting_resume = bool(self.session_id and self.last_sequence and self.resume_gateway_url)

            if attempting_resume:
                gateway_url = f"{self.resume_gateway_url}?v=10&encoding=json"
                self.log("INFO", f"Connecting to resume gateway...")
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
                            "activities": [],
                            "since": None
                        },
                        "intents": 641 
                    }
                }))

            Thread(target=self.send_heartbeat, daemon=True).start()
            return True
        except Exception as e:
            self.log("ERROR", f"Connection failed: {e}")
            self.session_id = None
            self.resume_gateway_url = None
            return False

    def start(self):
        if not TOKEN:
            self.log("ERROR", "No token provided. Please set the TOKEN environment variable.")
            return

        while self.is_running:
            if self.connect():
                time.sleep(2)
                self.handle_messages()

            self.log("WARN", "Gateway connection lost. Retrying in 5 seconds...")
            time.sleep(5)

if __name__ == "__main__":
    bot = AlwaysVoiceBot()
    try:
        bot.start()
    except KeyboardInterrupt:
        bot.is_running = False
        print("\nShutting down bot process...")