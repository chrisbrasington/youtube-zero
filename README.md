# YouTube Zero

Inbox-zero for YouTube subscriptions. Add channels, see new videos, queue what you want to watch, dismiss the rest.

## Features

- Add any YouTube channel by URL, `@handle`, or name
- Compact strip view — unread videos appear as tiles below each channel header by default, no clicking required
- **+** badge on every tile queues instantly; queue persists until watched or removed
- In-app video player with normal, theater, and fullscreen modes
- Circle checkbox marks entire channel as read and collapses it
- Per-video read/unread toggle in expanded list view
- Drag channels to reorder, or sort by newest video
- **☢ Clear All** — nuclear dismiss everything, queue untouched
- Dark theme, no JavaScript framework, no build step

![](./.img/app.png)

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
Cost: adding a channel ≈ 3 units, refreshing a channel ≈ 2 units.

## Usage

### Channel list

| Action | How |
|--------|-----|
| Add channel | Type URL / `@handle` / name → **Add** |
| Queue a video | Click **+** badge on any tile |
| Unqueue | Click **✓** (green) on a queued tile or row |
| Expand full list | Click **▼** on channel header |
| Mark channel read | Click the circle ◎ left of the channel avatar |
| Mark channel unread | Click **↺** in the channel header |
| Refresh videos | **↻** per-channel or **↻ Refresh All** |
| Reorder channels | Drag and drop (in manual order mode) |
| Sort by newest | Click **↕ Manual order** to toggle **↕ Newest first** |
| Nuclear clear | **☢ Clear All** — marks every channel read |

### Expanded list view (click ▼)

| Action | How |
|--------|-----|
| Mark video read | Click ◉ (filled circle) next to the video |
| Mark video unread | Click ● (dim circle) on a read video |
| Play in app | Click the video thumbnail |

### Queue

| Action | How |
|--------|-----|
| Play in app | **▶ Play** — opens the in-app player |
| Open in YouTube | **↗ YouTube** — opens new tab, marks watched |
| Remove | **Remove** — drops from queue without watching |

### Player

| Action | How |
|--------|-----|
| Theater mode | **⬜ Theater** — expands to 92 % of viewport |
| Fullscreen | **⛶** button or press **f** |
| Mark watched & close | **✓ Watched** (only when playing from queue) |
| Close | **✕**, click backdrop, or press **Escape** |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `YOUTUBE_API_KEY` | _(set via UI)_ | YouTube Data API v3 key |
| `DB_PATH` | `./youtube_zero.db` | SQLite database path |

## Stack

- **Python 3.13** + FastAPI + SQLite
- Vanilla JS — no framework, no build step
- [uv](https://github.com/astral-sh/uv) for Docker dependency installs
