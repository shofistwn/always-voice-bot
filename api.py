import re
import time
import requests
from threading import Thread

from config import (
    REPLY_DELAY,
    REPLY_MESSAGE,
    AI_SYSTEM_PROMPT,
    AI_API_KEY,
    AI_MODEL,
    AI_MAX_TOKENS
)
from utils import log

def send_reply_async(channel_id, headers):
    """
    Dispatches an HTTP POST request in a background thread to send an auto-reply message.
    """
    def callback():
        time.sleep(REPLY_DELAY)
        try:
            requests.post(
                f"https://discord.com/api/v10/channels/{channel_id}/messages",
                headers=headers,
                json={"content": REPLY_MESSAGE},
                timeout=5
            )
            log("SUCCESS", f"Sent auto-reply to channel {channel_id}")
        except Exception:
            log("ERROR", "HTTP request for auto-reply failed.")

    Thread(target=callback, daemon=True).start()

def ask_ai(prompt, referenced_context=None):
    """Sends a prompt to the OpenRouter API and returns the AI-generated response.
    
    If referenced_context is provided, it is included as additional context
    so the AI understands the message being replied to.
    """
    try:
        messages = [{"role": "system", "content": AI_SYSTEM_PROMPT}]

        if referenced_context:
            messages.append({
                "role": "system",
                "content": f"The user is replying to the following message for context:\\n"
                           f"Author: {referenced_context['author']}\\n"
                           f"Content: {referenced_context['content']}"
            })

        messages.append({"role": "user", "content": prompt})

        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {AI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": AI_MODEL,
                "messages": messages,
                "max_tokens": AI_MAX_TOKENS,
            },
            timeout=30,
        )
        data = response.json()
        return data.get("choices", [{}])[0].get("message", {}).get("content", "Sorry, I couldn't generate a response.")
    except Exception as e:
        log("ERROR", f"OpenRouter AI request failed: {e}")
        return None

def send_ai_reply_async(channel_id, raw_content, message_data, bot_user_id, headers):
    """
    Strips the bot mention from the message, queries the OpenRouter AI,
    and sends the response as a reply to the original message in a background thread.
    """
    def callback():
        # Remove <@USER_ID> or <@!USER_ID> mention from the message
        clean_content = re.sub(r'<@!?' + str(bot_user_id) + r'>', '', raw_content).strip()

        if not clean_content:
            return

        # Extract referenced (replied-to) message context if available (text only)
        referenced_context = None
        ref_msg = None

        if message_data and message_data.get('message_reference'):
            ref_channel_id = message_data['message_reference'].get('channel_id', channel_id)
            ref_message_id = message_data['message_reference'].get('message_id')
            if ref_message_id:
                try:
                    resp = requests.get(
                        f"https://discord.com/api/v10/channels/{ref_channel_id}/messages/{ref_message_id}",
                        headers=headers,
                        timeout=10,
                    )
                    if resp.status_code == 200:
                        ref_msg = resp.json()
                        log("INFO", f"Fetched referenced message via API: {ref_message_id}")
                except Exception:
                    pass

        if not ref_msg and message_data:
            ref_msg = message_data.get('referenced_message')

        if ref_msg:
            ref_author = ref_msg.get('author', {})
            ref_author_name = ref_author.get('global_name') or ref_author.get('username', 'Unknown')
            ref_content = ref_msg.get('content', '').strip()

            if ref_content:
                referenced_context = {
                    'author': ref_author_name,
                    'content': ref_content,
                }
                log("INFO", f"AI query includes replied message from {ref_author_name}: {ref_content[:80]}")

        log("INFO", f"AI query from channel {channel_id}: {clean_content[:100]}")

        ai_response = ask_ai(clean_content, referenced_context=referenced_context)
        if not ai_response:
            return

        # Discord message limit is 2000 characters
        if len(ai_response) > 2000:
            ai_response = ai_response[:1997] + "..."

        try:
            message_id = message_data.get('id') if message_data else None
            payload = {"content": ai_response}
            if message_id:
                payload["message_reference"] = {"message_id": message_id}
            requests.post(
                f"https://discord.com/api/v10/channels/{channel_id}/messages",
                headers=headers,
                json=payload,
                timeout=10,
            )
            log("SUCCESS", f"Sent AI reply to channel {channel_id}")
        except Exception:
            log("ERROR", "HTTP request for AI reply failed.")

    Thread(target=callback, daemon=True).start()
