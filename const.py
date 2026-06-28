"""Constants for youtube-zero.

Pure literals and env-var-derived configuration values. No imports from
other project modules — safe to import anywhere in the codebase.
"""
import os


# ── Paths & external URLs ────────────────────────────────────────────────────
DB_PATH = os.environ.get(
    "DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "youtube_zero.db"),
)
YT_API = "https://www.googleapis.com/youtube/v3"
SIGNAL_API_URL = os.environ.get("SIGNAL_API_URL", "http://signal-api:8080")
ADB_API_URL = os.environ.get("ADB_API_URL", "http://adb-api:8080")

# Embed/player host. With nocookie (the default) the in-app player and its
# control API are served from youtube-nocookie.com, so the player keeps working
# even when www.youtube.com (the website) is blocked at the DNS level — the two
# share no hostname. Set USE_NOCOOKIE=0 to fall back to www.youtube.com (e.g. if
# youtube-nocookie is unreachable). "Watch on YouTube" links intentionally point
# at www.youtube.com regardless, so they break under a site block — as intended.
USE_NOCOOKIE = os.environ.get("USE_NOCOOKIE", "1") == "1"
YT_EMBED_HOST = "https://www.youtube-nocookie.com" if USE_NOCOOKIE else "https://www.youtube.com"


# ── Background refresh ───────────────────────────────────────────────────────
REFRESH_INTERVAL = int(os.environ.get("REFRESH_INTERVAL_SECONDS", "0"))
REFRESH_CONCURRENCY = 5          # parallel channels per refresh sweep
REFRESH_BACKOFF_SECONDS = 0.06   # pause between fetches to avoid stampede


# ── Quiet hours ──────────────────────────────────────────────────────────────
QUIET_START = int(os.environ.get("QUIET_HOURS_START", "0"))
QUIET_END = int(os.environ.get("QUIET_HOURS_END", "6"))
TZ_NAME = os.environ.get("TZ", "UTC")


# ── YouTube API ──────────────────────────────────────────────────────────────
YT_CHUNK_SIZE = 50            # max video IDs per videos.list call
YT_PLAYLIST_PAGE = 10         # default playlist items per page
DAILY_QUOTA_LIMIT = 10000


# ── Video classification ─────────────────────────────────────────────────────
SHORTS_MAX_SECONDS = 180      # videos shorter than this are treated as Shorts


# ── HTTP timeouts (seconds) ──────────────────────────────────────────────────
HTTP_TIMEOUT_SHORT = 15       # quick reads (settings, qr code)
HTTP_TIMEOUT_LONG = 30        # signal sends, image uploads
SIGNAL_RECONNECT_PAUSE = 5    # backoff between signal-listener reconnects
