# Prospects

Ideas not yet built. Rough plans, not commitments.

## Background audio — BUILT 2026-07-25

Shipped as audio mode. Kept here rather than moved to the README because the
*measurements* are the valuable part: they close off four dead ends and explain why the
implementation looks the way it does.

**Goal:** keep audio playing when the phone locks, and make the lockscreen controls work.

### Verdict (a) — the YouTube-iframe route is closed. Do not try it again.

Five attempts over ten weeks:

| Date | Approach | Result |
|---|---|---|
| 2026-05-13 `4e7f896` | Media Session API on the YT iframe | Controls fire, can't resume a suspended iframe. Still shipped |
| 2026-05-21 `76395d7` | Silent looping WAV to claim session ownership | Reverted after 5 minutes |
| 2026-06-27 `0eec054` | Re-issue `playVideo()` when YT self-pauses | Reverted after 10 hours |
| 2026-06-27 `bc846ad`…`8a8e61c` | Foreground service, MediaSession, wake lock, 3 visibility overrides, JS visibility spoof | Shipped, never verified |
| 2026-07-25 | The above + 2 more overrides + rAF instrumentation | **Measured. Unwinnable.** |

Pixel 9 Pro, Android 17 (SDK 37). The instrument that settled it was a
`requestAnimationFrame` counter — rAF is driven by the compositor and stops when the
renderer hides the page, so unlike `document.visibilityState` it can't be faked:

```
14:08:06.576  HB #3 raf=305  state=1  t=2    ← playing, ~100 frames/sec
14:08:07.401  dispatchWindowVisibilityChanged real=8
14:08:07.402  onVisibilityAggregated        real=false
14:08:07.414  onWindowFocusChanged          real=false
14:08:09.578  HB #4 raf=97   state=2  t=3    ← already paused
14:08:12.580  HB #5 raf=0    state=2  t=3    ← compositor dead
```

1. **Chromium hides the page regardless of the embedder.** VISIBLE was forced through all
   five View-level paths. All fire with `real=false`, all get overridden, rAF still hits
   zero. WebView computes page visibility in the browser process, not from these
   callbacks. There is no View API left to override.
2. **The Android side was never the problem.** `startForeground` succeeded every time, no
   exceptions, wake lock held, transport controls demonstrably working.
3. **Audio focus is already handled** by Chromium's own `AudioFocusDelegate`.
4. **JS timers survive; media does not.** `setInterval` kept ticking at `raf=0`.
5. **Why four attempts were inconclusive:** the only visibility signal anyone had was
   `document.visibilityState`, which `MainActivity.VISIBILITY_SPOOF` overwrites. Every
   earlier attempt was reading back its own lie. The logs show `vis=visible` next to
   `raf=0`.

### Verdict (b) — a same-origin `<audio>` element survives. This is what got built.

Tested in isolation first — a local MP3, no yt-dlp, no endpoint — because every previous
attempt assumed a premise and built on it:

```
14:27:14.721  dispatchWindowVisibilityChanged real=8    ← screen locked
14:27:32.152  BGTEST #28 t=27.3 paused=false advancing=true stalls=0 readyState=4
```

28 samples, zero stalls, across two lock transitions. Same device, same day:

| | on `real=8` (window hidden) |
|---|---|
| YouTube iframe | pauses in ~70ms, compositor dead within 5s |
| same-origin `<audio>` | keeps advancing |

Notably the foreground service wasn't even running during that test, so `<audio>` survived
on its own; production additionally has the FGS.

### What shipped

- `audio_stream.py` — yt-dlp resolution of the best audio-only format, cached for
  `AUDIO_CACHE_TTL` (3h; googlevideo URLs last ~6h), run off the event loop.
- `GET /api/audio/{video_id}` — proxies the bytes with Range passthrough. Proxied rather
  than redirected because googlevideo URLs are IP-bound to whoever resolved them and carry
  no CORS headers. A 403/410 from an aged URL triggers one re-resolve.
- `POST /api/audio/{video_id}/prefetch` — warms the cache; the frontend calls it for the
  next queue item, so the 1-3s lookup never lands in a gap.
- Audio mode in `watch.js` behind a transport facade (`watchTime` / `watchSeek` /
  `watchTogglePlay` / …) so the list, advance, mark-as-read and queue rendering stay
  shared between the two players.
- `nativeOnBackground()` — the Android app hands the session to `<audio>` when
  backgrounded. One-way on purpose: switching back on every glance would stutter far more
  often than it would help.
- Fails soft throughout — any resolve error drops back to the iframe.

### Gotchas found while building

- **Do not pin `player_client`.** `["android","web"]` returned formats with no URLs at all
  (YouTube's SABR-only experiment, yt-dlp #12482). yt-dlp's default rotation worked, and
  it gets updated as YouTube shifts — pinning means re-diagnosing this by hand.
- **DNS.** An AdGuard rule (`||youtube.com^$client=…|valhalla|…`) null-routes
  `www.youtube.com`, which yt-dlp needs. It's a DNS block, not a firewall. Either drop the
  server from that client list or keep the `dns:` override in `compose.yaml`.

### Costs, unchanged

ToS gray area. yt-dlp breaks periodically and a fix means rebuilding the image. Playback
never registers a view for the creator. No captions or chapters in audio mode. Server
upload bandwidth carries every stream — trivial for audio (~20 MB per 30 minutes), which
is why this is audio-only and video stays on the iframe.
