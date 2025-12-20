import os
import sys
import json
import time
import requests
from websocket import create_connection
from datetime import datetime
from threading import Thread

# Read from environment variables
status = os.getenv("STATUS", "dnd")  # online/dnd/idle
GUILD_ID = os.getenv("GUILD_ID", "ADD_YOUR_SERVER_ID_HERE")
CHANNEL_ID = os.getenv("CHANNEL_ID", "ADD_YOUR_CHANNEL_ID_HERE")
SELF_MUTE = os.getenv("SELF_MUTE", "True").lower() == "true"
SELF_DEAF = os.getenv("SELF_DEAF", "False").lower() == "true"

# Logging utility
def log(level, message):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    levels = {
        "INFO": "\033[92m",     # Green
        "WARN": "\033[93m",     # Yellow
        "ERROR": "\033[91m",    # Red
        "SUCCESS": "\033[96m",  # Cyan
        "DEBUG": "\033[94m"     # Blue
    }
    reset = "\033[0m"
    color = levels.get(level, "")
    print(f"[{timestamp}] {color}[{level}]{reset} {message}")
    sys.stdout.flush()

usertoken = os.getenv("TOKEN")
if not usertoken:
    log("ERROR", "Please add a token inside .env file.")
    sys.exit(1)

if GUILD_ID == "ADD_YOUR_SERVER_ID_HERE" or CHANNEL_ID == "ADD_YOUR_CHANNEL_ID_HERE":
    log("ERROR", "Please set GUILD_ID and CHANNEL_ID in .env file.")
    sys.exit(1)

headers = {"Authorization": usertoken, "Content-Type": "application/json"}

log("INFO", "Validating Discord token...")
validate = requests.get('https://canary.discordapp.com/api/v9/users/@me', headers=headers)
if validate.status_code != 200:
    log("ERROR", f"Token validation failed with status code {validate.status_code}")
    log("ERROR", "Your token might be invalid. Please check it again.")
    sys.exit(1)

log("SUCCESS", "Token validated successfully")
userinfo = requests.get('https://canary.discordapp.com/api/v9/users/@me', headers=headers).json()
username = userinfo["username"]
discriminator = userinfo["discriminator"]
userid = userinfo["id"]

# Global variables for connection management
ws = None
heartbeat_interval = None
should_run = True
heartbeat_count = 0
is_in_voice = False
last_voice_state = None

def send_heartbeat():
    """Send heartbeat to keep connection alive"""
    global heartbeat_count, ws
    while should_run and ws:
        try:
            time.sleep(heartbeat_interval / 1000)
            if ws and should_run:
                ws.send(json.dumps({"op": 1, "d": None}))
                heartbeat_count += 1
                log("DEBUG", f"Heartbeat sent #{heartbeat_count}")
        except Exception as e:
            log("ERROR", f"Heartbeat failed: {str(e)}")
            break

def join_voice_channel():
    """Send voice state update to join/rejoin channel"""
    global ws
    try:
        vc = {
            "op": 4,
            "d": {
                "guild_id": GUILD_ID,
                "channel_id": CHANNEL_ID,
                "self_mute": SELF_MUTE,
                "self_deaf": SELF_DEAF
            }
        }
        ws.send(json.dumps(vc))
        return True
    except Exception as e:
        log("ERROR", f"Failed to send voice state update: {str(e)}")
        return False

def receive_messages():
    """Receive and handle messages from Discord"""
    global ws, is_in_voice, last_voice_state
    while should_run and ws:
        try:
            if ws:
                message = ws.recv()
                if message:
                    data = json.loads(message)
                    op = data.get('op')
                    
                    if op == 10:  # Hello
                        log("DEBUG", "Received HELLO from Discord")
                    elif op == 11:  # Heartbeat ACK
                        log("DEBUG", "Heartbeat acknowledged")
                    elif op == 0:  # Dispatch
                        t = data.get('t')
                        d = data.get('d', {})
                        
                        if t == 'READY':
                            log("SUCCESS", "Session ready!")
                            
                        elif t == 'VOICE_STATE_UPDATE':
                            # Check if it's our voice state
                            user_id = d.get('user_id')
                            channel_id = d.get('channel_id')
                            guild_id = d.get('guild_id')
                            
                            if user_id == userid:
                                last_voice_state = d
                                
                                if channel_id == CHANNEL_ID and guild_id == GUILD_ID:
                                    if not is_in_voice:
                                        is_in_voice = True
                                        log("SUCCESS", "Connected to voice channel")
                                else:
                                    # We got disconnected or moved
                                    if is_in_voice or channel_id is None:
                                        is_in_voice = False
                                        log("WARN", "Disconnected from voice channel!")
                                        log("INFO", "Auto-rejoining in 3 seconds...")
                                        time.sleep(3)
                                        
                                        if join_voice_channel():
                                            log("INFO", "Rejoin request sent")
                                        else:
                                            log("ERROR", "Failed to send rejoin request")
                            
                        elif t == 'VOICE_SERVER_UPDATE':
                            log("DEBUG", "Voice server info received")
                            
        except Exception as e:
            if should_run:
                log("ERROR", f"Error receiving message: {str(e)}")
            break

