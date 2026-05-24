"""Signal-cli outbound message primitives.

Thin async wrappers around the signal-cli-rest-api `/v2/send` endpoint. The
big inbound command handler and websocket listener stay in main.py because
they pull in too many cross-module helpers (channel feed, queue, refresh,
broadcast) — extracting those is a separate task.

Functions here never raise on network failure; they either return a string
error (for the per-video send) or silently swallow (for plain text).
"""
import base64

import httpx

from const import HTTP_TIMEOUT_LONG, SIGNAL_API_URL
from queries import get_queue


async def signal_send_plain(number: str, message: str) -> None:
    """Best-effort plain-text send. Failures are swallowed."""
    payload = {"message": message, "number": number, "recipients": [number]}
    async with httpx.AsyncClient() as client:
        try:
            await client.post(
                f"{SIGNAL_API_URL}/v2/send",
                json=payload,
                timeout=HTTP_TIMEOUT_LONG,
            )
        except Exception:
            pass


async def signal_preview(
    video_id: str, title: str, channel_name: str, thumbnail_url: str
) -> dict | None:
    """Fetch a thumbnail and build a signal-cli link_preview object.

    Returns None on any failure — Signal-cli still accepts the message body,
    it just won't render the rich preview card.
    """
    if not thumbnail_url:
        print(f"[signal] no thumbnail_url for {video_id}")
        return None
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(thumbnail_url, timeout=10, follow_redirects=True)
        print(f"[signal] thumbnail fetch {thumbnail_url} → {r.status_code} ({len(r.content)} bytes)")
        if r.status_code == 200:
            return {
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "title": title,
                "description": channel_name,
                "base64_thumbnail": base64.b64encode(r.content).decode(),
            }
    except Exception as exc:
        print(f"[signal] thumbnail fetch error: {exc}")
    return None


async def signal_send_one(
    number: str,
    video_id: str,
    title: str,
    channel_name: str,
    thumbnail_url: str,
) -> str | None:
    """Send one video to Signal with a link preview. Returns error string or None."""
    message = f"https://www.youtube.com/watch?v={video_id}"
    preview = await signal_preview(video_id, title, channel_name, thumbnail_url)
    payload: dict = {"message": message, "number": number, "recipients": [number]}
    if preview:
        payload["link_preview"] = preview
    print(f"[signal] sending {video_id} {'with' if preview else 'without'} preview")
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(
                f"{SIGNAL_API_URL}/v2/send",
                json=payload,
                timeout=HTTP_TIMEOUT_LONG,
            )
        except Exception as exc:
            return str(exc)
    print(f"[signal] send response: {r.status_code} {r.text[:300]}")
    if r.status_code not in (200, 201):
        return r.text[:200]
    return None


async def send_queue_to_signal(number: str, is_deep: bool = False) -> list[str]:
    """Push every unwatched item in the main (or deep) queue to Signal."""
    items = get_queue(is_deep=is_deep)
    for item in items:
        await signal_send_one(
            number,
            item["video_id"],
            item["title"],
            item["channel_name"],
            item.get("thumbnail_url") or "",
        )
    return [i["video_id"] for i in items]
