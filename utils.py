import sys
from datetime import datetime

def log(level, message):
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
