import asyncio
import json
import os
import random
import re
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import websockets
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

from const import (
    ADB_API_URL,
    DAILY_QUOTA_LIMIT,
    DB_PATH,
    HTTP_TIMEOUT_LONG,
    HTTP_TIMEOUT_SHORT,
    QUIET_END,
    QUIET_START,
    REFRESH_BACKOFF_SECONDS,
    REFRESH_CONCURRENCY,
    REFRESH_INTERVAL,
    SIGNAL_API_URL,
    SIGNAL_RECONNECT_PAUSE,
    TZ_NAME,
    USE_NOCOOKIE,
    YT_API,
    YT_CHUNK_SIZE,
    YT_EMBED_HOST,
)
from helpers import (
    duration_seconds as _duration_seconds,
    is_quiet_hour as _is_quiet_hour,
    is_short as _is_short,
    parse_channel_input,
    parse_duration,
    parse_yt_video_id as _parse_yt_video_id,
    seconds_to_next_hour as _seconds_to_next_hour,
)
from queries import (
    add_quota,
    clear_queue,
    clear_video_status_for_channel,
    count_history,
    delete_setting,
    get_all_settings,
    get_history,
    get_queue,
    get_quota_today_units,
    get_setting,
    delete_screen_beacon,
    list_channels,
    list_folders,
    list_screen_beacons,
    max_last_refreshed,
    next_queue_sort_order,
    record_watched,
    quota_today as _quota_today,
    session_quota_units,
    set_setting,
    unwatched_queue_video_ids,
    update_screen_beacon,
    upsert_screen_beacon,
)


_event_listeners: set[asyncio.Queue] = set()


async def _broadcast(event_type: str, **extra):
    payload = {"type": event_type, **extra}
    for q in list(_event_listeners):
        await q.put(payload)


async def _refresh_channels(api_key: str) -> list[dict]:
    """Parallel refresh all channels (sem=5), save, broadcast. Returns per-channel results."""
    channels = list_channels()
    total = len(channels)
    sem = asyncio.Semaphore(REFRESH_CONCURRENCY)
    lock = asyncio.Lock()
    started = 0

    async def fetch_one(ch):
        nonlocal started
        async with sem:
            async with lock:
                started += 1
                name = ch.get("handle") or ch.get("name") or ch["channel_id"]
                await _broadcast("refresh_progress", i=started, total=total, name=name)
                await asyncio.sleep(REFRESH_BACKOFF_SECONDS)
            try:
                videos = await yt_fetch_videos(ch["uploads_playlist_id"], api_key)
                save_videos(ch["channel_id"], videos)
                return {"channel_id": ch["channel_id"], "count": len(videos)}
            except Exception as e:
                return {"channel_id": ch["channel_id"], "error": str(e)}

    await _broadcast("refresh_start", total=total)
    results = await asyncio.gather(*[fetch_one(ch) for ch in channels])
    await _broadcast("refresh_done")
    await _broadcast("refreshed")
    return list(results)


async def _background_refresh():
    if REFRESH_INTERVAL <= 0:
        return
    while True:
        wait = _seconds_to_next_hour()
        print(f"[bg refresh] next fire in {int(wait)}s (top of hour)")
        await asyncio.sleep(wait)
        try:
            if _is_quiet_hour():
                print(f"[bg refresh] quiet hours ({QUIET_START}-{QUIET_END} {TZ_NAME}) — skipping")
            else:
                api_key = get_api_key()
                if api_key:
                    await _refresh_channels(api_key)
        except Exception:
            pass


from signal_send import (
    send_queue_to_signal as _send_queue_to_signal_impl,
    signal_send_one as _signal_send_one,
    signal_send_plain as _signal_send_plain,
)


async def _send_queue_to_signal(number: str) -> list[str]:
    return await _send_queue_to_signal_impl(number, is_deep=False)


async def _send_deep_to_signal(number: str) -> list[str]:
    return await _send_queue_to_signal_impl(number, is_deep=True)


async def _send_unread_to_signal(number: str, exclude_ids: set[str] | None = None) -> int:
    exclude_ids = exclude_ids or set()
    with db() as c:
        rows = c.execute("SELECT key, value FROM settings").fetchall()
        hide_shorts = {r["key"]: r["value"] for r in rows}.get("hide_shorts", "0") == "1"
        chs = [dict(r) for r in c.execute("SELECT * FROM channels").fetchall()]
        unread = []
        for ch in chs:
            ch_allow_shorts = bool(ch.get("allow_shorts", 0))
            vids = _channel_videos(c, ch["channel_id"], ch["read_before"], set())
            for v in vids:
                if v["is_read"]:
                    continue
                if v["video_id"] in exclude_ids:
                    continue
                if hide_shorts and not ch_allow_shorts and _is_short(v):
                    continue
                v["channel_name"] = ch["name"]
                unread.append(v)
    for v in unread:
        await _signal_send_one(number, v["video_id"], v["title"], v["channel_name"], v.get("thumbnail_url") or "")
    return len(unread)


def _visible_unread_list(exclude_ids: set[str] | None = None) -> list[dict]:
    exclude_ids = exclude_ids or set()
    with db() as c:
        rows = c.execute("SELECT key, value FROM settings").fetchall()
        hide_shorts = {r["key"]: r["value"] for r in rows}.get("hide_shorts", "0") == "1"
        chs = [dict(r) for r in c.execute("SELECT * FROM channels").fetchall()]
        out = []
        for ch in chs:
            ch_allow_shorts = bool(ch.get("allow_shorts", 0))
            vids = _channel_videos(c, ch["channel_id"], ch["read_before"], set())
            for v in vids:
                if v["is_read"]:
                    continue
                if v["video_id"] in exclude_ids:
                    continue
                if hide_shorts and not ch_allow_shorts and _is_short(v):
                    continue
                v["channel_name"] = ch["name"]
                out.append(v)
        return out


def _queue_list(is_deep: bool) -> list[dict]:
    return get_queue(is_deep=is_deep)


_HELP_TEXT = (
    "commands:\n"
    "/ping — pong\n"
    "/get — queue + visible videos\n"
    "/queue — queue only\n"
    "/deep — deep queue only\n"
    "/random — one random video (visible → queue → deep)\n"
    "/add <url> — add video to queue\n"
    "/play <url> — play video on TV\n"
    "/refresh — refresh then /get\n"
    "/nuke — mark all visible as read\n"
    "/undo — today's videos visible again\n"
    "/clear — empty queue\n"
    "/dump — queue back to unread\n"
    "/help — this"
)


