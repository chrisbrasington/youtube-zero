# YouTube Zero

Treat your YouTube subscriptions like an inbox, not a feed. 

- No algorithms
- No recommendations
- No endless scroll

Just a clear list of new videos from channels you chose.

Watch what matters, queue what you want, dismiss what doesn't. <u>When you're done, you're done.</u> The screen goes empty and stays that way.

## Features

<img src="./.img/app2.png" align="right" width="200" style="margin-right: 16px;" />

### User Interface

* Add YouTube channels via URL, `@handle`, or name
* Compact strip view showing unread videos as tiles under each channel
* Folder-based organization of channels
* Collapsible folders with mixed tile strip display
* Drag-and-drop channel reordering
* Sort channels by newest video
* Dark theme, no framework, no build step
* Real-time multi-client synchronization across tabs and devices

### Queuing

* One-click queueing via **+** badge on video tiles
* Persistent queue state until manually removed or marked watched
* Queue remains unaffected by bulk clearing actions
* Per-video read/unread state toggles in tile and list views
* Channel-level read state toggle with collapse support
* Global “Clear All” action (non-destructive to queue)

### Playback (local & external)

* <b>Send to TV via Android developer bridge container</b>
* <b>Play on Screen — cast to a `/watch` display and drive it from your phone</b>
* Embedded video player with normal, theater, and fullscreen modes
* Keyboard shortcuts for navigation and playback control
* Auto-refresh of feeds at configurable intervals (5 minutes to 24 hours)
* Shorts filtering (removes videos under 1m 40s from all views)
* Signal integration for sending individual videos or full queue to “Notes to Self”

<div style="clear: both;"></div>

---

![](./.img/app.png)

<img src="./.img/play%20location.png" width="80%">

<img src="./.img/which%20screen.png" width="80%">

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
docker compose up -d --build
docker compose logs -f
```

Create `.env` next to `compose.yaml` so the API key loads automatically:

```
YOUTUBE_API_KEY=AIza...
```

Or use the provided `deploy.sh` helper (pulls latest, rebuilds, tails logs):

```bash
./deploy.sh
```

The database is saved to `./data/youtube_zero.db` on the host. The API key can also be set via the UI.

### Signal setup (optional)

The `compose.yaml` includes a `signal-api` sidecar ([signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api)).

1. Start the stack: `docker compose up --build`
2. Open **⚙ Settings**, enter your phone number, click **Link Device**
3. Scan the QR code in Signal → Settings → Linked Devices → Link New Device
4. Signal button appears on video tiles and in the queue

#### Signal commands (Note-to-Self)

Text any of these to yourself in Note-to-Self — the app listens and reacts.

| Command | Action |
|---------|--------|
| `/ping` | pong (connectivity test) |
| `/get` | send queued + visible unread videos (deduped) |
| `/queue` | send queue items only |
| `/add <url>` | add a YouTube URL to the queue (channel not required to be subscribed) |
| `/play <url>` | play a YouTube URL on the TV (requires ADB-paired TV) |
| `/refresh` | parallel refresh all channels, then `/get` |
| `/nuke` | mark all visible videos as read |
| `/undo` | make today's videos visible again |
| `/clear` | empty the queue |
| `/dump` | move queue items back to unread (find original channel/video and unmark) |
| `/help` | list commands |

### Send to TV (Android TV via ADB)

The `compose.yaml` includes an `adb-api` sidecar that wraps `adb` for Android TVs.

1. On the TV: enable Developer Options → ADB debugging
2. In the app: **⚙ Settings** → enter TV LAN IP → **Save** → **Connect**
3. TV shows "Allow USB debugging from this computer?" — accept (key is stored)
4. **📺** button appears next to **✉ Signal** on every video — tap to launch on TV
5. **Use SmartTube** (default on) routes via [SmartTube](https://github.com/yuliskov/SmartTube) (`com.liskovsoft.smarttubetv.beta`); off lets the TV's default YouTube app handle it

ADB keys persist via `./adb-data:/root/.android` so the trust prompt only shows once.

### Play on Screen (cast to a /watch display)

Open `http://<host>:8000/watch` on any display — a spare monitor, an HTPC, a TV browser, or the
bundled Android app (`android-screen/`). It registers as a **screen** and waits. From your phone
at `/`, **📺 Play on Screen** sends a single video, a folder, or the whole queue to that screen,
and the phone becomes a remote: play/pause, seek, next/previous, mark-watched-&-next, captions,
fullscreen, and tap-to-jump through the playlist. Commands relay through the server over SSE —
nothing is streamed from the phone, the screen plays the YouTube embed itself.

