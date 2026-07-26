"""Audio-only stream resolution for background playback.

Why this exists: the in-app player is a YouTube IFrame embed, and Chromium
suspends the embed the moment the page is backgrounded. That was measured, not
assumed — see PROSPECTS.md. A same-origin ``<audio>`` element is a different
code path and keeps playing, so audio mode feeds ``<audio>`` from here instead
of the iframe.

Two pieces:
  * ``resolve()`` — ask yt-dlp for the best audio-only format's direct URL, and
    cache it. Resolution is the slow part (a second or three of player parsing);
    the resulting googlevideo URL stays good for hours.
  * the caller (main.py) proxies the bytes, because those URLs are bound to the
    IP that resolved them and carry no CORS headers.

yt-dlp breaks periodically when YouTube changes their player. Everything here
fails soft — a resolution error returns None and the frontend falls back to the
iframe, so a broken yt-dlp costs you background audio, not playback.
"""
import asyncio
import time
from typing import Any, Dict, Optional

from const import AUDIO_CACHE_TTL, AUDIO_RESOLVE_TIMEOUT

# video_id -> (expires_at_monotonic, info dict)
_cache: Dict[str, tuple] = {}
# video_id -> Lock, so a burst of requests for one video runs yt-dlp once.
_locks: Dict[str, asyncio.Lock] = {}


def _pick_audio(info: dict) -> Optional[dict]:
    """Best audio-only format, preferring what a WebView plays most reliably."""
    formats = [
        f for f in (info.get("formats") or [])
        if f.get("url")
        and f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")      # audio-only: no muxing needed
    ]
    if not formats:
        return None

    def score(f: dict) -> tuple:
        ext = (f.get("ext") or "").lower()
        # m4a/AAC plays everywhere; opus/webm is fine in Chromium but not Safari.
        family = 2 if ext == "m4a" else 1 if ext in ("webm", "opus", "ogg") else 0
        return (family, f.get("abr") or 0, f.get("filesize") or 0)

    return max(formats, key=score)


def _mime_for(fmt: dict) -> str:
    ext = (fmt.get("ext") or "").lower()
    if ext == "m4a":
        return "audio/mp4"
    if ext in ("webm", "opus"):
        return "audio/webm"
    if ext == "ogg":
        return "audio/ogg"
    if ext == "mp3":
        return "audio/mpeg"
    return "application/octet-stream"


def _resolve_blocking(video_id: str) -> Optional[dict]:
    """Runs yt-dlp. Blocking and slow — always call via a thread."""
    try:
        from yt_dlp import YoutubeDL
    except ImportError:
        return None

    # Deliberately no `player_client` pin. Pinning android+web returned formats
    # with no URLs at all (YouTube's SABR-only experiment, yt-dlp #12482);
    # yt-dlp's own default rotation worked and, more to the point, it gets
    # updated as YouTube shifts. Pinning here means re-diagnosing that by hand.
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": AUDIO_RESOLVE_TIMEOUT,
    }
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            )
    except Exception:
        return None
    if not info:
        return None

    fmt = _pick_audio(info)
    if not fmt:
        return None
    return {
        "url": fmt["url"],
        "mime": _mime_for(fmt),
        "ext": fmt.get("ext"),
        "abr": fmt.get("abr"),
        "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
        "duration": info.get("duration"),
        "title": info.get("title"),
        "uploader": info.get("uploader"),
    }


async def resolve(video_id: str, force: bool = False) -> Optional[dict]:
    """Cached audio-format lookup. None when yt-dlp can't resolve the video."""
    now = time.monotonic()
    if not force:
        hit = _cache.get(video_id)
        if hit and hit[0] > now:
            return hit[1]

    lock = _locks.setdefault(video_id, asyncio.Lock())
    async with lock:
        # Another waiter may have filled the cache while we queued.
        hit = _cache.get(video_id)
        if not force and hit and hit[0] > time.monotonic():
            return hit[1]
        info = await asyncio.to_thread(_resolve_blocking, video_id)
        if info:
            _cache[video_id] = (time.monotonic() + AUDIO_CACHE_TTL, info)
        return info


def invalidate(video_id: str) -> None:
    """Drop a cached URL — call when upstream rejects it as expired."""
    _cache.pop(video_id, None)


def cache_stats() -> dict:
    now = time.monotonic()
    return {
        "entries": len(_cache),
        "live": sum(1 for exp, _ in _cache.values() if exp > now),
    }