def _minutes_since_last_refresh() -> int | None:
    with db() as c:
        row = c.execute("SELECT MAX(last_refreshed) AS t FROM channels").fetchone()
    if not row or not row["t"]:
        return None
    try:
        last = datetime.fromisoformat(row["t"])
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return int((datetime.now(timezone.utc) - last).total_seconds() // 60)
    except Exception:
        return None


async def _do_get(number: str, prefix: str = ""):
    queued_ids = await _send_queue_to_signal(number)
    visible = await _send_unread_to_signal(number, exclude_ids=set(queued_ids))
    q, v = len(queued_ids), visible
    mins = _minutes_since_last_refresh()
    checked = f"\n(checked {mins}m ago)" if mins is not None else ""
    if q == 0 and v == 0:
        await _signal_send_plain(number, f"{prefix}nothing in queue or visible ✓{checked}")
    else:
        parts = []
        if q: parts.append(f"{q} queued")
        if v: parts.append(f"{v} visible")
        await _signal_send_plain(number, f"{prefix}sent {', '.join(parts)}{checked}")


async def _add_url_to_queue(url: str, api_key: str) -> tuple[bool, str]:
    vid = _parse_yt_video_id(url)
    if not vid:
        return False, "invalid YouTube URL"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SHORT) as client:
        r = await client.get(f"{YT_API}/videos", params={
            "part": "snippet,contentDetails",
            "id": vid,
            "key": api_key,
        })
    if r.status_code != 200:
        return False, f"YouTube API error {r.status_code}"
    add_quota(1)
    items = r.json().get("items", [])
    if not items:
        return False, "video not found or private"
    it = items[0]
    sn = it["snippet"]
    cd = it.get("contentDetails", {}) or {}
    thumbnails = sn.get("thumbnails", {})
    picked = thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default") or {}
    duration  = parse_duration(cd.get("duration", ""))
    is_live   = sn.get("liveBroadcastContent", "none") or "none"
    thumb_w   = picked.get("width")
    thumb_h   = picked.get("height")
    with db() as c:
        max_order = c.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM queue WHERE watched_at IS NULL"
        ).fetchone()[0]
        c.execute(
            """INSERT INTO queue
               (video_id, channel_id, channel_name, title, thumbnail_url, published_at, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(video_id) DO UPDATE SET
                 watched_at = NULL,
                 sort_order = excluded.sort_order,
                 added_at   = CURRENT_TIMESTAMP,
                 is_deep    = 0""",
            (
                vid,
                sn.get("channelId", ""),
                sn.get("channelTitle", ""),
                sn.get("title", ""),
                picked.get("url", ""),
                sn.get("publishedAt", ""),
                max_order + 1,
            ),
        )
        # Also cache video metadata so duration shows in queue UI even when
        # the channel isn't subscribed.
        c.execute(
            """INSERT INTO videos
               (video_id, channel_id, title, thumbnail_url, published_at, duration, is_live, thumb_w, thumb_h)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(video_id) DO UPDATE SET
                 duration = excluded.duration,
                 is_live  = excluded.is_live,
                 thumb_w  = excluded.thumb_w,
                 thumb_h  = excluded.thumb_h""",
            (
                vid,
                sn.get("channelId", ""),
                sn.get("title", ""),
                picked.get("url", ""),
                sn.get("publishedAt", ""),
                duration,
                is_live,
                thumb_w,
                thumb_h,
            ),
        )
        c.commit()
    await _broadcast("refreshed")
    return True, sn.get("title", "added")


async def _backfill_queue_video_meta():
    """One-shot at startup: fetch metadata (duration, etc.) for queue items
    that have no row in `videos`. Cheap — 1 quota unit per 50 ids."""
    await asyncio.sleep(3)  # let app boot
    api_key = get_api_key()
    if not api_key:
        return
    with db() as c:
        rows = c.execute(
            "SELECT q.video_id FROM queue q LEFT JOIN videos v ON v.video_id=q.video_id "
            "WHERE q.watched_at IS NULL AND v.video_id IS NULL"
        ).fetchall()
    ids = [r["video_id"] for r in rows]
    if not ids:
        return
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SHORT) as client:
        for i in range(0, len(ids), YT_CHUNK_SIZE):
            chunk = ids[i:i+YT_CHUNK_SIZE]
            try:
                r = await client.get(f"{YT_API}/videos", params={
                    "part": "snippet,contentDetails",
                    "id": ",".join(chunk),
                    "key": api_key,
                })
            except Exception:
                continue
            if r.status_code != 200:
                continue
            add_quota(1)
            with db() as c:
                for it in r.json().get("items", []):
                    sn = it.get("snippet", {})
                    cd = it.get("contentDetails", {}) or {}
                    thumbs = sn.get("thumbnails", {})
                    picked = thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}
                    c.execute(
                        """INSERT INTO videos
                           (video_id, channel_id, title, thumbnail_url, published_at, duration, is_live, thumb_w, thumb_h)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT(video_id) DO UPDATE SET
                             duration = excluded.duration,
                             is_live  = excluded.is_live,
                             thumb_w  = excluded.thumb_w,
                             thumb_h  = excluded.thumb_h""",
                        (
                            it["id"],
                            sn.get("channelId", ""),
                            sn.get("title", ""),
                            picked.get("url", ""),
                            sn.get("publishedAt", ""),
                            parse_duration(cd.get("duration", "")),
                            sn.get("liveBroadcastContent", "none") or "none",
                            picked.get("width"),
                            picked.get("height"),
                        ),
                    )
                c.commit()
    await _broadcast("refreshed")


