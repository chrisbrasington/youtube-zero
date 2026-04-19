import asyncio
import base64
import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from typing import Optional

import httpx
import websockets
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL_SECONDS", "0"))
QUIET_START = int(os.environ.get("QUIET_HOURS_START", "0"))
QUIET_END = int(os.environ.get("QUIET_HOURS_END", "6"))
TZ_NAME = os.environ.get("TZ", "UTC")


def _is_quiet_hour() -> bool:
    if QUIET_START == QUIET_END:
        return False
    try:
        from zoneinfo import ZoneInfo
        h = datetime.now(ZoneInfo(TZ_NAME)).hour
    except Exception:
        h = datetime.now(timezone.utc).hour
    if QUIET_START < QUIET_END:
        return QUIET_START <= h < QUIET_END
    return h >= QUIET_START or h < QUIET_END  # wraps midnight

_event_listeners: set[asyncio.Queue] = set()


async def _broadcast(event_type: str, **extra):
    payload = {"type": event_type, **extra}
    for q in list(_event_listeners):
        await q.put(payload)


async def _refresh_channels(api_key: str) -> list[dict]:
    """Parallel refresh all channels (sem=5), save, broadcast. Returns per-channel results."""
    with db() as c:
        channels = [dict(r) for r in c.execute("SELECT * FROM channels").fetchall()]
    total = len(channels)
    sem = asyncio.Semaphore(5)
    lock = asyncio.Lock()
    started = 0

    async def fetch_one(ch):
        nonlocal started
        async with sem:
            async with lock:
                started += 1
                name = ch.get("handle") or ch.get("name") or ch["channel_id"]
                await _broadcast("refresh_progress", i=started, total=total, name=name)
                await asyncio.sleep(0.06)
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
    await asyncio.sleep(REFRESH_INTERVAL)
    while True:
        try:
            if _is_quiet_hour():
                print(f"[bg refresh] quiet hours ({QUIET_START}-{QUIET_END} {TZ_NAME}) — skipping")
            else:
                api_key = get_api_key()
                if api_key:
                    await _refresh_channels(api_key)
        except Exception:
            pass
        await asyncio.sleep(REFRESH_INTERVAL)


def _is_short(v: dict) -> bool:
    if (v.get("is_live") or "none") != "none":
        return False  # live/upcoming never a short
    dur = v.get("duration") or ""
    if not dur:
        return False  # unknown duration = don't treat as short
    secs = _duration_seconds(dur)
    if secs <= 0 or secs >= 180:
        return False
    w, h = v.get("thumb_w") or 0, v.get("thumb_h") or 0
    # Portrait thumbnail = strong signal, otherwise fall back to duration-only
    return h >= w if (w and h) else True


def _duration_seconds(dur: str) -> int:
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


async def _signal_send_plain(number: str, message: str):
    payload = {"message": message, "number": number, "recipients": [number]}
    async with httpx.AsyncClient() as client:
        try:
            await client.post(f"{SIGNAL_API_URL}/v2/send", json=payload, timeout=30)
        except Exception:
            pass


async def _send_queue_to_signal(number: str) -> list[str]:
    with db() as c:
        items = [dict(r) for r in c.execute(
            "SELECT * FROM queue WHERE watched_at IS NULL ORDER BY COALESCE(sort_order, id)"
        ).fetchall()]
    for item in items:
        await _signal_send_one(number, item["video_id"], item["title"], item["channel_name"], item.get("thumbnail_url") or "")
    return [i["video_id"] for i in items]


async def _send_unread_to_signal(number: str, exclude_ids: set[str] | None = None) -> int:
    exclude_ids = exclude_ids or set()
    with db() as c:
        rows = c.execute("SELECT key, value FROM settings").fetchall()
        hide_shorts = {r["key"]: r["value"] for r in rows}.get("hide_shorts", "0") == "1"
        chs = [dict(r) for r in c.execute("SELECT * FROM channels").fetchall()]
        unread = []
        for ch in chs:
            vids = _channel_videos(c, ch["channel_id"], ch["read_before"], set())
            for v in vids:
                if v["is_read"]:
                    continue
                if v["video_id"] in exclude_ids:
                    continue
                if hide_shorts and _is_short(v):
                    continue
                v["channel_name"] = ch["name"]
                unread.append(v)
    for v in unread:
        await _signal_send_one(number, v["video_id"], v["title"], v["channel_name"], v.get("thumbnail_url") or "")
    return len(unread)


