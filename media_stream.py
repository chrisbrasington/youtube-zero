"""Stream resolution for server-delivered playback.

Why this exists: the YouTube IFrame embed is suspended by Chromium the moment
the page is backgrounded. That was measured, not assumed — see PROSPECTS.md.
Same-origin media elements are not, so playing through <audio>/<video> fed by
this module is what makes background playback work at all.

One yt-dlp lookup returns every format for a video, so the raw info dict is what
gets cached; the audio and video pickers both read from it. Resolution is the
slow part (a second or three of player parsing) and the resulting googlevideo
URLs stay good for hours.

Everything fails soft — a resolution error returns None and the frontend falls
back to the iframe, so a broken yt-dlp costs background playback, not playback.
"""
import asyncio
import subprocess
import time
from typing import Dict, Optional

from const import (
    AUDIO_CACHE_TTL,
    AUDIO_RESOLVE_TIMEOUT,
    FFPROBE_BIN,
    KEYFRAME_PROBE_WINDOW,
    SERVER_VIDEO_MAX_HEIGHT,
)

# video_id -> (expires_at_monotonic, raw yt-dlp info dict)
_cache: Dict[str, tuple] = {}
# video_id -> Lock, so a burst of requests for one video runs yt-dlp once.
_locks: Dict[str, asyncio.Lock] = {}


def _extract_blocking(video_id: str) -> Optional[dict]:
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
            return ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            )
    except Exception:
        return None


async def info(video_id: str, force: bool = False) -> Optional[dict]:
    """Cached raw yt-dlp info. Shared by the audio and video pickers."""
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
        data = await asyncio.to_thread(_extract_blocking, video_id)
        if data:
            _cache[video_id] = (time.monotonic() + AUDIO_CACHE_TTL, data)
        return data


def invalidate(video_id: str) -> None:
    """Drop a cached lookup — call when upstream rejects a URL as expired."""
    _cache.pop(video_id, None)


def cache_stats() -> dict:
    now = time.monotonic()
    return {
        "entries": len(_cache),
        "live": sum(1 for exp, _ in _cache.values() if exp > now),
    }


# ── Format pickers ────────────────────────────────────────────────────────────

def _usable(data: dict) -> list:
    return [f for f in (data.get("formats") or []) if f.get("url")]


def _audio_only(data: dict) -> list:
    return [
        f for f in _usable(data)
        if f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none")
    ]


def _video_only(data: dict) -> list:
    return [
        f for f in _usable(data)
        if f.get("vcodec") not in (None, "none") and f.get("acodec") in (None, "none")
    ]


def _mime_for(fmt: dict) -> str:
    ext = (fmt.get("ext") or "").lower()
    return {
        "m4a": "audio/mp4",
        "webm": "audio/webm",
        "opus": "audio/webm",
        "ogg": "audio/ogg",
        "mp3": "audio/mpeg",
    }.get(ext, "application/octet-stream")


def pick_audio(data: dict) -> Optional[dict]:
    """Best audio-only format, preferring what a WebView plays most reliably."""
    formats = _audio_only(data)
    if not formats:
        return None

    def score(f: dict) -> tuple:
        ext = (f.get("ext") or "").lower()
        # m4a/AAC plays everywhere; opus/webm is fine in Chromium but not Safari.
        family = 2 if ext == "m4a" else 1 if ext in ("webm", "opus", "ogg") else 0
        return (family, f.get("abr") or 0, f.get("filesize") or 0)

    return max(formats, key=score)