async def _handle_signal_command(cmd: str, number: str):
    raw = cmd.strip()
    parts = raw.split(None, 1)
    token = parts[0].lower() if parts else ""
    arg = parts[1].strip() if len(parts) > 1 else ""
    cmd = token  # preserve existing eq checks
    if cmd == "/add":
        if not arg:
            await _signal_send_plain(number, "usage: /add <youtube url>")
            return
        api_key = get_api_key()
        if not api_key:
            await _signal_send_plain(number, "no API key configured")
            return
        ok, msg = await _add_url_to_queue(arg, api_key)
        await _signal_send_plain(number, f"queued: {msg}" if ok else f"failed: {msg}")
        return
    if cmd == "/play":
        if not arg:
            await _signal_send_plain(number, "usage: /play <youtube url>")
            return
        vid = _parse_yt_video_id(arg)
        if not vid:
            await _signal_send_plain(number, "invalid YouTube URL")
            return
        s = _tv_settings_load()
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_LONG) as client:
            try:
                r = await client.post(f"{ADB_API_URL}/play", json={
                    "ip": s["ip"],
                    "video_id": vid,
                    "use_smarttube": s["use_smarttube"],
                })
            except Exception as exc:
                await _signal_send_plain(number, f"adb-api unavailable: {exc}")
                return
        if r.status_code == 200 and r.json().get("ok"):
            _tv_persist_ip(s["ip"])
            await _signal_send_plain(number, f"playing on TV ✓")
        else:
            await _signal_send_plain(number, f"failed: {r.text[:200]}")
        return
    if cmd == "/ping":
        await _signal_send_plain(number, "pong")
    elif cmd == "/help":
        await _signal_send_plain(number, _HELP_TEXT)
    elif cmd == "/get":
        await _do_get(number)
    elif cmd == "/queue":
        queued_ids = await _send_queue_to_signal(number)
        await _signal_send_plain(number, f"sent {len(queued_ids)} from queue" if queued_ids else "queue empty ✓")
    elif cmd == "/deep":
        deep_ids = await _send_deep_to_signal(number)
        await _signal_send_plain(number, f"sent {len(deep_ids)} from deep queue" if deep_ids else "deep queue empty ✓")
    elif cmd == "/random":
        # Priority: visible unread → shallow queue → deep queue. Random within first non-empty.
        queued_shallow = _queue_list(is_deep=False)
        queued_deep    = _queue_list(is_deep=True)
        queued_ids     = {q["video_id"] for q in queued_shallow} | {q["video_id"] for q in queued_deep}
        visible = _visible_unread_list(exclude_ids=queued_ids)
        if visible:
            v = random.choice(visible)
            await _signal_send_one(number, v["video_id"], v["title"], v["channel_name"], v.get("thumbnail_url") or "")
            await _signal_send_plain(number, f"random visible ({len(visible)} pool) ✓")
        elif queued_shallow:
            v = random.choice(queued_shallow)
            await _signal_send_one(number, v["video_id"], v["title"], v["channel_name"], v.get("thumbnail_url") or "")
            await _signal_send_plain(number, f"random queue ({len(queued_shallow)} pool) ✓")
        elif queued_deep:
            v = random.choice(queued_deep)
            await _signal_send_one(number, v["video_id"], v["title"], v["channel_name"], v.get("thumbnail_url") or "")
            await _signal_send_plain(number, f"random deep ({len(queued_deep)} pool) ✓")
        else:
            await _signal_send_plain(number, "nothing visible or queued ✓")
    elif cmd == "/clear":
        with db() as c:
            c.execute("DELETE FROM queue WHERE watched_at IS NULL")
            c.commit()
        await _broadcast("refreshed")
        await _signal_send_plain(number, "queue cleared ✓")
    elif cmd == "/dump":
        with db() as c:
            items = [dict(r) for r in c.execute(
                "SELECT video_id, channel_id FROM queue WHERE watched_at IS NULL"
            ).fetchall()]
            for it in items:
                c.execute(
                    "INSERT OR REPLACE INTO video_status (video_id, channel_id, status) VALUES (?, ?, 'unread')",
                    (it["video_id"], it["channel_id"]),
                )
            c.execute("DELETE FROM queue WHERE watched_at IS NULL")
            c.commit()
        await _broadcast("refreshed")
        await _signal_send_plain(number, f"dumped {len(items)} back to unread ✓")
    elif cmd == "/nuke":
        now = datetime.now(timezone.utc).isoformat()
        with db() as c:
            c.execute("UPDATE channels SET read_before=?", (now,))
            c.execute("DELETE FROM video_status")
            c.commit()
        await _broadcast("refreshed")
        await _signal_send_plain(number, "nuked ✓")
    elif cmd == "/refresh":
        api_key = get_api_key()
        if not api_key:
            await _signal_send_plain(number, "no API key configured")
            return
        await _signal_send_plain(number, "refreshing…")
        with db() as c:
            before = {r["video_id"] for r in c.execute("SELECT video_id FROM videos").fetchall()}
        await _refresh_channels(api_key)
        with db() as c:
            after = {r["video_id"] for r in c.execute("SELECT video_id FROM videos").fetchall()}
        new_count = len(after - before)
        prefix = f"{new_count} new video(s) — " if new_count else "no new videos — "
        await _do_get(number, prefix=prefix)
    elif cmd == "/undo":
        try:
            from zoneinfo import ZoneInfo
            local_midnight = datetime.now(ZoneInfo(TZ_NAME)).replace(hour=0, minute=0, second=0, microsecond=0)
        except Exception:
            local_midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        cutoff = local_midnight.astimezone(timezone.utc).isoformat()
        with db() as c:
            allow_map = {
                r["channel_id"]: bool(r["allow_shorts"])
                for r in c.execute("SELECT channel_id, allow_shorts FROM channels").fetchall()
            }
            todays = [dict(r) for r in c.execute(
                "SELECT * FROM videos WHERE published_at > ?", (cutoff,)
            ).fetchall()]
            short_ids = {
                v["video_id"] for v in todays
                if _is_short(v) and not allow_map.get(v["channel_id"], False)
            }
            c.execute("UPDATE channels SET read_before=? WHERE read_before > ?", (cutoff, cutoff))
            c.execute("""DELETE FROM video_status WHERE status='read' AND video_id IN (
                SELECT video_id FROM videos WHERE published_at > ?)""", (cutoff,))
            for v in todays:
                if v["video_id"] in short_ids:
                    c.execute(
                        "INSERT OR REPLACE INTO video_status (video_id, channel_id, status) VALUES (?, ?, 'read')",
                        (v["video_id"], v["channel_id"]),
                    )
            c.commit()
        await _broadcast("refreshed")
        await _signal_send_plain(number, f"undone — today visible ✓ (skipped {len(short_ids)} shorts)" if short_ids else "undone — today visible ✓")


async def _signal_listener():
    await asyncio.sleep(5)  # let app boot
    start_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    ws_base = SIGNAL_API_URL.replace("http://", "ws://").replace("https://", "wss://")
    while True:
        try:
            number = get_setting("signal_number")
            if not number:
                await asyncio.sleep(10)
                continue
            url = f"{ws_base}/v1/receive/{number}"
            print(f"[signal listener] connecting to {url}")
            async with websockets.connect(url, ping_interval=30) as ws:
                print(f"[signal listener] ws connected")
                async for raw in ws:
                    try:
                        env = json.loads(raw)
                    except Exception:
                        continue
                    envelope = env.get("envelope", {})
                    ts = envelope.get("timestamp", 0)
                    if ts < start_ts:
                        continue
                    msg = None
                    sync = envelope.get("syncMessage", {}) or {}
                    sent = sync.get("sentMessage") or {}
                    if sent and sent.get("destination") == number:
                        msg = sent.get("message")
                    else:
                        dm = envelope.get("dataMessage") or {}
                        if dm and envelope.get("source") == number:
                            msg = dm.get("message")
                    if msg:
                        print(f"[signal listener] received: {msg!r}")
                        cmd = msg.strip().lower()
                        if cmd.startswith("/"):
                            await _broadcast("signal_cmd", phase="received", cmd=cmd)
                            await _handle_signal_command(msg, number)
                            await _broadcast("signal_cmd", phase="done", cmd=cmd)
                        else:
                            await _handle_signal_command(msg, number)
        except Exception as exc:
            print(f"[signal listener] ws error: {exc} — reconnecting in {SIGNAL_RECONNECT_PAUSE}s")
            await asyncio.sleep(SIGNAL_RECONNECT_PAUSE)