_HELP_TEXT = (
    "commands:\n"
    "/ping — pong\n"
    "/get — queue + visible videos\n"
    "/queue — queue only\n"
    "/refresh — refresh then /get\n"
    "/nuke — mark all visible as read\n"
    "/undo — today's videos visible again\n"
    "/clear — empty queue\n"
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


async def _handle_signal_command(cmd: str, number: str):
    cmd = cmd.strip().lower()
    if cmd == "/ping":
        await _signal_send_plain(number, "pong")
    elif cmd == "/help":
        await _signal_send_plain(number, _HELP_TEXT)
    elif cmd == "/get":
        await _do_get(number)
    elif cmd == "/queue":
        queued_ids = await _send_queue_to_signal(number)
        await _signal_send_plain(number, f"sent {len(queued_ids)} from queue" if queued_ids else "queue empty ✓")
    elif cmd == "/clear":
        with db() as c:
            c.execute("DELETE FROM queue WHERE watched_at IS NULL")
            c.commit()
        await _broadcast("refreshed")
        await _signal_send_plain(number, "queue cleared ✓")
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
        cutoff = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        with db() as c:
            c.execute("UPDATE channels SET read_before=? WHERE read_before > ?", (cutoff, cutoff))
            c.execute("""DELETE FROM video_status WHERE status='read' AND video_id IN (
                SELECT video_id FROM videos WHERE published_at > ?)""", (cutoff,))
            c.commit()
        await _broadcast("refreshed")
        await _signal_send_plain(number, "undone — today visible ✓")


async def _signal_listener():
    await asyncio.sleep(5)  # let app boot
    start_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    ws_base = SIGNAL_API_URL.replace("http://", "ws://").replace("https://", "wss://")
    while True:
        try:
            with db() as c:
                row = c.execute("SELECT value FROM settings WHERE key='signal_number'").fetchone()
            if not row:
                await asyncio.sleep(10)
                continue
            number = row["value"]
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
            print(f"[signal listener] ws error: {exc} — reconnecting in 5s")
            await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app):
    asyncio.create_task(_background_refresh())
    asyncio.create_task(_signal_listener())
    yield


app = FastAPI(lifespan=lifespan)

_session_quota = 0  # resets on process restart

DB_PATH = os.environ.get(
    "DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "youtube_zero.db"),
)
YT_API = "https://www.googleapis.com/youtube/v3"
SIGNAL_API_URL = os.environ.get("SIGNAL_API_URL", "http://signal-api:8080")


# ── Database ──────────────────────────────────────────────────────────────────

