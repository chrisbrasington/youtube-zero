"""Reusable SQLite query helpers for youtube-zero.

Each function opens its own short-lived connection via `db()`. For multi-
statement transactions, callers should use `with db() as c:` directly rather
than chaining helpers (which would each get their own connection).

Functions are grouped by table/concern: settings, quota, channels, folders,
queue, video status.
"""
from datetime import datetime, timezone
from typing import Optional

from db import db


# ── Settings ─────────────────────────────────────────────────────────────────

def get_setting(key: str) -> Optional[str]:
    with db() as c:
        row = c.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
    return row["value"] if row else None


def set_setting(key: str, value: str) -> None:
    with db() as c:
        c.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value),
        )
        c.commit()


def delete_setting(key: str) -> None:
    with db() as c:
        c.execute("DELETE FROM settings WHERE key = ?", (key,))
        c.commit()


def get_all_settings() -> dict:
    with db() as c:
        rows = c.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


# ── Quota ────────────────────────────────────────────────────────────────────

# Process-level counter for "units consumed since this uvicorn started".
# Resets on every restart; the persistent counterpart lives in quota_log.
_session_quota = 0


def session_quota_units() -> int:
    return _session_quota


def quota_today() -> str:
    """Date key aligned with Google's YouTube Data API quota reset (midnight Pacific)."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()
    except Exception:
        return datetime.now(timezone.utc).date().isoformat()


def add_quota(units: int) -> None:
    """Record `units` against today's quota log AND the session counter."""
    global _session_quota
    _session_quota += units
    today = quota_today()
    with db() as c:
        c.execute(
            """INSERT INTO quota_log (date, units) VALUES (?, ?)
               ON CONFLICT(date) DO UPDATE SET units = units + excluded.units""",
            (today, units),
        )
        c.commit()


def get_quota_today_units() -> int:
    today = quota_today()
    with db() as c:
        row = c.execute(
            "SELECT units FROM quota_log WHERE date = ?", (today,)
        ).fetchone()
    return row["units"] if row else 0


# ── Channels ─────────────────────────────────────────────────────────────────

def list_channels() -> list[dict]:
    with db() as c:
        rows = c.execute("SELECT * FROM channels").fetchall()
    return [dict(r) for r in rows]


def max_last_refreshed() -> Optional[str]:
    with db() as c:
        row = c.execute(
            "SELECT MAX(last_refreshed) AS t FROM channels"
        ).fetchone()
    return row["t"] if row else None


# ── Folders ──────────────────────────────────────────────────────────────────

def list_folders() -> list[dict]:
    with db() as c:
        rows = c.execute(
            "SELECT * FROM folders ORDER BY COALESCE(sort_order, id)"
        ).fetchall()
    return [dict(r) for r in rows]


# ── Queue ────────────────────────────────────────────────────────────────────

def get_queue(is_deep: bool = False) -> list[dict]:
    """Unwatched queue items, sorted by their explicit sort_order then id."""
    with db() as c:
        rows = c.execute(
            "SELECT * FROM queue "
            "WHERE watched_at IS NULL AND COALESCE(is_deep, 0) = ? "
            "ORDER BY COALESCE(sort_order, id)",
            (1 if is_deep else 0,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_history(search: str = "", limit: int = 50, offset: int = 0) -> list[dict]:
    """Watched queue items, newest first. Optional case-insensitive search
    over title + channel name spans the whole table, not just one page."""
    sql = (
        "SELECT q.*, v.duration AS duration, v.is_live AS is_live "
        "FROM queue q LEFT JOIN videos v ON v.video_id = q.video_id "
        "WHERE q.watched_at IS NOT NULL"
    )
    params: list = []
    if search:
        sql += " AND (q.title LIKE ? OR q.channel_name LIKE ?)"
        params += [f"%{search}%", f"%{search}%"]
    sql += " ORDER BY q.watched_at DESC LIMIT ? OFFSET ?"
    params += [limit, offset]
    with db() as c:
        rows = c.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def count_history(search: str = "") -> int:
    """Total watched-queue rows matching the optional search filter."""
    sql = "SELECT COUNT(*) AS n FROM queue WHERE watched_at IS NOT NULL"
    params: list = []
    if search:
        sql += " AND (title LIKE ? OR channel_name LIKE ?)"
        params += [f"%{search}%", f"%{search}%"]
    with db() as c:
        row = c.execute(sql, params).fetchone()
    return int(row["n"])


def unwatched_queue_video_ids() -> set[str]:
    with db() as c:
        rows = c.execute(
            "SELECT video_id FROM queue WHERE watched_at IS NULL"
        ).fetchall()
    return {r["video_id"] for r in rows}


def next_queue_sort_order(c=None) -> int:
    """Next ordering slot (max+1) for unwatched queue items.

    Accepts an optional cursor so callers in the middle of a transaction can
    reuse their connection. Falls back to opening its own when absent.
    """
    if c is not None:
        row = c.execute(
            "SELECT COALESCE(MAX(sort_order), -1) AS m "
            "FROM queue WHERE watched_at IS NULL"
        ).fetchone()
        return int(row["m"]) + 1
    with db() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) AS m "
            "FROM queue WHERE watched_at IS NULL"
        ).fetchone()
    return int(row["m"]) + 1


def clear_queue(deep: bool = False) -> None:
    """Remove all unwatched items from either main or deep queue."""
    with db() as c:
        c.execute(
            "DELETE FROM queue WHERE watched_at IS NULL AND COALESCE(is_deep, 0) = ?",
            (1 if deep else 0,),
        )
        c.commit()


# ── Video status ─────────────────────────────────────────────────────────────

def clear_video_status_for_channel(channel_id: str) -> None:
    with db() as c:
        c.execute("DELETE FROM video_status WHERE channel_id = ?", (channel_id,))
        c.commit()