@asynccontextmanager
async def lifespan(app):
    asyncio.create_task(_background_refresh())
    asyncio.create_task(_signal_listener())
    asyncio.create_task(_backfill_queue_video_meta())
    yield


app = FastAPI(lifespan=lifespan)

from db import db, init_db

init_db()


# ── YouTube helpers ───────────────────────────────────────────────────────────

def get_api_key():
    return os.environ.get("YOUTUBE_API_KEY") or get_setting("api_key") or ""


from youtube import save_videos, yt_fetch_videos, yt_get_channel


# ── DB helpers ────────────────────────────────────────────────────────────────

def _channel_videos(c, channel_id: str, read_before, queued_ids: set) -> list:
    vids = c.execute(
        "SELECT * FROM videos WHERE channel_id=? ORDER BY published_at DESC LIMIT 10",
        (channel_id,),
    ).fetchall()
    overrides = {
        r["video_id"]: r["status"]
        for r in c.execute(
            "SELECT video_id, status FROM video_status WHERE channel_id=?",
            (channel_id,),
        ).fetchall()
    }
    videos = []
    for v in vids:
        vid = dict(v)
        ov = overrides.get(vid["video_id"])
        if ov == "read":
            vid["is_read"] = True
        elif ov == "unread":
            vid["is_read"] = False
        elif read_before:
            vid["is_read"] = vid["published_at"] <= read_before
        else:
            vid["is_read"] = False
        vid["in_queue"] = vid["video_id"] in queued_ids
        videos.append(vid)
    return videos


# ── Pydantic models ───────────────────────────────────────────────────────────

class AddChannelReq(BaseModel):
    input: str

class QueueAddReq(BaseModel):
    video_id: str
    channel_id: str
    channel_name: str
    title: str
    thumbnail_url: str
    published_at: str

class PlayedReq(BaseModel):
    channel_id: Optional[str] = None
    channel_name: str = ""
    title: str = ""
    thumbnail_url: str = ""
    published_at: Optional[str] = None

class ApiKeyReq(BaseModel):
    api_key: str

class ReorderReq(BaseModel):
    ids: list[str]

class DeepReq(BaseModel):
    is_deep: bool

class FolderReq(BaseModel):
    name: str

class RenameReq(BaseModel):
    name: str

class SetFolderReq(BaseModel):
    folder_id: Optional[int] = None

class FeedReorderItem(BaseModel):
    type: str   # 'folder' | 'channel'
    id: str     # folder int id or channel_id string

