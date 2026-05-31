"""
In-memory cast screen registry + remote-control command vocabulary.

Mirrors how signal_send.py isolates the Signal feature: this module owns the
ephemeral state for *screens* (devices sitting on /watch waiting for content)
and the set of remote-control commands a phone can send them.

A screen exists only while its SSE command channel is connected. A short grace
window on disconnect absorbs EventSource's automatic reconnects so a screen
doesn't flicker offline/online mid-playback. Every connection gets a monotonic
token; a stale connection's cleanup is ignored once a newer one has registered,
which makes reconnects idempotent regardless of which callback runs first.

Nothing here is persisted — restart the server and all screens drop.
"""
import asyncio
import re
from typing import Optional

from pydantic import BaseModel, field_validator


# Live remote-control actions a phone may push to a connected screen. Starting a
# new playlist goes through the dedicated /play route, not this set. `seek`
# carries a `value` (seconds); `fullscreen` toggles fullscreen on the screen.
CAST_ACTIONS = {"pause", "resume", "next", "prev", "mark_next", "jump",
                "stop", "seek", "fullscreen", "cc"}

OFFLINE_GRACE_SECONDS = 8
_NAME_MAX = 40


class CastVideo(BaseModel):
    video_id: str
    title: str = ""
    channel_name: str = ""
    thumbnail_url: str = ""
    duration: str = ""

    # Feed/queue items often carry null (or numeric) fields; never reject on them
    # — a missing optional field just becomes "". Without this, one null in the
    # jump list 422s the whole /play or /status request.
    @field_validator("title", "channel_name", "thumbnail_url", "duration", mode="before")
    @classmethod
    def _coerce_str(cls, v):
        return "" if v is None else str(v)


class CastPlayReq(BaseModel):
    videos: list[CastVideo]
    start_id: Optional[str] = None
    start_seconds: Optional[float] = None   # resume offset for the start video (transfer)
    mark_mode: str = "queue"   # "queue" → mark watched; "read" → mark read; "none"


class CastCommandReq(BaseModel):
    action: str
    video_id: Optional[str] = None
    value: Optional[float] = None   # seek target in seconds


class CastStatusReq(BaseModel):
    video_id: Optional[str] = None
    title: str = ""
    player_state: Optional[int] = None
    index: int = 0
    count: int = 0
    current_time: float = 0
    duration: float = 0
    videos: Optional[list[CastVideo]] = None   # sent only when the jump list changes


class _Screen:
    __slots__ = ("name", "queue", "status", "offline_timer", "token")

    def __init__(self, name: str, token: int):
        self.name = name
        self.queue: asyncio.Queue = asyncio.Queue()
        self.status: Optional[dict] = None
        self.offline_timer: Optional[asyncio.TimerHandle] = None
        self.token = token


_screens: dict[str, _Screen] = {}


def sanitize_name(name: Optional[str]) -> str:
    if not name:
        return "Screen"
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return cleaned[:_NAME_MAX] or "Screen"


def register_screen(screen_id: str, name: str) -> tuple[asyncio.Queue, int, bool]:
    """Add or replace a screen. Returns (command_queue, token, is_new).

    is_new is False when an existing screen reconnected — the caller should
    suppress a redundant screen_online broadcast. A fresh queue is handed out
    each time so commands buffered against a dead connection are dropped.
    """
    existing = _screens.get(screen_id)
    if existing is not None:
        if existing.offline_timer is not None:
            existing.offline_timer.cancel()
            existing.offline_timer = None
        existing.name = name
        existing.queue = asyncio.Queue()
        existing.token += 1
        return existing.queue, existing.token, False
    screen = _Screen(name, token=1)
    _screens[screen_id] = screen
    return screen.queue, screen.token, True


def schedule_drop(screen_id: str, token: int, on_offline) -> None:
    """Start the grace timer for a disconnected connection.

    No-ops if a newer connection has already superseded this one (token
    mismatch). If the screen doesn't reconnect within OFFLINE_GRACE_SECONDS it
    is removed and the on_offline() coroutine is scheduled.
    """
    screen = _screens.get(screen_id)
    if screen is None or screen.token != token:
        return  # superseded by a newer connection — nothing to clean up
    loop = asyncio.get_event_loop()

    def _expire():
        s = _screens.get(screen_id)
        if s is None or s.token != token:
            return
        _screens.pop(screen_id, None)
        asyncio.create_task(on_offline())

    if screen.offline_timer is not None:
        screen.offline_timer.cancel()
    screen.offline_timer = loop.call_later(OFFLINE_GRACE_SECONDS, _expire)


def has_screen(screen_id: str) -> bool:
    return screen_id in _screens


def get_name(screen_id: str) -> str:
    screen = _screens.get(screen_id)
    return screen.name if screen else "Screen"


def send_command(screen_id: str, payload: dict) -> bool:
    screen = _screens.get(screen_id)
    if screen is None:
        return False
    screen.queue.put_nowait(payload)
    return True


def set_status(screen_id: str, status: dict) -> Optional[dict]:
    """Merge status into the screen's stored state and return the merged dict.

    Merging preserves keys an update omits — notably the `videos` list set on
    play — so a late-joining remote can hydrate the full jump list from
    list_screens() even after several lightweight status updates.
    """
    screen = _screens.get(screen_id)
    if screen is None:
        return None
    screen.status = {**(screen.status or {}), **status}
    return screen.status


def list_screens() -> list[dict]:
    return [
        {"id": sid, "name": s.name, "status": s.status}
        for sid, s in _screens.items()
    ]