def pick_video_pair(data: dict, max_height: int = SERVER_VIDEO_MAX_HEIGHT) -> Optional[dict]:
    """Best video+audio pair for an ffmpeg ``-c copy`` remux.

    Anything above 360p is DASH — separate video and audio streams — so the
    server has to put them back together. H.264 + AAC is preferred because that
    pair remuxes into MP4 with no re-encoding and plays everywhere; VP9/AV1 +
    Opus is the fallback and goes into WebM. Both are stream copies, so neither
    costs CPU beyond the muxing itself.
    """
    vids = [f for f in _video_only(data) if (f.get("height") or 0) <= max_height]
    auds = _audio_only(data)
    if not vids or not auds:
        return None

    def best(formats, pred, key):
        matches = [f for f in formats if pred(f)]
        return max(matches, key=key) if matches else None

    by_height = lambda f: (f.get("height") or 0, f.get("tbr") or 0)
    by_abr = lambda f: f.get("abr") or 0

    v = best(vids, lambda f: (f.get("vcodec") or "").startswith("avc1"), by_height)
    a = best(auds, lambda f: (f.get("acodec") or "").startswith("mp4a"), by_abr)
    container, mime = "mp4", "video/mp4"

    if not (v and a):
        # No H.264 rendition — fall back to the VP9/AV1 side and mux to WebM.
        v = best(vids, lambda f: (f.get("vcodec") or "").startswith(("vp9", "vp09", "av01")), by_height)
        a = best(auds, lambda f: (f.get("acodec") or "").startswith("opus"), by_abr)
        container, mime = "webm", "video/webm"

    if not (v and a):
        return None
    return {
        "video_url": v["url"],
        "audio_url": a["url"],
        "container": container,
        "mime": mime,
        "height": v.get("height"),
        "vcodec": v.get("vcodec"),
        "acodec": a.get("acodec"),
        "tbr": v.get("tbr"),
    }


# ── Public resolvers ──────────────────────────────────────────────────────────

async def resolve_audio(video_id: str, force: bool = False) -> Optional[dict]:
    data = await info(video_id, force=force)
    if not data:
        return None
    fmt = pick_audio(data)
    if not fmt:
        return None
    return {
        "url": fmt["url"],
        "mime": _mime_for(fmt),
        "ext": fmt.get("ext"),
        "abr": fmt.get("abr"),
        "filesize": fmt.get("filesize") or fmt.get("filesize_approx"),
        "duration": data.get("duration"),
        "title": data.get("title"),
        "uploader": data.get("uploader"),
    }


# video_id -> sorted list of known keyframe timestamps
_keyframes: Dict[str, list] = {}


def _probe_keyframes_blocking(url: str, around: float) -> list:
    """Video keyframe timestamps near `around`. Blocking — call via a thread."""
    start = max(0.0, around - KEYFRAME_PROBE_WINDOW)
    cmd = [
        FFPROBE_BIN, "-v", "error",
        "-select_streams", "v:0",
        "-skip_frame", "nokey",
        "-show_entries", "frame=pts_time",
        "-of", "csv=p=0",
        "-read_intervals", f"{start}%+{KEYFRAME_PROBE_WINDOW * 2}",
        url,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=AUDIO_RESOLVE_TIMEOUT).stdout
    except Exception:
        return []
    times = []
    for line in out.decode(errors="ignore").splitlines():
        line = line.strip().rstrip(",")
        if not line:
            continue
        try:
            times.append(float(line))
        except ValueError:
            pass
    return sorted(times)


async def keyframe_at_or_before(video_id: str, url: str, t: float) -> float:
    """Snap a seek target back to a real video keyframe.

    Both ffmpeg inputs are seeked with the same `-ss`, but video can only start
    on a keyframe while audio starts wherever it's asked. Seeking to an
    arbitrary second therefore starts the video up to a keyframe-interval
    earlier than the audio — which is heard as audio running ahead of the
    picture, permanently, because `-c copy` normalises both to zero.

    Snapping to a keyframe makes the request exact for *both* streams, so they
    line up. Results are cached per video: the first seek pays for the probe,
    later ones are free.
    """
    if t <= 0:
        return 0.0
    known = _keyframes.get(video_id) or []
    hit = [k for k in known if k <= t + 0.001]
    # Trust the cache only if we also know of a keyframe after t, otherwise we
    # may be looking at a stale window that happens to end before it.
    if hit and any(k > t for k in known):
        return max(hit)

    found = await asyncio.to_thread(_probe_keyframes_blocking, url, t)
    if found:
        merged = sorted(set(known) | set(found))
        _keyframes[video_id] = merged
        before = [k for k in merged if k <= t + 0.001]
        if before:
            return max(before)
    return t          # probe failed — no worse than before


async def resolve_video(video_id: str, force: bool = False) -> Optional[dict]:
    data = await info(video_id, force=force)
    if not data:
        return None
    pair = pick_video_pair(data)
    if not pair:
        return None
    return {
        **pair,
        "duration": data.get("duration"),
        "title": data.get("title"),
        "uploader": data.get("uploader"),
    }
