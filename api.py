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
    """Sends a prompt to the Gemini API and returns the AI-generated response.
    
    If referenced_context is provided, it is included as additional context
    so the AI understands the message being replied to.
    """
    try:
        system_instructions = [AI_SYSTEM_PROMPT]

        if referenced_context:
            system_instructions.append(
                f"The user is replying to the following message for context:\n"
                f"Author: {referenced_context['author']}\n"
                f"Content: {referenced_context['content']}"
            )

        payload = {
            "systemInstruction": {
                "parts": [{"text": "\n\n".join(system_instructions)}]
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}]
                }
            ],
            "generationConfig": {
                "maxOutputTokens": AI_MAX_TOKENS,
            },
            "tools": [
                {"google_search": {}}
            ]
        }

        response = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{AI_MODEL}:generateContent?key={AI_API_KEY}",
            headers={"Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )
        
        if response.status_code != 200:
            log("ERROR", f"Gemini API request failed with status {response.status_code}: {response.text}")
            return "Sorry, I couldn't generate a response."

        data = response.json()
        try:
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError):
            log("ERROR", f"Unexpected Gemini API response: {data}")
            return "Sorry, I couldn't generate a response."
    except Exception as e:
        log("ERROR", f"Gemini API request failed: {e}")
        return None

def extract_embed_text(embed):
    """
    Extracts core text fields from a Discord embed structure and converts them
    to a readable, plain-text format for the AI context.
    """
    parts = []
    if 'author' in embed and isinstance(embed['author'], dict) and 'name' in embed['author']:
        parts.append(f"Embed Author: {embed['author']['name']}")
    if 'title' in embed:
        parts.append(f"Embed Title: {embed['title']}")
    if 'description' in embed:
        parts.append(f"Embed Description: {embed['description']}")
    if 'fields' in embed:
        for field in embed['fields']:
            name = field.get('name', '')
            value = field.get('value', '')
            if name or value:
                parts.append(f"- {name}: {value}")
    if 'footer' in embed and isinstance(embed['footer'], dict) and 'text' in embed['footer']:
        parts.append(f"Embed Footer: {embed['footer']['text']}")
    return "\n".join(parts)

def clean_links(text):
    if not text:
        return text

    # Handle nested image-in-link: [![alt](img_url)](link_url) -> hapus semua
    text = re.sub(r'\[!\[.*?\]\((?:https?://|www\.)\S+?\)\]\((?:https?://|www\.)\S+?\)', '', text)

    # Markdown link biasa: [text](url) -> text
    text = re.sub(r'\[(.*?)\]\((?:https?://|www\.)\S+\)', r'\1', text)

    # Plain URL (case-insensitive)
    url_pattern = r'(?:https?://|www\.)([a-zA-Z0-9.-]+)(\/[^\s]*)?'

    def replace_url(match):
        host = match.group(1)
        path = match.group(2) or ''

        trailing_host = ''
        while host and host[-1] in '.,!?;:':
            trailing_host = host[-1] + trailing_host
            host = host[:-1]

        trailing_path = ''
        if path:
            while path and path[-1] in '.,!?;:':
                trailing_path = path[-1] + trailing_path
                path = path[:-1]

        if host.lower().startswith('www.'):
            host = host[4:]

        clean_host = host.replace('.', ',')
        return f"{clean_host}{path}{trailing_host}{trailing_path}"

    text = re.sub(url_pattern, replace_url, text, flags=re.IGNORECASE)
    return text

def send_ai_reply_async(channel_id, raw_content, message_data, bot_user_id, headers):
    """
    Strips the bot mention from the message, queries the Gemini API,
    and sends the response as a reply to the original message in a background thread.
    """
    def callback():
        # Remove <@USER_ID> or <@!USER_ID> mention from the message
        clean_content = re.sub(r'<@!?' + str(bot_user_id) + r'>', '', raw_content).strip()

        if not clean_content:
            return

        # Extract referenced (replied-to) message context if available (text and embeds)
        referenced_context = None
        ref_msg = None

        if message_data and message_data.get('message_reference'):
            ref_channel_id = message_data['message_reference'].get('channel_id', channel_id)
            ref_message_id = message_data['message_reference'].get('message_id')
            if ref_message_id:
                try:
                    # For self-bots (User Accounts): Fetch referenced message via the channel history endpoint.
                    # Direct message fetching (GET /messages/{id}) is restricted to official bots only.
                    resp = requests.get(
                        f"https://discord.com/api/v10/channels/{ref_channel_id}/messages?around={ref_message_id}&limit=1",
                        headers=headers,
                        timeout=10,
                    )
                    if resp.status_code == 200:
                        messages_list = resp.json()
                        if isinstance(messages_list, list) and len(messages_list) > 0:
                            for m in messages_list:
                                if str(m.get('id')) == str(ref_message_id):
                                    ref_msg = m
                                    log("INFO", f"Fetched referenced message via history API: {ref_message_id}")
                                    break
                    else:
                        log("WARN", f"Failed to fetch referenced message via history API. Status: {resp.status_code}, Response: {resp.text[:200]}")
                except Exception as e:
                    log("ERROR", f"Exception fetching referenced message via history API: {e}")

        if not ref_msg and message_data:
            ref_msg = message_data.get('referenced_message')
            if ref_msg:
                log("INFO", "Using referenced_message from gateway payload")
            else:
                log("INFO", "No referenced_message found in gateway payload")

        if ref_msg:
            ref_author = ref_msg.get('author', {})
            ref_author_name = ref_author.get('global_name') or ref_author.get('username', 'Unknown')
            
            # Extract content and any embeds
            ref_content = ref_msg.get('content', '').strip()
            embeds = ref_msg.get('embeds', [])
            log("INFO", f"Referenced message: content_length={len(ref_content)}, embeds_count={len(embeds)}")
            
            embed_texts = []
            for i, embed in enumerate(embeds):
                embed_text = extract_embed_text(embed)
                log("INFO", f"Parsed embed {i}: {embed_text[:100]}...")
                if embed_text:
                    embed_texts.append(embed_text)
            
            # Combine content and embeds
            combined_content_parts = []
            if ref_content:
                combined_content_parts.append(ref_content)
            if embed_texts:
                combined_content_parts.append("[Embed Contents]:\n" + "\n---\n".join(embed_texts))
                
            combined_content = "\n\n".join(combined_content_parts).strip()

            if combined_content:
                referenced_context = {
                    'author': ref_author_name,
                    'content': combined_content,
                }
                log("INFO", f"AI query includes replied message from {ref_author_name}: {combined_content[:80]}")
            else:
                log("WARN", "Referenced message has no text content and no parsable embeds.")

        log("INFO", f"AI query from channel {channel_id}: {clean_content[:100]}")

        ai_response = ask_ai(clean_content, referenced_context=referenced_context)
        if not ai_response:
            return

        # Remove links from the AI response before sending to Discord
        ai_response = clean_links(ai_response)

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