class FeedReorderReq(BaseModel):
    items: list[FeedReorderItem]


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/events")
async def events():
    import json as _json
    queue = asyncio.Queue()
    _event_listeners.add(queue)

    async def generator():
        try:
            yield "data: connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"   # heartbeat — keep proxies/throttled tabs alive
                    continue
                yield f"data: {_json.dumps(event)}\n\n"
        finally:
            _event_listeners.discard(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Cast — screens & remote control ───────────────────────────────────────────
#
# A "screen" is a device on /watch waiting for content. Transport reuses the SSE
# pattern above: a per-screen stream pushes commands down to the screen, the
# global /api/events stream carries screen_online/offline/status up to remotes,
# and phones send plays/commands as plain POSTs. See cast.py for the registry.

import cast as _cast


@app.get("/api/cast/screens")
def cast_screens():
    return _cast.list_screens()


@app.get("/api/cast/stream/{screen_id}")
async def cast_stream(screen_id: str, name: str = ""):
    safe_name = _cast.sanitize_name(name)
    queue, token, is_new = _cast.register_screen(screen_id, safe_name)
    if is_new:
        await _broadcast("screen_online", screen_id=screen_id, name=safe_name)

    async def generator():
        try:
            yield "data: connected\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(payload)}\n\n"
        finally:
            async def _offline():
                await _broadcast("screen_offline", screen_id=screen_id)
            _cast.schedule_drop(screen_id, token, _offline)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/cast/{screen_id}/play")
async def cast_play(screen_id: str, req: _cast.CastPlayReq):
    if not _cast.has_screen(screen_id):
        raise HTTPException(404, "screen not connected")
    videos = [v.model_dump() for v in req.videos]
    if not videos:
        raise HTTPException(400, "no videos")
    _cast.send_command(screen_id, {
        "type": "play",
        "videos": videos,
        "start_id": req.start_id,
        "start_seconds": req.start_seconds,
        "mark_mode": req.mark_mode,
    })
    start_id = req.start_id or videos[0]["video_id"]
    cur = next((v for v in videos if v["video_id"] == start_id), videos[0])
    status = _cast.set_status(screen_id, {
        "video_id": cur["video_id"],
        "title": cur.get("title", ""),
        "player_state": None,
        "index": next((i for i, v in enumerate(videos) if v["video_id"] == start_id), 0),
        "count": len(videos),
        "name": _cast.get_name(screen_id),
        "videos": videos,             # full jump list — late-joining remotes + transfer
        "mark_mode": req.mark_mode,    # remembered so a transfer preserves marking
    })
    await _broadcast("screen_status", screen_id=screen_id, status=status)
    return {"ok": True}


@app.post("/api/cast/{screen_id}/command")
async def cast_command(screen_id: str, req: _cast.CastCommandReq):
    if not _cast.has_screen(screen_id):
        raise HTTPException(404, "screen not connected")
    if req.action not in _cast.CAST_ACTIONS:
        raise HTTPException(400, f"unknown action: {req.action}")
    _cast.send_command(screen_id, {
        "type": "command",
        "action": req.action,
        "video_id": req.video_id,
        "value": req.value,
    })
    return {"ok": True}


@app.post("/api/cast/{screen_id}/status")
async def cast_status(screen_id: str, req: _cast.CastStatusReq):
    if not _cast.has_screen(screen_id):
        raise HTTPException(404, "screen not connected")
    data = {
        "video_id": req.video_id,
        "title": req.title,
        "player_state": req.player_state,
        "index": req.index,
        "count": req.count,
        "current_time": req.current_time,
        "duration": req.duration,
        "name": _cast.get_name(screen_id),
    }
    # Only overwrite the stored jump list when the poll actually carried one
    # (sent on change) — otherwise preserve whatever /play or an earlier poll set.
    if req.videos is not None:
        data["videos"] = [v.model_dump() for v in req.videos]
    status = _cast.set_status(screen_id, data)
    await _broadcast("screen_status", screen_id=screen_id, status=status)
    return {"ok": True}


@app.get("/api/quota")
def quota_get():
    return {
        "today":   get_quota_today_units(),
        "session": session_quota_units(),
        "limit":   DAILY_QUOTA_LIMIT,
        "date":    _quota_today(),
        "last_refreshed": max_last_refreshed(),
    }


@app.get("/api/settings")
def settings_get():
    rows = get_all_settings()
    key = rows.get("api_key", "")
    masked = (key[:4] + "…" + key[-4:]) if len(key) > 8 else ("****" if key else "")
    return {
        "has_api_key": bool(key),
        "masked": masked,
        "hide_shorts": rows.get("hide_shorts", "0") == "1",
    }


@app.post("/api/settings/api-key")
def settings_set_key(req: ApiKeyReq):
    set_setting("api_key", req.api_key)
    return {"ok": True}


class HideShortsReq(BaseModel):
    hide_shorts: bool

@app.post("/api/settings/hide-shorts")
def settings_hide_shorts(req: HideShortsReq):
    set_setting("hide_shorts", "1" if req.hide_shorts else "0")
    return {"ok": True}


# ── Signal settings ───────────────────────────────────────────────────────────

class SignalLinkReq(BaseModel):
    number: str

class SignalSendReq(BaseModel):
    video_id: str
    title: str
    channel_name: str
    thumbnail_url: Optional[str] = None

@app.get("/api/settings/signal")
def signal_settings_get():
    number = get_setting("signal_number") or ""
    return {"configured": bool(number), "number": number}

@app.post("/api/settings/signal/link")
def signal_link(req: SignalLinkReq):
    number = req.number.strip()
    if not number:
        raise HTTPException(400, "Phone number required")
    set_setting("signal_number", number)
    return {"ok": True, "number": number}

@app.get("/api/settings/signal/qr")
async def signal_qr():
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(
                f"{SIGNAL_API_URL}/v1/qrcodelink?device_name=youtube-zero",
                timeout=HTTP_TIMEOUT_LONG,
            )
        except Exception as exc:
            raise HTTPException(503, f"Signal API unavailable: {exc}")
    if r.status_code != 200:
        raise HTTPException(503, "Signal API error — is the signal-api service running?")
    return Response(content=r.content, media_type="image/png")

@app.delete("/api/settings/signal")
def signal_delete():
    delete_setting("signal_number")
    return {"ok": True}


# ── TV (ADB) ──────────────────────────────────────────────────────────────────

DEFAULT_TV_IP = "192.168.0.27"


def _tv_settings_load() -> dict:
    with db() as c:
        rows = {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings").fetchall()}
    return {
        "ip": rows.get("tv_ip", DEFAULT_TV_IP),
        "use_smarttube": rows.get("tv_use_smarttube", "1") == "1",
        "configured": "tv_ip" in rows,
    }


class TvSettingsReq(BaseModel):
    ip: str
    use_smarttube: bool = True


class TvPlayReq(BaseModel):
    video_id: str


@app.get("/api/settings/tv")
def tv_settings_get():
    return _tv_settings_load()


@app.post("/api/settings/tv")
def tv_settings_set(req: TvSettingsReq):
    ip = req.ip.strip()
    if not ip:
        raise HTTPException(400, "TV IP required")
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings VALUES ('tv_ip', ?)", (ip,))
        c.execute("INSERT OR REPLACE INTO settings VALUES ('tv_use_smarttube', ?)", ("1" if req.use_smarttube else "0",))
        c.commit()
    return {"ok": True, **_tv_settings_load()}


def _tv_persist_ip(ip: str):
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings VALUES ('tv_ip', ?)", (ip,))
        c.commit()


@app.post("/api/tv/connect")
async def tv_connect():
    s = _tv_settings_load()
    async with httpx.AsyncClient(timeout=100) as client:
        try:
            r = await client.post(f"{ADB_API_URL}/connect", json={"ip": s["ip"]})
        except Exception as exc:
            raise HTTPException(503, f"adb-api unavailable: {exc}")
    if r.status_code != 200:
        raise HTTPException(502, f"adb-api error: {r.text[:200]}")
    body = r.json()
    if body.get("ok"):
        _tv_persist_ip(s["ip"])
    return body


@app.post("/api/tv/play")
async def tv_play(req: TvPlayReq):
    s = _tv_settings_load()
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_LONG) as client:
        try:
            r = await client.post(f"{ADB_API_URL}/play", json={
                "ip": s["ip"],
                "video_id": req.video_id,
                "use_smarttube": s["use_smarttube"],
            })
        except Exception as exc:
            raise HTTPException(503, f"adb-api unavailable: {exc}")
    if r.status_code != 200:
        raise HTTPException(502, f"adb-api error: {r.text[:200]}")
    body = r.json()
    if body.get("ok"):
        _tv_persist_ip(s["ip"])
        record_watched(req.video_id, datetime.now(timezone.utc).isoformat())
    return body

@app.post("/api/signal/send")
async def signal_send(req: SignalSendReq):
    number = get_setting("signal_number")
    if not number:
        raise HTTPException(400, "Signal not configured")
    err = await _signal_send_one(number, req.video_id, req.title, req.channel_name, req.thumbnail_url or "")
    if err:
        raise HTTPException(500, f"Signal send failed: {err}")
    return {"ok": True}


@app.post("/api/signal/send-queue")
async def signal_send_queue():
    number = get_setting("signal_number")
    if not number:
        raise HTTPException(400, "Signal not configured")
    items = get_queue(is_deep=False)
    if not items:
        raise HTTPException(400, "Queue is empty")
    errors = []
    for item in items:
        err = await _signal_send_one(number, item["video_id"], item["title"], item["channel_name"], item.get("thumbnail_url") or "")
        if err:
            errors.append(f"{item['video_id']}: {err}")
    if errors:
        raise HTTPException(500, f"Some sends failed: {'; '.join(errors)}")
    return {"ok": True}


@app.get("/api/channels")
def channels_list():
    with db() as c:
        chs = [dict(r) for r in c.execute(
            "SELECT * FROM channels ORDER BY COALESCE(sort_order, id), created_at"
        ).fetchall()]
        queued_ids = {
            r["video_id"] for r in c.execute(
                "SELECT video_id FROM queue WHERE watched_at IS NULL"
            ).fetchall()
        }
        for ch in chs:
            ch["videos"] = _channel_videos(c, ch["channel_id"], ch["read_before"], queued_ids)
    return chs


@app.get("/api/feed")
def get_feed():
    with db() as c:
        queued_ids = {
            r["video_id"] for r in c.execute(
                "SELECT video_id FROM queue WHERE watched_at IS NULL"
            ).fetchall()
        }
        folders = [dict(r) for r in c.execute(
            "SELECT * FROM folders ORDER BY COALESCE(sort_order, id)"
        ).fetchall()]
        for folder in folders:
            chs = [dict(r) for r in c.execute(
                "SELECT * FROM channels WHERE folder_id=? ORDER BY COALESCE(sort_order, id)",
                (folder["id"],),
            ).fetchall()]
            for ch in chs:
                ch["videos"] = _channel_videos(c, ch["channel_id"], ch["read_before"], queued_ids)
            folder["channels"] = chs
        standalone = [dict(r) for r in c.execute(
            "SELECT * FROM channels WHERE folder_id IS NULL ORDER BY COALESCE(sort_order, id)"
        ).fetchall()]
        for ch in standalone:
            ch["videos"] = _channel_videos(c, ch["channel_id"], ch["read_before"], queued_ids)
    return {"folders": folders, "channels": standalone}


# ── Screen ↔ beacon mappings ────────────────────────────────────────────────
# Bind a screen NAME to an iBeacon (UUID + Major + Minor) so a phone can fling
# to the screen it's physically nearest. Stored server-side so any client uses
# the same mappings. Matching is on the normalized (uuid, major, minor) triple.

class ScreenBeaconReq(BaseModel):
    screen_name: str
    uuid: str
    major: int
    minor: int
    tx_power: Optional[int] = None

    @field_validator("uuid")
    @classmethod
    def _uuid_shape(cls, v):
        hexs = (v or "").strip().lower().replace("-", "")
        if not re.fullmatch(r"[0-9a-f]{32}", hexs):
            raise ValueError("uuid must be 32 hex digits (16 bytes)")
        return v

    @field_validator("major", "minor")
    @classmethod
    def _u16(cls, v):
        v = int(v)
        if not (0 <= v <= 0xFFFF):
            raise ValueError("major/minor must be 0..65535")
        return v


@app.get("/api/screen-beacons")
def screen_beacons_list():
    return list_screen_beacons()


@app.post("/api/screen-beacons")
def screen_beacons_upsert(req: ScreenBeaconReq, background_tasks: BackgroundTasks):
    if not req.screen_name.strip():
        raise HTTPException(400, "screen name required")
    try:
        row = upsert_screen_beacon(
            req.screen_name, req.uuid, req.major, req.minor, req.tx_power
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That beacon (UUID+Major+Minor) is already bound to another screen")
    background_tasks.add_task(_broadcast, "refreshed")
    return row


@app.put("/api/screen-beacons/{beacon_id}")
def screen_beacons_update(beacon_id: int, req: ScreenBeaconReq, background_tasks: BackgroundTasks):
    if not req.screen_name.strip():
        raise HTTPException(400, "screen name required")
    try:
        row = update_screen_beacon(
            beacon_id, req.screen_name, req.uuid, req.major, req.minor, req.tx_power
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Another screen already uses that name or beacon")
    if not row:
        raise HTTPException(404, "screen beacon not found")
    background_tasks.add_task(_broadcast, "refreshed")
    return row


@app.delete("/api/screen-beacons/{beacon_id}")
def screen_beacons_delete(beacon_id: int, background_tasks: BackgroundTasks):
    delete_screen_beacon(beacon_id)
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


# ── Folder CRUD ───────────────────────────────────────────────────────────────

@app.get("/api/folders")
def folders_list():
    return list_folders()


@app.post("/api/folders")
def folders_create(req: FolderReq, background_tasks: BackgroundTasks):
    with db() as c:
        max_order = c.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM folders"
        ).fetchone()[0]
        cur = c.execute(
            "INSERT INTO folders (name, sort_order) VALUES (?, ?)",
            (req.name, max_order + 1),
        )
        folder_id = cur.lastrowid
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"id": folder_id, "name": req.name, "sort_order": max_order + 1, "channels": []}


@app.delete("/api/folders/{folder_id}")
def folders_delete(folder_id: int, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("UPDATE channels SET folder_id=NULL WHERE folder_id=?", (folder_id,))
        c.execute("DELETE FROM folders WHERE id=?", (folder_id,))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/folders/{folder_id}/rename")
def folders_rename(folder_id: int, req: RenameReq, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("UPDATE folders SET name=? WHERE id=?", (req.name, folder_id))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


class SetIconReq(BaseModel):
    icon: str

@app.post("/api/folders/{folder_id}/set-icon")
def folders_set_icon(folder_id: int, req: SetIconReq, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("UPDATE folders SET icon=? WHERE id=?", (req.icon, folder_id))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/folders/{folder_id}/mark-read")
def folders_mark_read(folder_id: int, background_tasks: BackgroundTasks):
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        ids = [r["channel_id"] for r in c.execute(
            "SELECT channel_id FROM channels WHERE folder_id=?", (folder_id,)
        ).fetchall()]
        for cid in ids:
            c.execute("UPDATE channels SET read_before=? WHERE channel_id=?", (now, cid))
            c.execute("DELETE FROM video_status WHERE channel_id=?", (cid,))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True, "read_before": now, "channel_ids": ids}


@app.post("/api/folders/{folder_id}/refresh")
async def folders_refresh(folder_id: int):
    api_key = get_api_key()
    if not api_key:
        raise HTTPException(400, "No API key")
    with db() as c:
        channels = c.execute(
            "SELECT * FROM channels WHERE folder_id=?", (folder_id,)
        ).fetchall()
    results = []
    for ch in channels:
        try:
            videos = await yt_fetch_videos(ch["uploads_playlist_id"], api_key)
            save_videos(ch["channel_id"], videos)
            results.append({"channel_id": ch["channel_id"], "count": len(videos)})
        except Exception as e:
            results.append({"channel_id": ch["channel_id"], "error": str(e)})
    return {"ok": True, "results": results}


@app.post("/api/channels/{channel_id}/set-folder")
def channels_set_folder(channel_id: str, req: SetFolderReq, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute(
            "UPDATE channels SET folder_id=? WHERE channel_id=?",
            (req.folder_id, channel_id),
        )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/feed/reorder")
def feed_reorder(req: FeedReorderReq, background_tasks: BackgroundTasks):
    with db() as c:
        for i, item in enumerate(req.items):
            if item.type == "folder":
                c.execute(
                    "UPDATE folders SET sort_order=? WHERE id=?", (i, int(item.id))
                )
            else:
                c.execute(
                    "UPDATE channels SET sort_order=? WHERE channel_id=?", (i, item.id)
                )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/channels")
async def channels_add(req: AddChannelReq, background_tasks: BackgroundTasks):
    api_key = get_api_key()
    if not api_key:
        raise HTTPException(400, "No YouTube API key. Add one in settings (⚙).")
    if _parse_yt_video_id(req.input.strip()):
        ok, msg = await _add_url_to_queue(req.input.strip(), api_key)
        if not ok:
            raise HTTPException(400, msg)
        background_tasks.add_task(_broadcast, "refreshed")
        return {"video_found": True, "title": msg}
    ltype, val = parse_channel_input(req.input)
    info = await yt_get_channel(ltype, val, api_key)
    with db() as c:
        try:
            max_order = c.execute(
                """SELECT COALESCE(MAX(so), -1) FROM (
                       SELECT sort_order AS so FROM channels WHERE folder_id IS NULL
                       UNION ALL
                       SELECT sort_order AS so FROM folders
                   )"""
            ).fetchone()[0]
            assigned_order = max_order + 1
            c.execute(
                """INSERT INTO channels
                   (channel_id, name, thumbnail_url, handle, uploads_playlist_id, sort_order)
                   VALUES (:channel_id, :name, :thumbnail_url, :handle, :uploads_playlist_id, :sort_order)""",
                {**info, "sort_order": assigned_order},
            )
            c.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Channel already added")
    videos = await yt_fetch_videos(info["uploads_playlist_id"], api_key)
    save_videos(info["channel_id"], videos)
    background_tasks.add_task(_broadcast, "refreshed")
    return {
        **info,
        "videos": [{**v, "in_queue": False, "is_read": False} for v in videos],
        "read_before": None,
        "last_refreshed": (now := datetime.now(timezone.utc)).isoformat(),
        "created_at": now.isoformat(),
        "folder_id": None,
        "sort_order": assigned_order,
    }


@app.delete("/api/channels/{channel_id}")
def channels_delete(channel_id: str, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("DELETE FROM channels WHERE channel_id=?", (channel_id,))
        c.execute("DELETE FROM videos WHERE channel_id=?", (channel_id,))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/channels/reorder")
def channels_reorder(req: ReorderReq, background_tasks: BackgroundTasks):
    with db() as c:
        for i, cid in enumerate(req.ids):
            c.execute(
                "UPDATE channels SET sort_order=? WHERE channel_id=?", (i, cid)
            )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


class AllowShortsReq(BaseModel):
    allow: bool

class MuteReq(BaseModel):
    muted: bool

@app.post("/api/channels/{channel_id}/allow-shorts")
def channels_allow_shorts(channel_id: str, req: AllowShortsReq, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("UPDATE channels SET allow_shorts=? WHERE channel_id=?", (1 if req.allow else 0, channel_id))
        if req.allow:
            # Force-unread any shorts in this channel (overrides both prior read_before and read overrides)
            vids = [dict(r) for r in c.execute(
                "SELECT * FROM videos WHERE channel_id=?", (channel_id,)
            ).fetchall()]
            for v in vids:
                if _is_short(v):
                    c.execute(
                        "INSERT OR REPLACE INTO video_status (video_id, channel_id, status) VALUES (?, ?, 'unread')",
                        (v["video_id"], channel_id),
                    )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True, "allow_shorts": req.allow}


@app.post("/api/channels/{channel_id}/mute")
def channels_mute(channel_id: str, req: MuteReq, background_tasks: BackgroundTasks):
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        c.execute("UPDATE channels SET muted=? WHERE channel_id=?", (1 if req.muted else 0, channel_id))
        if req.muted:
            # Mark current unread videos as read so they vanish immediately.
            c.execute("UPDATE channels SET read_before=? WHERE channel_id=?", (now, channel_id))
            c.execute(
                "DELETE FROM video_status WHERE channel_id=? AND status='unread'",
                (channel_id,),
            )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True, "muted": req.muted}


@app.post("/api/channels/{channel_id}/mark-unread")
def channels_mark_unread(channel_id: str, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("UPDATE channels SET read_before=NULL WHERE channel_id=?", (channel_id,))
        c.execute("DELETE FROM video_status WHERE channel_id=?", (channel_id,))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/channels/{channel_id}/mark-read")
def channels_mark_read(channel_id: str, background_tasks: BackgroundTasks):
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        c.execute("UPDATE channels SET read_before=? WHERE channel_id=?", (now, channel_id))
        c.execute("DELETE FROM video_status WHERE channel_id=?", (channel_id,))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True, "read_before": now}


@app.post("/api/channels/{channel_id}/refresh")
async def channels_refresh(channel_id: str):
    api_key = get_api_key()
    if not api_key:
        raise HTTPException(400, "No API key")
    with db() as c:
        ch = c.execute(
            "SELECT * FROM channels WHERE channel_id=?", (channel_id,)
        ).fetchone()
    if not ch:
        raise HTTPException(404, "Not found")
    videos = await yt_fetch_videos(ch["uploads_playlist_id"], api_key)
    save_videos(channel_id, videos)
    return {"ok": True, "count": len(videos)}


@app.post("/api/videos/{video_id}/read")
def video_mark_read(video_id: str, background_tasks: BackgroundTasks):
    with db() as c:
        vid = c.execute(
            "SELECT channel_id FROM videos WHERE video_id=?", (video_id,)
        ).fetchone()
        if not vid:
            raise HTTPException(404, "Video not found")
        c.execute(
            "INSERT OR REPLACE INTO video_status (video_id, channel_id, status) VALUES (?,?,?)",
            (video_id, vid["channel_id"], "read"),
        )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/videos/{video_id}/played")
def video_mark_played(video_id: str, req: PlayedReq):
    """Record that playback of a video started (queue/folder/inline/cast). Powers
    the Watch History page — a video lands here even if never finished/marked read."""
    record_watched(video_id, datetime.now(timezone.utc).isoformat(), req.model_dump())
    return {"ok": True}


@app.post("/api/videos/{video_id}/unread")
def video_mark_unread(video_id: str, background_tasks: BackgroundTasks):
    with db() as c:
        vid = c.execute(
            "SELECT channel_id FROM videos WHERE video_id=?", (video_id,)
        ).fetchone()
        if not vid:
            raise HTTPException(404, "Video not found")
        c.execute(
            "INSERT OR REPLACE INTO video_status (video_id, channel_id, status) VALUES (?,?,?)",
            (video_id, vid["channel_id"], "unread"),
        )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.get("/api/refresh-all/stream")
async def refresh_all_stream():
    import json as _json
    api_key = get_api_key()
    if not api_key:
        raise HTTPException(400, "No API key")
    channels = list_channels()

    async def generator():
        import asyncio as _asyncio
        total = len(channels)
        results = []
        sem = _asyncio.Semaphore(REFRESH_CONCURRENCY)
        queue = _asyncio.Queue()

        async def fetch_one(ch):
            async with sem:
                name = ch.get("handle") or ch.get("name") or ch["channel_id"]
                await queue.put({"type": "start", "name": name})
                try:
                    videos = await yt_fetch_videos(ch["uploads_playlist_id"], api_key)
                    save_videos(ch["channel_id"], videos)
                    await queue.put({"type": "done", "channel_id": ch["channel_id"], "count": len(videos)})
                except Exception as e:
                    await queue.put({"type": "done", "channel_id": ch["channel_id"], "error": str(e)})

        for ch in channels:
            _asyncio.create_task(fetch_one(ch))

        started = 0
        completed = 0
        while completed < total:
            event = await queue.get()
            if event["type"] == "start":
                started += 1
                yield f"data: {_json.dumps({'i': started, 'total': total, 'name': event['name']})}\n\n"
                await _asyncio.sleep(REFRESH_BACKOFF_SECONDS)  # visual stagger — fetches still run at full speed
            else:
                completed += 1
                results.append({k: v for k, v in event.items() if k != "type"})
        yield f"data: {_json.dumps({'done': True, 'results': results})}\n\n"

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/refresh-all")
async def refresh_all():
    api_key = get_api_key()
    if not api_key:
        raise HTTPException(400, "No API key")
    results = await _refresh_channels(api_key)
    return {"ok": True, "results": results}


@app.post("/api/clear-all")
def clear_all(background_tasks: BackgroundTasks):
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        c.execute("UPDATE channels SET read_before=?", (now,))
        c.execute("DELETE FROM video_status")
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.get("/api/queue")
def queue_list():
    with db() as c:
        items = c.execute(
            "SELECT q.*, v.duration AS duration, v.is_live AS is_live "
            "FROM queue q LEFT JOIN videos v ON v.video_id = q.video_id "
            "WHERE q.watched_at IS NULL "
            "ORDER BY COALESCE(q.is_deep,0), COALESCE(q.sort_order, q.id)"
        ).fetchall()
    return [dict(i) for i in items]


@app.post("/api/queue")
def queue_add(req: QueueAddReq, background_tasks: BackgroundTasks):
    with db() as c:
        max_order = c.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM queue WHERE watched_at IS NULL"
        ).fetchone()[0]
        data = req.model_dump()
        data["sort_order"] = max_order + 1
        # Upsert: re-adding a previously watched video reactivates it
        c.execute(
            """INSERT INTO queue
               (video_id, channel_id, channel_name, title, thumbnail_url, published_at, sort_order)
               VALUES (:video_id, :channel_id, :channel_name, :title, :thumbnail_url, :published_at, :sort_order)
               ON CONFLICT(video_id) DO UPDATE SET
                 watched_at  = NULL,
                 sort_order  = excluded.sort_order,
                 added_at    = CURRENT_TIMESTAMP,
                 is_deep     = 0""",
            data,
        )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/queue/reorder")
def queue_reorder(req: ReorderReq):
    with db() as c:
        for i, vid in enumerate(req.ids):
            c.execute("UPDATE queue SET sort_order=? WHERE video_id=?", (i, vid))
        c.commit()
    return {"ok": True}


@app.delete("/api/queue")
def queue_clear(background_tasks: BackgroundTasks, deep: bool = False):
    clear_queue(deep=deep)
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.delete("/api/queue/{video_id}")
def queue_remove(video_id: str, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("DELETE FROM queue WHERE video_id=?", (video_id,))
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/queue/{video_id}/deep")
def queue_set_deep(video_id: str, req: DeepReq, background_tasks: BackgroundTasks):
    target = 1 if req.is_deep else 0
    with db() as c:
        max_order = c.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM queue "
            "WHERE watched_at IS NULL AND COALESCE(is_deep,0)=?",
            (target,),
        ).fetchone()[0]
        c.execute(
            "UPDATE queue SET is_deep=?, sort_order=? WHERE video_id=?",
            (target, max_order + 1, video_id),
        )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.post("/api/queue/{video_id}/watched")
def queue_watched(video_id: str, background_tasks: BackgroundTasks):
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        c.execute(
            "UPDATE queue SET watched_at=? WHERE video_id=?", (now, video_id)
        )
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.get("/api/history")
def history_list(search: str = "", limit: int = 50, offset: int = 0, folder_id: Optional[int] = None):
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    items = get_history(search, limit, offset, folder_id)
    return {
        "items": items,
        "total": count_history(search, folder_id),
        "offset": offset,
        "limit": limit,
    }


# ── Frontend runtime config ────────────────────────────────────────────────────

# The in-app player needs the IFrame control API. Its bootstrap loader only
# exists on www.youtube.com (404 on nocookie), so in nocookie mode we load the
# underlying widgetapi.js straight from nocookie instead. That URL is versioned
# (/s/player/<ver>/...); we scrape the current <ver> from a nocookie embed page
# and cache it. youtube.com mode keeps the stock /iframe_api loader (see keys.js).
_PLAYER_VER_RE = re.compile(r"/s/player/([0-9a-z]+)/")
_widget_api_cache: dict = {"url": None, "ts": None}
_WIDGET_API_TTL = timedelta(hours=6)


async def _nocookie_widget_api_url() -> Optional[str]:
    """Current youtube-nocookie widgetapi.js URL, cached for _WIDGET_API_TTL.

    Returns None (or the last good value) if the player version can't be
    discovered; keys.js then falls back to the stock youtube.com loader.
    """
    now = datetime.now(timezone.utc)
    cached = _widget_api_cache
    if cached["url"] and cached["ts"] and now - cached["ts"] < _WIDGET_API_TTL:
        return cached["url"]
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SHORT) as client:
            r = await client.get(
                f"{YT_EMBED_HOST}/embed/dQw4w9WgXcQ",
                headers={"User-Agent": "Mozilla/5.0"},
            )
        m = _PLAYER_VER_RE.search(r.text)
        if not m:
            return cached["url"]
        ver = m.group(1)
        url = f"{YT_EMBED_HOST}/s/player/{ver}/www-widgetapi.vflset/www-widgetapi.js"
        cached["url"], cached["ts"] = url, now
        return url
    except httpx.HTTPError:
        return cached["url"]


@app.get("/config.js")
async def config_js():
    """Synchronous frontend config, loaded before any other script.

    Exposes the embed host + control-API URL so the player can be pointed at
    youtube-nocookie.com (default) with no www.youtube.com dependency.
    """
    widget_api = await _nocookie_widget_api_url() if USE_NOCOOKIE else None
    body = (
        f"window.YT_EMBED_HOST = {json.dumps(YT_EMBED_HOST)};\n"
        f"window.YT_WIDGET_API = {json.dumps(widget_api)};\n"
        f"window.YT_USE_NOCOOKIE = {json.dumps(USE_NOCOOKIE)};\n"
    )
    return Response(
        content=body,
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


# ── Static / SPA ──────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/{full_path:path}")
def spa(full_path: str):
    return FileResponse("static/index.html")
