from config import (
    RICH_PRESENCE_APP_ID,
    RICH_PRESENCE_NAME,
    RICH_PRESENCE_DETAILS,
    RICH_PRESENCE_STATE,
    RICH_PRESENCE_BUTTON1_LABEL,
    RICH_PRESENCE_BUTTON1_URL,
    RICH_PRESENCE_BUTTON2_LABEL,
    RICH_PRESENCE_BUTTON2_URL
)

def build_rich_presence_activities(start_timestamp):
    """Builds the Rich Presence activity list."""
    if RICH_PRESENCE_APP_ID:
        playing_activity = {
            "name": RICH_PRESENCE_NAME,
            "type": 0,
            "application_id": RICH_PRESENCE_APP_ID,
            "timestamps": {
                "start": start_timestamp
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
                "start": start_timestamp
            }
        }
        if RICH_PRESENCE_DETAILS:
            playing_activity["details"] = RICH_PRESENCE_DETAILS

    return [playing_activity]