def connect_and_join():
    """Connect to Discord and join voice channel"""
    global ws, heartbeat_interval, heartbeat_count, is_in_voice
    
    try:
        log("INFO", "Connecting to Discord Gateway...")
        ws = create_connection('wss://gateway.discord.gg/?v=9&encoding=json')
        
        # Receive HELLO
        hello = json.loads(ws.recv())
        heartbeat_interval = hello['d']['heartbeat_interval']
        log("DEBUG", f"Heartbeat interval: {heartbeat_interval}ms")
        
        # Send IDENTIFY
        auth = {
            "op": 2,
            "d": {
                "token": usertoken,
                "properties": {
                    "$os": "Windows 10",
                    "$browser": "Google Chrome",
                    "$device": "Windows"
                },
                "presence": {
                    "status": status,
                    "afk": False
                }
            }
        }
        
        log("INFO", "Authenticating...")
        ws.send(json.dumps(auth))
        
        # Wait a bit for READY event
        time.sleep(1)
        
        # Join voice channel
        log("INFO", "Joining voice channel...")
        if not join_voice_channel():
            return False
        
        log("SUCCESS", "Join request sent successfully")
        
        # Start heartbeat thread
        heartbeat_thread = Thread(target=send_heartbeat, daemon=True)
        heartbeat_thread.start()
        log("INFO", "Heartbeat thread started")
        
        # Start message receiver thread
        receiver_thread = Thread(target=receive_messages, daemon=True)
        receiver_thread.start()
        log("INFO", "Message receiver thread started")
        
        return True
        
    except Exception as e:
        log("ERROR", f"Failed to connect: {str(e)}")
        return False

def run_joiner():
    global should_run, ws, heartbeat_count, is_in_voice
    
    os.system("clear")
    
    log("INFO", "Bot Configuration:")
    print(f"  • User      : {username}#{discriminator}")
    print(f"  • User ID   : {userid}")
    print(f"  • Status    : {status}")
    print(f"  • Guild ID  : {GUILD_ID}")
    print(f"  • Channel ID: {CHANNEL_ID}")
    print(f"  • Self Mute : {SELF_MUTE}")
    print(f"  • Self Deaf : {SELF_DEAF}")
    print("\n" + "-"*60 + "\n")
    
    try:
        log("INFO", "Starting bot...")
        
        # Initial connection
        if not connect_and_join():
            log("ERROR", "Failed to establish initial connection")
            sys.exit(1)
        
        log("SUCCESS", "Bot is now running and staying connected!")
        log("INFO", "Auto-rejoin enabled - will rejoin if disconnected")
        log("INFO", "Monitoring connection... (Press Ctrl+C to stop)")
        
        # Keep main thread alive and monitor connection
        last_heartbeat = heartbeat_count
        check_interval = 60  # Check every 60 seconds
        
        while should_run:
            time.sleep(check_interval)
            
            # Check if heartbeat is still working
            if heartbeat_count == last_heartbeat:
                log("WARN", "Connection appears to be dead, reconnecting...")
                is_in_voice = False
                try:
                    if ws:
                        ws.close()
                except:
                    pass
                
                heartbeat_count = 0
                if not connect_and_join():
                    log("ERROR", "Reconnection failed, retrying in 10 seconds...")
                    time.sleep(10)
                    continue
            else:
                voice_status = "Connected" if is_in_voice else "Disconnected"
                log("INFO", f"Connection healthy - {heartbeat_count - last_heartbeat} heartbeats | Voice: {voice_status}")
            
            last_heartbeat = heartbeat_count
                
    except KeyboardInterrupt:
        log("WARN", "Bot stopped by user (Ctrl+C)")
        should_run = False
        if ws:
            try:
                ws.close()
            except:
                pass
        sys.exit(0)
    except Exception as e:
        log("ERROR", f"Critical error occurred: {str(e)}")
        should_run = False
        sys.exit(1)

if __name__ == "__main__":
    run_joiner()