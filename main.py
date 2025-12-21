import os
import sys
import json
import time
import requests
from websocket import create_connection
from datetime import datetime
from threading import Thread

# Configuration from Environment Variables
status = os.getenv("STATUS", "dnd")
GUILD_ID = os.getenv("GUILD_ID", "")
CHANNEL_ID = os.getenv("CHANNEL_ID", "")
SELF_MUTE = os.getenv("SELF_MUTE", "True").lower() == "true"
SELF_DEAF = os.getenv("SELF_DEAF", "False").lower() == "true"
AUTO_REPLY = os.getenv("AUTO_REPLY", "True").lower() == "true"
REPLY_TRIGGER = os.getenv("REPLY_TRIGGER", "hey wake up!").lower()
REPLY_MESSAGE = os.getenv("REPLY_MESSAGE", "yes")
VOICE_LIMIT = int(os.getenv("VOICE_LIMIT", "3"))

def log(level, message):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    levels = {
        "INFO": "\033[92m",    # Green
        "WARN": "\033[93m",    # Yellow
        "ERROR": "\033[91m",   # Red
        "SUCCESS": "\033[96m", # Cyan
        "RETRY": "\033[94m"    # Blue
    }
    reset = "\033[0m"
    color = levels.get(level, "")
    print(f"always-voice-bot  | [{timestamp}] [{color}{level}{reset}] {message}")
    sys.stdout.flush()

usertoken = os.getenv("TOKEN")
headers = {"Authorization": usertoken, "Content-Type": "application/json"}

# Global variables
ws = None
heartbeat_interval = None
should_run = True
heartbeat_count = 0
is_in_voice = False
voice_users = set()
userid = None
username = "Unknown"

def join_voice_channel():
    global ws
    try:
        ws.send(json.dumps({
            "op": 4,
            "d": {
                "guild_id": str(GUILD_ID),
                "channel_id": str(CHANNEL_ID),
                "self_mute": SELF_MUTE,
                "self_deaf": SELF_DEAF
            }
        }))
        log("INFO", f"Joining channel: {CHANNEL_ID}")
        return True
    except Exception as e:
        log("ERROR", f"Failed to join channel: {str(e)}")
        return False

def leave_voice_channel(reason="Limit reached"):
    global ws, is_in_voice
    try:
        ws.send(json.dumps({
            "op": 4,
            "d": {
                "guild_id": str(GUILD_ID),
                "channel_id": None,
                "self_mute": SELF_MUTE,
                "self_deaf": SELF_DEAF
            }
        }))
        is_in_voice = False
        log("WARN", f"Leaving channel. Reason: {reason}")
        return True
    except Exception as e:
        log("ERROR", f"Failed to leave channel: {str(e)}")
        return False

def send_heartbeat():
    global heartbeat_count, ws
    while should_run and ws:
        try:
            time.sleep(heartbeat_interval / 1000)
            if ws:
                ws.send(json.dumps({"op": 1, "d": None}))
                heartbeat_count += 1
        except: break

def receive_messages():
    global ws, is_in_voice, voice_users, userid
    while should_run and ws:
        try:
            message = ws.recv()
            if not message: break
            data = json.loads(message)
            t, d, op = data.get('t'), data.get('d', {}), data.get('op')

            if t == 'VOICE_STATE_UPDATE':
                u_id = str(d.get('user_id'))
                c_id = str(d.get('channel_id')) if d.get('channel_id') else None
                
                if c_id == str(CHANNEL_ID):
                    if u_id != str(userid): voice_users.add(u_id)
                else:
                    voice_users.discard(u_id)

                count = len(voice_users)
                
                if u_id == str(userid):
                    is_in_voice = (c_id == str(CHANNEL_ID))
                    if c_id is None:
                        log("WARN", "You were disconnected from the channel.")
                        if count < VOICE_LIMIT:
                            log("RETRY", f"Channel has space ({count}/{VOICE_LIMIT}). Reconnecting...")
                            time.sleep(2)
                            join_voice_channel()
                
                if count >= VOICE_LIMIT and is_in_voice:
                    leave_voice_channel(f"Channel is full ({count} users)")
                elif count < VOICE_LIMIT and not is_in_voice:
                    log("INFO", f"Channel has space ({count}/{VOICE_LIMIT}). Entering...")
                    join_voice_channel()

            elif t == 'MESSAGE_CREATE' and AUTO_REPLY:
                if str(d.get('author', {}).get('id')) != str(userid):
                    content = d.get('content', '').lower()
                    if str(userid) in [str(m.get('id')) for m in d.get('mentions', [])] and REPLY_TRIGGER in content:
                        requests.post(f"https://discord.com/api/v9/channels/{d.get('channel_id')}/messages", 
                                      headers=headers, json={"content": REPLY_MESSAGE})
                        log("SUCCESS", f"Replied to mention in channel: {d.get('channel_id')}")
        except: break

def connect_and_join():
    global ws, heartbeat_interval, userid, username
    try:
        log("INFO", "Connecting to Discord...")
        ws = create_connection('wss://gateway.discord.gg/?v=9&encoding=json')
        hello = json.loads(ws.recv())
        heartbeat_interval = hello['d']['heartbeat_interval']
        
        ws.send(json.dumps({
            "op": 2,
            "d": {
                "token": usertoken,
                "properties": {"$os": "linux", "$browser": "chrome", "$device": "pc"},
                "presence": {"status": status, "afk": False},
                "intents": 641 
            }
        }))
        
        me = requests.get('https://discord.com/api/v9/users/@me', headers=headers).json()
        userid = me['id']
        username = me['username']
        log("SUCCESS", f"Logged in as: {username}")
        
        Thread(target=send_heartbeat, daemon=True).start()
        Thread(target=receive_messages, daemon=True).start()
        
        time.sleep(2)
        join_voice_channel()
        return True
    except Exception as e:
        log("ERROR", f"Login failed: {e}")
        return False

def print_startup_info():
    print("\n" + "="*50)
    print("       ALWAYS-VOICE BOT INITIALIZED")
    print("="*50)
    print(f" USERNAME     : {username}")
    print(f" GUILD ID     : {GUILD_ID}")
    print(f" CHANNEL ID   : {CHANNEL_ID}")
    print(f" VOICE LIMIT  : {VOICE_LIMIT} users")
    print(f" AUTO REPLY   : {'ENABLED' if AUTO_REPLY else 'DISABLED'}")
    if AUTO_REPLY:
        print(f" TRIGGER      : '{REPLY_TRIGGER}'")
        print(f" REPLY MSG    : '{REPLY_MESSAGE}'")
    print("="*50 + "\n")

def run_bot():
    global heartbeat_count, should_run
    
    # Pre-validation for visual feedback
    if not usertoken:
        log("ERROR", "No token found in environment variables.")
        sys.exit(1)
        
    if not connect_and_join(): 
        sys.exit(1)
    
    # Display config after successful connection
    print_startup_info()
    
    last_count = 0
    while should_run:
        time.sleep(60)
        # Check if heartbeat is still ticking
        if heartbeat_count == last_count:
            log("RETRY", "Connection lost. Reconnecting...")
            connect_and_join()
        else:
            status_text = "IN_VOICE" if is_in_voice else "WAITING/FULL"
            log("INFO", f"Heartbeat: {heartbeat_count} | Status: {status_text} | Users: {len(voice_users)}")
        last_count = heartbeat_count

if __name__ == "__main__":
    try:
        run_bot()
    except KeyboardInterrupt:
        should_run = False
        log("WARN", "Shutting down bot...")
        sys.exit(0)