# YouTube Zero

Inbox-zero for YouTube subscriptions. Add channels, see new videos, queue what you want to watch, dismiss the rest.

![screenshot placeholder](https://via.placeholder.com/800x400?text=YouTube+Zero)

## Features

- Add any YouTube channel by URL, `@handle`, or name
- Last 10 videos per channel, newest first
- **+** queues a video — queue persists until you watch or remove it
- Circle checkbox marks entire channel as read and collapses it
- **☢ Clear All** — nuclear dismiss everything across all channels
- Dark theme, no JavaScript framework, no build step

## Quick start

### Local (venv)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Open http://localhost:8000, click **⚙**, paste your API key.

### Docker

```bash
docker compose up --build
```

Or pass your key directly:

```bash
YOUTUBE_API_KEY=AIza... docker compose up --build
```

Data persists in a named volume (`yt_data`). The key can also be saved via the UI.

## YouTube API key

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
2. Enable **YouTube Data API v3**
3. Credentials → **Create credentials** → API key
4. (Optional) Restrict the key to YouTube Data API v3

Free quota: **10,000 units/day**.  
Cost per operation: adding a channel ≈ 3 units, refreshing all channels ≈ 2 units each.

## Usage

| Action | How |
|--------|-----|
| Add channel | Type URL / `@handle` / name → **Add** |
| Queue a video | Click **+** on any video row |
| Unqueue | Click **✓** (green) on a queued video |
| Mark channel read | Click the circle to the left of the channel avatar |
| Expand / collapse | Click anywhere on the channel header |
| Watch | Open **Queue** panel → **▶ Watch** (opens YouTube, removes from queue) |
| Refresh videos | **↻** per-channel or **↻ Refresh All** |
| Nuclear clear | **☢ Clear All** — marks every channel read, queue untouched |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `YOUTUBE_API_KEY` | _(set via UI)_ | YouTube Data API v3 key |
| `DB_PATH` | `./youtube_zero.db` | SQLite database path |

## Stack

- **Python 3.13** + FastAPI + SQLite
- Vanilla JS — no framework, no build step
- [uv](https://github.com/astral-sh/uv) for Docker dependency installs
