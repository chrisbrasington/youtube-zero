"""Pure utility helpers for youtube-zero.

No I/O, no global state. Safe to import from any module. Functions grouped by
concern: time/quiet-hours, video classification, URL/input parsing.
"""
import re
from datetime import datetime, timedelta, timezone

from const import QUIET_START, QUIET_END, SHORTS_MAX_SECONDS, TZ_NAME


# ── Time / quiet hours ───────────────────────────────────────────────────────

def _local_now() -> datetime:
    """Return now() in the configured TZ, falling back to UTC if zoneinfo fails."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(TZ_NAME))
    except Exception:
        return datetime.now(timezone.utc)


def is_quiet_hour() -> bool:
    if QUIET_START == QUIET_END:
        return False
    h = _local_now().hour
    if QUIET_START < QUIET_END:
        return QUIET_START <= h < QUIET_END
    return h >= QUIET_START or h < QUIET_END  # wraps midnight


def seconds_to_next_hour() -> float:
    now = _local_now()
    nxt = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
    return (nxt - now).total_seconds()


# ── Duration parsing ─────────────────────────────────────────────────────────

def duration_seconds(dur: str) -> int:
    """Parse "h:mm:ss" or "m:ss" to total seconds. Returns 0 on parse failure."""
    if not dur:
        return 0
    parts = dur.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        pass
    return 0


def parse_duration(iso: str) -> str:
    """Convert YouTube's ISO-8601 duration (PT4M33S) to display form (4:33)."""
    if not iso:
        return ""
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso)
    if not m:
        return ""
    h = int(m.group(1) or 0)
    mn = int(m.group(2) or 0)
    s = int(m.group(3) or 0)
    return f"{h}:{mn:02d}:{s:02d}" if h else f"{mn}:{s:02d}"


def is_short(v: dict) -> bool:
    """A video is a Short if it's not live and shorter than SHORTS_MAX_SECONDS."""
    if (v.get("is_live") or "none") != "none":
        return False
    dur = v.get("duration") or ""
    if not dur:
        return False
    secs = duration_seconds(dur)
    return 0 < secs < SHORTS_MAX_SECONDS


# ── YouTube URL / channel input parsing ──────────────────────────────────────

_YT_VIDEO_PATTERNS = [
    r"youtu\.be/([A-Za-z0-9_-]{11})",
    r"youtube\.com/watch\?[^#]*v=([A-Za-z0-9_-]{11})",
    r"youtube\.com/shorts/([A-Za-z0-9_-]{11})",
    r"youtube\.com/embed/([A-Za-z0-9_-]{11})",
    r"youtube\.com/live/([A-Za-z0-9_-]{11})",
]
_YT_BARE_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def parse_yt_video_id(url: str) -> str | None:
    """Extract an 11-char YouTube video id from any of the common URL forms."""
    url = (url or "").strip()
    if not url:
        return None
    for p in _YT_VIDEO_PATTERNS:
        m = re.search(p, url)
        if m:
            return m.group(1)
    if _YT_BARE_ID.fullmatch(url):
        return url
    return None


def parse_channel_input(inp: str):
    """Classify a user-typed channel reference. Returns ('id'|'handle', value)."""
    inp = inp.strip()
    m = re.search(r"youtube\.com/channel/(UC[A-Za-z0-9_-]+)", inp)
    if m:
        return "id", m.group(1)
    m = re.search(r"youtube\.com/@([A-Za-z0-9_.-]+)", inp)
    if m:
        return "handle", m.group(1)
    if re.fullmatch(r"UC[A-Za-z0-9_-]{20,}", inp):
        return "id", inp
    if inp.startswith("@"):
        return "handle", inp[1:]
    return "handle", inp
