# Prospects

Ideas not yet built. Rough plans, not commitments.

## Background audio (yt-dlp audio mode)

**Goal:** Keep audio playing when the phone locks or the tab is backgrounded, and make
the lockscreen play/pause actually work.

**Why the current player can't do it:** Playback runs through a YouTube IFrame embed.
Mobile browsers suspend cross-origin iframes in the background, and YouTube embeds block
background playback on purpose (it's a Premium feature in their app). The Media Session
lockscreen controls fire correctly but the suspended iframe never resumes. A native
same-origin `<audio>` element does keep playing in the background, so the fix is to feed
audio through `<audio>` instead of the iframe.

**Caveats:** Pulling audio streams via yt-dlp is a YouTube ToS gray area. yt-dlp also
breaks periodically when YouTube changes things, so this needs occasional upkeep. Fine for
a personal app; weigh it before relying on it.

### Starting plan

1. **Dependency** — add `yt-dlp` to the project deps.

2. **Server endpoint** — add a route that takes a video id and returns the audio-only
   stream. Two options:
   - Resolve and return the direct stream URL (simplest; URL may be short-lived /
     IP-bound, so the browser must use it quickly).
   - Proxy the stream through the server (more reliable, more bandwidth on the box).
   Start with resolve-and-return; fall back to proxy if the URLs don't play cross-origin.
   Cache the resolved URL briefly so re-requests don't re-hit yt-dlp.

3. **Frontend audio mode** — add a hidden `<audio>` element. When audio mode is on, play
   the stream from the new endpoint through it instead of the iframe. Keep the iframe for
   when video is actually on screen.

4. **Wire Media Session** — point the existing play/pause/next/prev handlers at the
   `<audio>` element. Most of the metadata wiring (title/artist/artwork) already exists and
   should carry over.

5. **Toggle + fallback** — a setting to switch between video (iframe) and audio
   (`<audio>`) playback. If yt-dlp resolution fails, fall back to the iframe so playback
   never just dies.

### Open questions

- Resolve-URL vs. proxy — decide after testing whether direct stream URLs play in mobile
  Safari/Chrome cross-origin.
- How long resolved URLs stay valid (affects cache TTL and whether proxying is required).
- Does audio mode need its own UI, or is it a quiet default once enabled?