@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS channels (
                id INTEGER PRIMARY KEY,
                channel_id TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                thumbnail_url TEXT,
                handle TEXT,
                uploads_playlist_id TEXT NOT NULL,
                read_before TEXT,
                last_refreshed TEXT,
                sort_order INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY,
                video_id TEXT UNIQUE NOT NULL,
                channel_id TEXT NOT NULL,
                title TEXT NOT NULL,
                thumbnail_url TEXT,
                published_at TEXT NOT NULL,
                duration TEXT,
                is_live TEXT,
                thumb_w INTEGER,
                thumb_h INTEGER
            );
            CREATE TABLE IF NOT EXISTS queue (
                id INTEGER PRIMARY KEY,
                video_id TEXT UNIQUE NOT NULL,
                channel_id TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                title TEXT NOT NULL,
                thumbnail_url TEXT,
                published_at TEXT,
                sort_order INTEGER,
                added_at TEXT DEFAULT CURRENT_TIMESTAMP,
                watched_at TEXT
            );
            CREATE TABLE IF NOT EXISTS video_status (
                video_id   TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                status     TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS quota_log (
                date  TEXT PRIMARY KEY,
                units INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS folders (
                id         INTEGER PRIMARY KEY,
                name       TEXT NOT NULL,
                icon       TEXT NOT NULL DEFAULT '📁',
                sort_order INTEGER,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        """)
        c.commit()
        # Migrations for existing DBs
        for migration in [
            "ALTER TABLE channels ADD COLUMN sort_order INTEGER",
            "ALTER TABLE channels ADD COLUMN folder_id INTEGER REFERENCES folders(id)",
            "ALTER TABLE folders ADD COLUMN icon TEXT DEFAULT '📁'",
            "ALTER TABLE queue ADD COLUMN sort_order INTEGER",
            "ALTER TABLE videos ADD COLUMN is_live TEXT",
            "ALTER TABLE videos ADD COLUMN thumb_w INTEGER",
            "ALTER TABLE videos ADD COLUMN thumb_h INTEGER",
        ]:
            try:
                c.execute(migration)
            except sqlite3.OperationalError:
                pass
        c.execute("UPDATE channels SET sort_order = id WHERE sort_order IS NULL")
        c.commit()


init_db()


def add_quota(units: int):
    global _session_quota
    _session_quota += units
    today = datetime.now(timezone.utc).date().isoformat()
    with db() as c:
        c.execute(
            """INSERT INTO quota_log (date, units) VALUES (?, ?)
               ON CONFLICT(date) DO UPDATE SET units = units + excluded.units""",
            (today, units),
        )
        c.commit()


# ── YouTube helpers ───────────────────────────────────────────────────────────

def get_api_key():
    key = os.environ.get("YOUTUBE_API_KEY", "")
    if not key:
        with db() as c:
            row = c.execute("SELECT value FROM settings WHERE key='api_key'").fetchone()
            if row:
                key = row["value"]
    return key


def parse_duration(iso: str) -> str:
    """PT4M33S → 4:33"""
    if not iso:
        return ""
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso)
    if not m:
        return ""
    h = int(m.group(1) or 0)
    mn = int(m.group(2) or 0)
    s = int(m.group(3) or 0)
    return f"{h}:{mn:02d}:{s:02d}" if h else f"{mn}:{s:02d}"


def parse_channel_input(inp: str):
    inp = inp.strip()
    m = re.search(r"youtube\.com/channel/(UC[A-Za-z0-9_-]+)", inp)
    if m:
        return "id", m.group(1)
    m = re.search(r"youtube\.com/@([A-Za-z0-9_.-]+)", inp)
    if m:
        return "handle", m.group(1)
    if inp.startswith("@"):
        return "handle", inp[1:]
    return "handle", inp


async def yt_get_channel(lookup_type: str, value: str, api_key: str):
    params = {"part": "snippet,contentDetails", "key": api_key}
    params["id" if lookup_type == "id" else "forHandle"] = value
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{YT_API}/channels", params=params)
    if r.status_code != 200:
        detail = r.json().get("error", {}).get("message", r.text)
        raise HTTPException(502, f"YouTube API: {detail}")
    add_quota(1)
    items = r.json().get("items", [])
    if not items:
        raise HTTPException(404, f"Channel not found: {value}")
    item = items[0]
    thumbnails = item["snippet"].get("thumbnails", {})
    thumb = (
        thumbnails.get("medium") or thumbnails.get("default") or {}
    ).get("url", "")
    return {
        "channel_id": item["id"],
        "name": item["snippet"]["title"],
        "thumbnail_url": thumb,
        "handle": item["snippet"].get("customUrl", "").lstrip("@"),
        "uploads_playlist_id": item["contentDetails"]["relatedPlaylists"]["uploads"],
    }


async def yt_fetch_videos(playlist_id: str, api_key: str, max_results: int = 10):
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{YT_API}/playlistItems", params={
            "part": "snippet",
            "playlistId": playlist_id,
            "maxResults": max_results,
            "key": api_key,
        })
    if r.status_code != 200:
        detail = r.json().get("error", {}).get("message", r.text)
        raise HTTPException(502, f"YouTube API: {detail}")
    add_quota(1)  # playlistItems.list

    videos = []
    video_ids = []
    for item in r.json().get("items", []):
        sn = item["snippet"]
        vid = sn.get("resourceId", {}).get("videoId", "")
        if not vid:
            continue
        video_ids.append(vid)
        thumbnails = sn.get("thumbnails", {})
        picked = thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default") or {}
        videos.append({
            "video_id": vid,
            "channel_id": sn.get("channelId", ""),
            "title": sn.get("title", ""),
            "thumbnail_url": picked.get("url", ""),
            "published_at": sn.get("publishedAt", ""),
            "duration": "",
            "is_live": "none",
            "thumb_w": picked.get("width") or 0,
            "thumb_h": picked.get("height") or 0,
        })

    if video_ids:
        async with httpx.AsyncClient(timeout=15) as client:
            r2 = await client.get(f"{YT_API}/videos", params={
                "part": "contentDetails,snippet",
                "id": ",".join(video_ids),
                "key": api_key,
            })
        add_quota(1)  # videos.list (durations + snippet)
        meta_map = {}
        for d in r2.json().get("items", []):
            meta_map[d["id"]] = {
                "duration": parse_duration(d["contentDetails"]["duration"]),
                "is_live": d.get("snippet", {}).get("liveBroadcastContent", "none"),
            }
        for v in videos:
            m = meta_map.get(v["video_id"], {})
            v["duration"] = m.get("duration", "")
            v["is_live"] = m.get("is_live", "none")

    return videos


def save_videos(channel_id: str, videos: list):
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        for v in videos:
            v = dict(v)
            v["channel_id"] = channel_id
            c.execute(
                """INSERT OR REPLACE INTO videos
                   (video_id, channel_id, title, thumbnail_url, published_at, duration, is_live, thumb_w, thumb_h)
                   VALUES (:video_id, :channel_id, :title, :thumbnail_url, :published_at, :duration, :is_live, :thumb_w, :thumb_h)""",
                v,
            )
        c.execute(
            "UPDATE channels SET last_refreshed=? WHERE channel_id=?",
            (now, channel_id),
        )
        c.commit()


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

class ApiKeyReq(BaseModel):
    api_key: str

class ReorderReq(BaseModel):
    ids: list[str]

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
                event = await queue.get()
                yield f"data: {_json.dumps(event)}\n\n"
        finally:
            _event_listeners.discard(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/settings")
@app.get("/api/quota")
def quota_get():
    today = datetime.now(timezone.utc).date().isoformat()
    with db() as c:
        row = c.execute(
            "SELECT units FROM quota_log WHERE date=?", (today,)
        ).fetchone()
        last = c.execute("SELECT MAX(last_refreshed) AS t FROM channels").fetchone()
    return {
        "today":   row["units"] if row else 0,
        "session": _session_quota,
        "limit":   10000,
        "date":    today,
        "last_refreshed": last["t"] if last else None,
    }


@app.get("/api/settings")
def settings_get():
    with db() as c:
        rows = {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM settings").fetchall()}
    key = rows.get("api_key", "")
    masked = (key[:4] + "…" + key[-4:]) if len(key) > 8 else ("****" if key else "")
    return {
        "has_api_key": bool(key),
        "masked": masked,
        "hide_shorts": rows.get("hide_shorts", "0") == "1",
    }


@app.post("/api/settings/api-key")
def settings_set_key(req: ApiKeyReq):
    with db() as c:
        c.execute(
            "INSERT OR REPLACE INTO settings VALUES ('api_key', ?)", (req.api_key,)
        )
        c.commit()
    return {"ok": True}


class HideShortsReq(BaseModel):
    hide_shorts: bool

@app.post("/api/settings/hide-shorts")
def settings_hide_shorts(req: HideShortsReq):
    with db() as c:
        c.execute(
            "INSERT OR REPLACE INTO settings VALUES ('hide_shorts', ?)",
            ("1" if req.hide_shorts else "0",)
        )
        c.commit()
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
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='signal_number'").fetchone()
    return {
        "configured": bool(row),
        "number": row["value"] if row else "",
    }

@app.post("/api/settings/signal/link")
def signal_link(req: SignalLinkReq):
    number = req.number.strip()
    if not number:
        raise HTTPException(400, "Phone number required")
    with db() as c:
        c.execute("INSERT OR REPLACE INTO settings VALUES ('signal_number', ?)", (number,))
        c.commit()
    return {"ok": True, "number": number}

@app.get("/api/settings/signal/qr")
async def signal_qr():
    async with httpx.AsyncClient() as client:
        try:
            r = await client.get(
                f"{SIGNAL_API_URL}/v1/qrcodelink?device_name=youtube-zero",
                timeout=30,
            )
        except Exception as exc:
            raise HTTPException(503, f"Signal API unavailable: {exc}")
    if r.status_code != 200:
        raise HTTPException(503, "Signal API error — is the signal-api service running?")
    return Response(content=r.content, media_type="image/png")

@app.delete("/api/settings/signal")
def signal_delete():
    with db() as c:
        c.execute("DELETE FROM settings WHERE key='signal_number'")
        c.commit()
    return {"ok": True}

async def _signal_preview(video_id: str, title: str, channel_name: str, thumbnail_url: str) -> dict | None:
    """Fetch thumbnail and build a signal-cli link_preview object. Returns None on any failure."""
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


async def _signal_send_one(number: str, video_id: str, title: str, channel_name: str, thumbnail_url: str) -> str | None:
    """Send one video to Signal. Returns error string or None on success."""
    message = f"https://www.youtube.com/watch?v={video_id}"
    preview = await _signal_preview(video_id, title, channel_name, thumbnail_url)
    payload: dict = {"message": message, "number": number, "recipients": [number]}
    if preview:
        payload["link_preview"] = preview
    print(f"[signal] sending {video_id} {'with' if preview else 'without'} preview")
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(f"{SIGNAL_API_URL}/v2/send", json=payload, timeout=30)
        except Exception as exc:
            return str(exc)
    print(f"[signal] send response: {r.status_code} {r.text[:300]}")
    if r.status_code not in (200, 201):
        return r.text[:200]
    return None


@app.post("/api/signal/send")
async def signal_send(req: SignalSendReq):
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='signal_number'").fetchone()
    if not row:
        raise HTTPException(400, "Signal not configured")
    err = await _signal_send_one(row["value"], req.video_id, req.title, req.channel_name, req.thumbnail_url or "")
    if err:
        raise HTTPException(500, f"Signal send failed: {err}")
    return {"ok": True}


@app.post("/api/signal/send-queue")
async def signal_send_queue():
    with db() as c:
        row = c.execute("SELECT value FROM settings WHERE key='signal_number'").fetchone()
        if not row:
            raise HTTPException(400, "Signal not configured")
        number = row["value"]
        items = [dict(r) for r in c.execute(
            "SELECT * FROM queue WHERE watched_at IS NULL ORDER BY COALESCE(sort_order, id)"
        ).fetchall()]
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


# ── Folder CRUD ───────────────────────────────────────────────────────────────

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
    with db() as c:
        channels = [dict(r) for r in c.execute("SELECT * FROM channels").fetchall()]

    async def generator():
        import asyncio as _asyncio
        total = len(channels)
        results = []
        sem = _asyncio.Semaphore(5)
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
                await _asyncio.sleep(0.06)  # visual stagger — fetches still run at full speed
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
            "SELECT * FROM queue WHERE watched_at IS NULL ORDER BY COALESCE(sort_order, id)"
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
                 added_at    = CURRENT_TIMESTAMP""",
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
def queue_clear(background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("DELETE FROM queue WHERE watched_at IS NULL")
        c.commit()
    background_tasks.add_task(_broadcast, "refreshed")
    return {"ok": True}


@app.delete("/api/queue/{video_id}")
def queue_remove(video_id: str, background_tasks: BackgroundTasks):
    with db() as c:
        c.execute("DELETE FROM queue WHERE video_id=?", (video_id,))
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


# ── Static / SPA ──────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/{full_path:path}")
def spa(full_path: str):
    return FileResponse("static/index.html")
