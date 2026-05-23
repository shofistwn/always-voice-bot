"""
AlwaysVoiceBot Module

A Discord self-bot script designed to maintain a presence in a specific voice channel.
This script employs a "fail-fast" architecture: any connection drop, invalid session, 
or unhandled exception will immediately terminate the process (sys.exit(1)). 
This relies on Docker's `restart: unless-stopped` policy to handle clean recoveries.
"""

from bot import AlwaysVoiceBot

if __name__ == "__main__":
    bot = AlwaysVoiceBot()
    try:
        bot.start()
    except KeyboardInterrupt:
        bot.is_running = False
        print("\\nShutting down bot process...")