If more than one screen is connected you pick which one; a single screen is auto-selected. The
screen reports what it's playing back to the remote, so the two stay in sync.

For a dedicated TV/monitor, build the WebView wrapper in `android-screen/` (see its README) — it
autoplays with sound, stays awake, and maps the remote's center button to play/pause.

#### Send to TV vs Play on Screen

Both put a video on another display, but they work differently:

| | 📺 Send to TV | 📺 Play on Screen |
|---|---|---|
| **How it reaches the display** | ADB tells the TV's YouTube/SmartTube app to open the video | A `/watch` page (browser or the Android app) plays the YouTube embed |
| **Setup** | ADB-paired Android TV + `adb-api` sidecar | Just open `/watch` on the display — no pairing |
| **After it starts** | Fire-and-forget; you control it with the TV's own remote | Your phone *is* the remote — play/pause, seek, queue, captions, fullscreen |
| **What you can send** | One video | A single video, a folder, or the whole queue |
| **Best for** | An Android TV you already drive with its remote | Any screen you want to control from your phone |

## YouTube API key

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
2. Enable **YouTube Data API v3**
3. Credentials → **Create credentials** → API key
4. (Optional) Restrict the key to YouTube Data API v3

Free quota: **10,000 units/day**.  
Cost: adding a channel ≈ 3 units, refreshing a channel ≈ 2 units.

## Usage

### Folders

| Action | How |
|--------|-----|
| Create folder | **📁 New Folder** button → enter name |
| Rename folder | Click **✏** on folder header |
| Delete folder | Click **✕** on folder header (channels move to root) |
| Move channel into folder | Use the folder **select dropdown** on the channel header |
| Move channel to root | Select **No folder** in the dropdown |
| Expand folder (show channels) | Click anywhere on folder header |
| Collapsed folder view | Mixed tile strip of all unread videos, newest first |
| Mark folder read | Click **✓ Mark Read** on folder header |

### Channels

| Action | How |
|--------|-----|
| Add channel | Type URL / `@handle` / name → **Add** |
| Queue a video | Click **+** badge on any tile |
| Unqueue | Click **✓** (green) on a queued tile or row |
| Expand full list | Click **▼** on channel header |
| Mark channel read | Click the circle ◎ left of the channel avatar |
| Mark channel unread | Click **↺** in the channel header |
| Mark video read (tile) | Click **✓** read button on tile |
| Refresh videos | **↻** per-channel or **↻ Refresh All** |
| Reorder channels/folders | Drag and drop (in manual order mode) |
| Sort by newest | Click **↕ Manual order** to toggle **↕ Newest first** |
| Nuclear clear | **☢ Clear All** — marks every channel read |
| Send to Signal | Click **✉** on any tile or video row |

### Expanded list view (click ▼)

| Action | How |
|--------|-----|
| Mark video read | Click ◉ (filled circle) next to the video |
| Mark video unread | Click ● (dim circle) on a read video |
| Play in app | Click the video thumbnail |
| Send to Signal | Click **✉** button on the video row |

### Queue

| Action | How |
|--------|-----|
| Play in app | **▶ Play** — opens the in-app player |
| Open in YouTube | **↗ YouTube** — opens new tab, marks watched |
| Remove | **Remove** — drops from queue without watching |
| Send to Signal | **✉ Signal** in queue header — sends all items one by one with previews |

### Player

| Action | How |
|--------|-----|
| Theater mode | **⬜ Theater** button or press **t** |
| Fullscreen | **⛶** button or press **f** |
| Open in YouTube | **↗** button or press **y** (closes player) |
| Send to Signal | Press **s** (closes player, sends with preview) |
| Mark watched & close | **✓ Watched** (only when playing from queue) |
| Close | **✕**, click backdrop, or press **Escape** |

### Auto-refresh

The header slider sets how often all channels refresh automatically:

| Setting | Interval |
|---------|----------|
| Off | Disabled |
| 5m – 24h | Configurable via slider |

Uncheck **Auto** to pause without changing the interval.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `YOUTUBE_API_KEY` | _(set via UI)_ | YouTube Data API v3 key |
| `DB_PATH` | `./youtube_zero.db` | SQLite database path |
| `SIGNAL_API_URL` | `http://signal-api:8080` | URL of signal-cli-rest-api sidecar |
| `REFRESH_INTERVAL_SECONDS` | `3600` | Background refresh interval; `0` to disable |

## Stack

- **Python 3.13** + FastAPI + SQLite
- Vanilla JS — no framework, no build step
- Server-Sent Events for real-time multi-client sync
- [uv](https://github.com/astral-sh/uv) for Docker dependency installs
- [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) for Signal integration (optional)
