"""SQLite connection + schema bootstrap for youtube-zero.

Single module exposing:
  * `db()` — context manager yielding a `sqlite3.Connection` with row_factory
    set to `sqlite3.Row` and WAL journaling enabled.
  * `init_db()` — idempotent schema creation + ALTER-based migrations.
    Safe to call at module import time.
"""
import sqlite3
from contextlib import contextmanager

from const import DB_PATH


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
    finally:
        conn.close()


_SCHEMA = """
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
        watched_at TEXT,
        is_deep INTEGER DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS watch_history (
        video_id      TEXT PRIMARY KEY,
        channel_id    TEXT,
        channel_name  TEXT,
        title         TEXT,
        thumbnail_url TEXT,
        published_at  TEXT,
        watched_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS screen_beacons (
        id          INTEGER PRIMARY KEY,
        screen_name TEXT NOT NULL,
        uuid        TEXT NOT NULL,          -- normalized: lowercase, no dashes
        major       INTEGER NOT NULL,
        minor       INTEGER NOT NULL,
        tx_power    INTEGER,
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(screen_name),
        UNIQUE(uuid, major, minor)
    );
"""

# Idempotent column additions for databases created before each column existed.
# Each ALTER is wrapped in try/except OperationalError so reruns no-op cleanly.
_MIGRATIONS = [
    "ALTER TABLE channels ADD COLUMN sort_order INTEGER",
    "ALTER TABLE channels ADD COLUMN folder_id INTEGER REFERENCES folders(id)",
    "ALTER TABLE folders ADD COLUMN icon TEXT DEFAULT '📁'",
    "ALTER TABLE queue ADD COLUMN sort_order INTEGER",
    "ALTER TABLE queue ADD COLUMN is_deep INTEGER DEFAULT 0",
    "ALTER TABLE videos ADD COLUMN is_live TEXT",
    "ALTER TABLE videos ADD COLUMN thumb_w INTEGER",
    "ALTER TABLE videos ADD COLUMN thumb_h INTEGER",
    "ALTER TABLE channels ADD COLUMN allow_shorts INTEGER DEFAULT 0",
    "ALTER TABLE channels ADD COLUMN muted INTEGER DEFAULT 0",
]


def init_db():
    with db() as c:
        c.executescript(_SCHEMA)
        c.commit()
        for migration in _MIGRATIONS:
            try:
                c.execute(migration)
            except sqlite3.OperationalError:
                pass
        c.execute("UPDATE channels SET sort_order = id WHERE sort_order IS NULL")
        # One-time backfill of watch history from previously finished queue items.
        # INSERT OR IGNORE keeps reruns idempotent and never clobbers a newer play.
        c.execute(
            "INSERT OR IGNORE INTO watch_history "
            "(video_id, channel_id, channel_name, title, thumbnail_url, published_at, watched_at) "
            "SELECT video_id, channel_id, channel_name, title, thumbnail_url, published_at, watched_at "
            "FROM queue WHERE watched_at IS NOT NULL"
        )
        c.commit()
