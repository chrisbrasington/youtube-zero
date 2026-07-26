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


# ── Audio mode (background playback) ─────────────────────────────────────────
# Audio-only streams fed to a same-origin <audio> element, because the YouTube
# iframe is suspended the moment the app is backgrounded. See PROSPECTS.md.
AUDIO_MODE = os.environ.get("AUDIO_MODE", "1") == "1"   # 0 disables the endpoints
AUDIO_CACHE_TTL = int(os.environ.get("AUDIO_CACHE_TTL", "10800"))  # 3h; googlevideo URLs last ~6h
AUDIO_RESOLVE_TIMEOUT = 20    # socket timeout for a yt-dlp lookup
AUDIO_PROXY_CHUNK = 65536     # bytes per chunk when relaying the stream


# ── Server-delivered video ───────────────────────────────────────────────────
# When on, video plays from a same-origin <video> fed by ffmpeg remuxing the
# DASH streams, instead of the YouTube iframe. Backgrounding then works for
# video too and the audio-mode switchover never has to happen.
#
# Costs: ffmpeg per concurrent viewer, full video bitrate over the server's
# uplink, and seeking restarts the stream at the new offset (a generated stream
# has no byte ranges to seek within). Set 0 to go back to the iframe + audio
# switchover, which stays fully functional either way.
SERVER_VIDEO = os.environ.get("SERVER_VIDEO", "1") == "1"
SERVER_VIDEO_MAX_HEIGHT = int(os.environ.get("SERVER_VIDEO_MAX_HEIGHT", "1080"))
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.environ.get("FFPROBE_BIN", "ffprobe")
# Seconds either side of a seek target to scan for keyframes.
KEYFRAME_PROBE_WINDOW = 12
