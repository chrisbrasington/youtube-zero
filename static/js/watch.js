'use strict';

/*
 * In-page watch overlay + /watch URL handler.
 *
 * Classic script. Owns the YouTube iframe player lifecycle for the
 * binge-watch overlay used by both:
 *   - In-page entry via the "▶ Watch" buttons (preserves audio autoplay)
 *   - Standalone /watch, /watch/test, /watch/folder URL routes
 *
 * Depends on globals from state.js (state, findFolder, allChannels,
 * isShort), dom.js ($, esc, escAttr, status), api.js (api), and
 * shallowQueue / setInQueue / folderMixedStrip / render / isMobile
 * defined in app.js — all resolved at call time via shared script scope.
 */

let watchPlayer = null;
let watchDomBound = false;


function watchRouteFor(path) {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/tv')           return { mode: 'tv' };             // browse feed + cast receiver
  if (p === '/phone')        return { mode: 'phone' };          // /tv for a handset: no auto-fullscreen, queue-below-video
  if (p === '/watch')        return { mode: 'cast-receiver' };  // idle screen, waits for casts
  if (p === '/watch/queue')  return { mode: 'queue' };          // local binge of the queue
  if (p === '/watch/test')   return { mode: 'queue-test' };
  if (p === '/watch/folder') return { mode: 'folder' };
  return null;
}


// In-page entry points — preserve click gesture so audio autoplay works.

function watchStartQueue() {
  const list = shallowQueue().map(q => ({
    video_id: q.video_id, title: q.title,
    channel_name: q.channel_name, thumbnail_url: q.thumbnail_url,
    duration: q.duration,
  }));
  if (!list.length) {
    status('Queue empty', 'err'); setTimeout(() => status(''), 2000);
    return;
  }
  watchEnter({
    mode: 'queue', inPage: true, mutedStart: false, badgeLabel: '',
    list,
    mark: async (id) => {
      await api.post(`/api/queue/${id}/watched`);
      state.queue = state.queue.filter(q => q.video_id !== id);
      setInQueue(id, false);
    },
  });
}

function watchStartQueueWith(videoIds) {
  const list = videoIds.map(vid => videoMeta.get(vid)).filter(Boolean);
  if (!list.length) {
    status('No videos selected', 'err'); setTimeout(() => status(''), 2000);
    return;
  }
  // No `mark` — a quick queue is a throwaway playlist, so finishing a video
  // must not touch the real queue or read state.
  watchEnter({
    mode: 'queue', inPage: true, mutedStart: false, badgeLabel: '⚡ Quick Queue',
    list,
  });
}


// order: 'oldest' (default — work forward through the backlog) | 'newest'.
function watchStartFolder(folderId, order = 'oldest') {
  const folder = findFolder(folderId);
  if (!folder) return;
  const vids = folderMixedStrip(folder).filter(v => !isShort(v, v._channel));
  if (order !== 'newest') vids.reverse();   // strip is newest-first
  if (!vids.length) {
    status('Folder has no videos to watch', 'err'); setTimeout(() => status(''), 2000);
    return;
  }
  watchEnter({
    mode: 'folder', inPage: true, mutedStart: false,
    badgeLabel: `📁 ${folder.name}`,
    list: vids.map(v => ({
      video_id: v.video_id, title: v.title,
      channel_name: v._channel.name, thumbnail_url: v.thumbnail_url,
      duration: v.duration,
    })),
    mark: async (id) => {
      await api.post(`/api/videos/${id}/read`);
      for (const ch of allChannels()) {
        const v = (ch.videos || []).find(x => x.video_id === id);
        if (v) v.is_read = true;
      }
    },
  });
}


function watchRenderQueue() {
  const el = $('watch-queue-list');
  const list = state.watch?.list || [];
  $('watch-queue-count').textContent = list.length;
  if (!list.length) {
    el.innerHTML = '<div class="queue-empty">Empty</div>';
    return;
  }
  el.innerHTML = list.map(it => `
    <div class="q-item ${it.video_id === state.watch.currentVideoId ? 'playing' : ''}"
         data-watch-play data-video-id="${escAttr(it.video_id)}">
      <div class="q-thumb-wrap">
        <img class="q-thumb" src="${escAttr(it.thumbnail_url)}" alt=""
             onerror="this.src='data:image/svg+xml,<svg/>'">
        ${it.duration ? `<span class="q-dur">${esc(it.duration)}</span>` : ''}
      </div>
      <div class="q-info">
        <div class="q-title">${esc(it.title)}</div>
        <div class="q-channel">${esc(it.channel_name)}</div>
      </div>
    </div>`).join('');
  // Re-render dropped any D-pad focus ring — let the cast receiver restore it.
  if (typeof castNavReRender === 'function') castNavReRender();
}


function watchSetupYT() {
  if (!window.YT || !window.YT.Player) { setTimeout(watchSetupYT, 200); return; }
  if (watchPlayer) return;
  watchPlayer = new YT.Player('watch-frame', {
    events: {
      onReady: (e) => {
        try {
          if (state.watch?.mutedStart) e.target.mute();
          if (state.watch?.active) e.target.playVideo();  // skip if exited / idle
        } catch {}
        watchBindMediaSession();
        watchUpdateMediaSession();
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) watchAdvance({ fromEnd: true });
        if ('mediaSession' in navigator) {
          if (e.data === YT.PlayerState.PLAYING) navigator.mediaSession.playbackState = 'playing';
          else if (e.data === YT.PlayerState.PAUSED) navigator.mediaSession.playbackState = 'paused';
        }
      },
    },
  });
}


function watchPrev() {
  if (!state.watch) return;
  const list = state.watch.list || [];
  const idx = list.findIndex(v => v.video_id === state.watch.currentVideoId);
  if (idx > 0) watchPlay(list[idx - 1].video_id);
}


function watchUpdateMediaSession() {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  if (!state.watch) return;
  const item = (state.watch.list || []).find(v => v.video_id === state.watch.currentVideoId);
  if (!item) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title || '',
      artist: item.channel_name || '',
      artwork: item.thumbnail_url ? [{ src: item.thumbnail_url, sizes: '480x360', type: 'image/jpeg' }] : [],
    });
  } catch {}
}


let watchMsBound = false;
function watchBindMediaSession() {
  if (watchMsBound) return;
  if (!('mediaSession' in navigator)) return;
  watchMsBound = true;
  const ms = navigator.mediaSession;
  const safe = (name, fn) => { try { ms.setActionHandler(name, fn); } catch {} };
  // Routed through the transport facade so the lockscreen controls drive
  // whichever player is live — iframe or <audio>.
  safe('play',          () => { if (!watchIsPlaying()) watchTogglePlay(); });
  safe('pause',         () => { if (watchIsPlaying())  watchTogglePlay(); });
  safe('nexttrack',     () => watchAdvance({ fromEnd: true }));
  safe('previoustrack', () => watchPrev());
  safe('seekbackward',  (d) => watchSeek(watchTime() - (d?.seekOffset || 10)));
  safe('seekforward',   (d) => watchSeek(watchTime() + (d?.seekOffset || 10)));
  safe('seekto',        (d) => { if (d?.seekTime != null) watchSeek(d.seekTime); });
}


function watchArmUnmute() {
  const banner = $('watch-unmute');
  banner?.classList.remove('hidden');
  let poll = null;
  const cleanup = () => {
    banner?.classList.add('hidden');
    document.removeEventListener('click', onUserAct, true);
    document.removeEventListener('keydown', onUserAct, true);
    if (poll) { clearInterval(poll); poll = null; }
  };
  const onUserAct = () => {
    try { watchPlayer?.unMute?.(); watchPlayer?.setVolume?.(100); } catch {}
    cleanup();
  };
  document.addEventListener('click', onUserAct, true);
  document.addEventListener('keydown', onUserAct, true);
  poll = setInterval(() => {
    try {
      if (watchPlayer?.isMuted && !watchPlayer.isMuted()) cleanup();
    } catch {}
  }, 500);
}


// ── Transport facade ─────────────────────────────────────────────────────────
// Audio mode swaps the YouTube iframe for a same-origin <audio> element, because
// Chromium suspends the iframe the moment the app is backgrounded and does not
// suspend <audio> (both measured — see PROSPECTS.md). Everything else about a
// watch session is shared: the list, advance, mark-as-read, queue rendering.
// Only the handful of transport calls differ, so they all route through here.

function watchAudioEl() { return document.getElementById('watch-audio'); }
function watchIsAudio()  { return !!state.watch?.audio; }

/**
 * Destroy the YT player and swap in a fresh blank iframe.
 *
 * Blanking src alone is not enough: the YT.Player object survives, so the next
 * watchPlay takes the loadVideoById path and postMessages into an iframe that
 * is now on our own origin — which silently does nothing and leaves a black
 * rectangle. A clean iframe forces watchPlay's create-from-scratch path.
 *
 * Needed on the way into audio mode as well as on exit, since audio mode also
 * takes the video player out of service.
 */
function watchResetFrame() {
  const oldFrame = $('watch-frame');
  const freshFrame = oldFrame ? oldFrame.cloneNode(false) : null;
  if (freshFrame) freshFrame.removeAttribute('src');
  try { watchPlayer?.destroy?.(); } catch {}
  try { watchPlayer?.stopVideo?.(); } catch {}
  watchPlayer = null;
  if (freshFrame) {
    const cur = $('watch-frame');                  // destroy() usually removes it
    if (cur) cur.replaceWith(freshFrame);
    else $('watch-frame-wrap')?.insertBefore(freshFrame, $('watch-frame-wrap').firstChild);
  }
}

function watchTime() {
  if (watchIsAudio()) return watchAudioEl()?.currentTime || 0;
  try { return watchPlayer?.getCurrentTime?.() || 0; } catch { return 0; }
}

function watchDuration() {
  if (watchIsAudio()) {
    const d = watchAudioEl()?.duration;
    return Number.isFinite(d) ? d : 0;
  }
  try { return watchPlayer?.getDuration?.() || 0; } catch { return 0; }
}

function watchSeek(t) {
  const target = Math.max(0, t);
  if (watchIsAudio()) {
    const a = watchAudioEl();
    if (a) a.currentTime = target;
    return;
  }
  try { watchPlayer?.seekTo?.(target, true); } catch {}
}

function watchIsPlaying() {
  if (watchIsAudio()) { const a = watchAudioEl(); return !!a && !a.paused; }
  try { return watchPlayer?.getPlayerState?.() === 1; } catch { return false; }
}

function watchTogglePlay() {
  if (watchIsAudio()) {
    const a = watchAudioEl();
    if (!a) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
    return;
  }
  try {
    if (watchIsPlaying()) watchPlayer.pauseVideo(); else watchPlayer.playVideo();
  } catch {}
}


// ── Audio mode ───────────────────────────────────────────────────────────────

let watchAudioBound = false;

function watchBindAudio() {
  if (watchAudioBound) return;
  const a = watchAudioEl();
  if (!a) return;
  watchAudioBound = true;

  a.addEventListener('ended', () => {
    if (state.watch?.active && watchIsAudio()) watchAdvance({ fromEnd: true });
  });
  // A resolve failure (yt-dlp broken, video unavailable) must not dead-end the
  // session — drop back to the iframe and keep playing.
  a.addEventListener('error', () => {
    if (!state.watch?.active || !watchIsAudio()) return;
    status('Audio stream unavailable — using video', 'err');
    setTimeout(() => status(''), 3000);
    watchSetAudioMode(false);
  });
  ['play', 'pause', 'timeupdate', 'loadedmetadata'].forEach(evt =>
    a.addEventListener(evt, watchRenderNowPlaying));
}

function watchLoadAudio(videoId, startSeconds = 0) {
  const a = watchAudioEl();
  if (!a) return;
  watchBindAudio();
  a.src = `/api/audio/${encodeURIComponent(videoId)}`;
  if (startSeconds > 0) {
    // currentTime before metadata lands is discarded, so wait for the duration.
    a.addEventListener('loadedmetadata', () => {
      try { a.currentTime = startSeconds; } catch {}
    }, { once: true });
  }
  a.play().catch(() => {
    status('Tap play to start audio', 'err');
    setTimeout(() => status(''), 3000);
  });
}

/** Switch the running session between iframe and audio, keeping the position.
 *
 *  opts.persist — remember this as the browser's default. True for an explicit
 *    toggle, false for the automatic switch on backgrounding: auto-switching
 *    used to write the preference, so one pocketed phone left every later
 *    session stuck in audio.
 *  opts.auto — mark the switch as ours rather than the user's, so returning to
 *    the foreground can undo it.
 */
function watchSetAudioMode(on, opts = {}) {
  const { persist = true, auto = false } = opts;
  if (!state.watch) return;
  if (!!state.watch.audio === !!on) return;
  const at = watchTime();
  const videoId = state.watch.currentVideoId;

  if (on) {
    // Full teardown, not just a blanked src — see watchResetFrame. Leaving the
    // player object alive here is what made the return trip a black screen.
    watchResetFrame();
  } else {
    const a = watchAudioEl();
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
  }

  state.watch.audio = !!on;
  state.watch.audioAuto = on ? auto : false;
  $('watch-layout').classList.toggle('audio-mode', !!on);
  $('btn-watch-audio')?.classList.toggle('on', !!on);
  if (persist) localStorage.setItem('audioMode', on ? '1' : '0');
  if (videoId) watchPlay(videoId, at);
}

/** Warm the resolver so a 1-3s yt-dlp lookup never lands in a gap.
 *
 *  In audio mode that means the next item, for the transition between tracks.
 *  In video mode inside the Android app it means the *current* item, because
 *  backgrounding hands playback to <audio> and that swap should be instant.
 *
 *  Skipped entirely in a plain browser playing video — nothing there will ever
 *  need the audio stream, and resolving costs a YouTube round-trip. */
function watchPrefetchAudio() {
  if (!state.watch) return;
  const list = state.watch.list || [];
  const i = list.findIndex(v => v.video_id === state.watch.currentVideoId);
  const targets = [];
  if (watchIsAudio()) {
    if (i >= 0 && list[i + 1]) targets.push(list[i + 1].video_id);
  } else if (window.AndroidMedia && state.watch.currentVideoId) {
    targets.push(state.watch.currentVideoId);
  }
  for (const id of targets) api.post(`/api/audio/${id}/prefetch`).catch(() => {});
}

function watchRenderNowPlaying() {
  if (!state.watch?.active || !watchIsAudio()) return;
  const item = (state.watch.list || []).find(v => v.video_id === state.watch.currentVideoId);
  const cur = watchTime(), dur = watchDuration();
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };
  // Compare the attribute, not .src — reading .src gives the resolved absolute
  // URL, so it never equals the stored value and the image reloads every tick.
  const art = $('np-art');
  if (art) {
    const src = item?.thumbnail_url || '';
    if (src && art.getAttribute('src') !== src) art.setAttribute('src', src);
    if (!src) art.removeAttribute('src');
    art.classList.toggle('hidden', !src);
  }
  const t = $('np-title'); if (t) t.textContent = item?.title || '';
  const c = $('np-channel'); if (c) c.textContent = item?.channel_name || '';
  const e = $('np-elapsed'); if (e) e.textContent = fmt(cur);
  const d = $('np-duration'); if (d) d.textContent = fmt(dur);
  const bar = $('np-bar-fill');
  if (bar) bar.style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : '0%';
  const pp = $('btn-np-play');
  if (pp) pp.textContent = watchIsPlaying() ? '⏸' : '▶';
}


let watchLastPlayedId = null;

function watchPlay(videoId, startSeconds = 0) {
  const isNewVideo = videoId !== watchLastPlayedId;
  state.watch.currentVideoId = videoId;
  const item = (state.watch.list || []).find(v => v.video_id === videoId);
  // Record "started watching" so the video lands in history even if never
  // finished. Only on a genuinely new video — switching between video and audio
  // re-enters here for the same one and shouldn't log it twice.
  if (videoId && isNewVideo) {
    watchLastPlayedId = videoId;
    api.post(`/api/videos/${videoId}/played`, item
      ? { title: item.title, channel_name: item.channel_name, thumbnail_url: item.thumbnail_url }
      : {}).catch(() => {});
  }
  $('watch-title').textContent = item ? item.title : '';
  $('watch-yt-link').href = `https://www.youtube.com/watch?v=${videoId}`;

  if (watchIsAudio()) {
    watchLoadAudio(videoId, startSeconds);
  } else if (watchPlayer && watchPlayer.loadVideoById) {
    watchPlayer.loadVideoById(startSeconds > 0 ? { videoId, startSeconds } : videoId);
  } else {
    const origin = encodeURIComponent(location.origin);
    const mute   = state.watch.mutedStart ? '&mute=1' : '';
    const start  = startSeconds > 0 ? `&start=${Math.floor(startSeconds)}` : '';
    const frame  = $('watch-frame');
    frame.src = `${window.YT_EMBED_HOST}/embed/${videoId}?autoplay=1${mute}&rel=0&enablejsapi=1&origin=${origin}${start}`;
    frame.addEventListener('load', () => {
      watchSetupYT();
      if (state.watch?.mutedStart) watchArmUnmute();
    }, { once: true });
  }
  watchRenderQueue();
  watchUpdateMediaSession();
  watchRenderNowPlaying();
  watchPrefetchAudio();
}


async function watchAdvance({ fromEnd }) {
  if (!state.watch) return;
  const cur = state.watch.currentVideoId;
  const list0 = state.watch.list || [];
  const curIdx = cur ? list0.findIndex(v => v.video_id === cur) : -1;
  let removed = false;
  if (fromEnd && cur && state.watch.mark) {
    try { await state.watch.mark(cur); } catch {}
    state.watch.list = list0.filter(v => v.video_id !== cur);
    removed = true;
  }
  const list = state.watch.list || [];
  if (!list.length) { watchExit(); return; }
  if (state.watch.singleShot && fromEnd) { watchExit(); return; }
  let nextIdx;
  if (curIdx < 0) nextIdx = 0;
  else if (removed) nextIdx = curIdx < list.length ? curIdx : 0;
  else nextIdx = (curIdx + 1) % list.length;
  watchPlay(list[nextIdx].video_id);
}


function watchTeardownOnUnload() {
  const stop = () => {
    try { watchPlayer?.stopVideo?.(); } catch {}
    const f = document.getElementById('watch-frame');
    if (f) f.src = '';
  };
  window.addEventListener('pagehide', stop);
  window.addEventListener('beforeunload', stop);
}
watchTeardownOnUnload();


async function watchRequestFullscreen() {
  const frame = $('watch-frame');
  const wrap = frame?.parentElement;
  for (const el of [wrap, frame]) {
    if (!el?.requestFullscreen) continue;
    try { await el.requestFullscreen(); return; } catch {}
  }
}


function watchBindDom() {
  if (watchDomBound) return;
  watchDomBound = true;

  $('btn-watch-exit').addEventListener('click', () => watchExit());
  $('btn-watch-fullscreen').addEventListener('click', () => {
    watchRequestFullscreen();
  });
  $('btn-watch-skip').addEventListener('click', () => watchAdvance({ fromEnd: false }));
  $('btn-watch-skip-mark').addEventListener('click', () => watchAdvance({ fromEnd: true }));

  // Audio mode: toggle + the now-playing transport that replaces the video.
  $('btn-watch-audio')?.addEventListener('click', () => watchSetAudioMode(!watchIsAudio()));
  $('btn-np-play')?.addEventListener('click', () => { watchTogglePlay(); watchRenderNowPlaying(); });
  $('btn-np-next')?.addEventListener('click', () => watchAdvance({ fromEnd: false }));
  $('btn-np-prev')?.addEventListener('click', () => watchPrev());
  // Back to video, resuming at the current position (watchSetAudioMode carries it).
  $('btn-np-video')?.addEventListener('click', () => watchSetAudioMode(false));
  $('np-bar')?.addEventListener('click', (e) => {
    const dur = watchDuration();
    if (!dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    watchSeek(dur * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    watchRenderNowPlaying();
  });

  const landscapeMq = matchMedia('(orientation: landscape)');
  const onOrientation = () => {
    if (!state.watch?.active || !isMobile()) return;
    if (landscapeMq.matches) {
      if (!document.fullscreenElement) watchRequestFullscreen();
    } else {
      if (document.fullscreenElement) { try { document.exitFullscreen?.(); } catch {} }
    }
  };
  landscapeMq.addEventListener?.('change', onOrientation);

  $('watch-queue-list').addEventListener('click', e => {
    const item = e.target.closest('[data-watch-play]');
    if (!item) return;
    const id = item.dataset.videoId;
    if (!id) return;
    if (id === state.watch?.currentVideoId) {
      if (!document.fullscreenElement) watchRequestFullscreen();
      return;
    }
    watchPlay(id);
  });

  document.addEventListener('keydown', e => {
    if (!state.watch?.active) return;
    if (e.target.matches('input,textarea')) return;
    if (e.key === 'f') {
      $('watch-frame').requestFullscreen?.().catch(() => {});
      e.preventDefault();
      return;
    }
    if (e.key === 'n') { watchAdvance({ fromEnd: false }); return; }
    if (e.key === 'N') { watchAdvance({ fromEnd: true }); return; }
    if (e.key === 'w') { watchExit(); return; }
    if (e.key === 't' || e.key === 'T') {
      const on = $('watch-layout').classList.toggle('theater');
      // Remember theater for the rest of the browser session so it survives
      // the queue closing and a fresh video opening (re-applied in watchEnter).
      sessionStorage.setItem('theaterPref', on ? '1' : '0');
      return;
    }
    if (e.key === 'a' || e.key === 'A') { watchSetAudioMode(!watchIsAudio()); return; }
    if (!watchPlayer && !watchIsAudio()) return;
    try {
      if (/^[0-9]$/.test(e.key)) {
        const dur = watchDuration();
        if (dur) watchSeek(dur * (parseInt(e.key, 10) / 10));
        e.preventDefault();
        return;
      }
      if (e.key === ' ' || e.key === 'k') { watchTogglePlay(); e.preventDefault(); return; }
      if (e.key === 'j')          { watchSeek(watchTime() - 10); e.preventDefault(); return; }
      if (e.key === 'l')          { watchSeek(watchTime() + 10); e.preventDefault(); return; }
      if (e.key === 'ArrowLeft')  { watchSeek(watchTime() - 5);  e.preventDefault(); return; }
      if (e.key === 'ArrowRight') { watchSeek(watchTime() + 5);  e.preventDefault(); return; }
    } catch {}
  });
}


function watchEnter(config) {
  state.watch = {
    active: true,
    mode: config.mode,
    inPage: !!config.inPage,
    mutedStart: !!config.mutedStart,
    singleShot: !!config.singleShot,
    list: config.list || [],
    mark: config.mark || null,
    onExit: config.onExit || null,
    currentVideoId: null,
    // Audio mode is sticky per browser. Never on a cast receiver or /tv — those
    // are screens someone is looking at, and the point of audio mode is not
    // looking at it.
    audio: config.audio != null
      ? !!config.audio
      : (localStorage.getItem('audioMode') === '1' && !castIsTv() && config.mode !== 'cast'),
  };
  $('watch-layout').classList.toggle('audio-mode', !!state.watch.audio);
  $('btn-watch-audio')?.classList.toggle('on', !!state.watch.audio);
  document.body.classList.add('route-watch');
  $('watch-layout').classList.remove('hidden');
  // Restore session theater preference — watchExit() always strips the class,
  // so re-apply it here when a new video/queue opens.
  $('watch-layout').classList.toggle('theater', sessionStorage.getItem('theaterPref') === '1');
  reconcileBackGuard();   // arm the mobile back-gesture guard for in-page overlays

  // On /tv every play starts fullscreen ("cover"), so the TV-remote overlay nav
  // (seek / reveal queue) applies just like a cast — see castKey() in cast.js.
  // /phone is the exception: it stays in the video+queue layout (queue below the
  // video on a narrow screen) instead of covering.
  if (castIsTv() && !castIsPhone()) {
    document.body.classList.add('cast-cover');
    watchRequestFullscreen();
  }

  if (config.badgeLabel) {
    $('watch-mode-badge').textContent = config.badgeLabel;
    $('watch-mode-badge').classList.remove('hidden');
  } else {
    $('watch-mode-badge').classList.add('hidden');
  }

  watchBindDom();
  if (typeof castSyncHereTransfer === 'function') castSyncHereTransfer();  // "📺 Transfer" visibility

  if (!state.watch.list.length) { watchExit(); return; }
  watchRenderQueue();
  const startId = config.startId && state.watch.list.find(v => v.video_id === config.startId)
    ? config.startId
    : state.watch.list[0].video_id;
  watchPlay(startId, config.startSeconds || 0);   // startSeconds: resume offset on transfer

  // A local "play here" on / becomes a discoverable screen so another instance
  // can remote-control, pull, or transfer it. No-ops for /tv, the /watch
  // receiver, and incoming casts (which already own the command channel).
  if (typeof castLocalScreenStart === 'function') castLocalScreenStart();
}


function watchExit() {
  if (!state.watch) return;
  const inPage = state.watch.inPage;
  const onExit = state.watch.onExit;
  state.watch = null;
  if (document.fullscreenElement) { try { document.exitFullscreen?.(); } catch {} }
  document.body.classList.remove('route-watch');
  document.body.classList.remove('cast-cover');   // clean up /tv + cast fullscreen
  if (typeof castNavReset === 'function') castNavReset();  // drop any overlay D-pad focus
  if (typeof castScrubEnd === 'function') castScrubEnd();  // drop any pending scrub
  if (typeof castLocalScreenStop === 'function') castLocalScreenStop();  // stop being a / screen
  $('watch-layout').classList.add('hidden');
  $('watch-layout').classList.remove('theater');
  $('watch-layout').classList.remove('audio-mode');
  $('watch-unmute').classList.add('hidden');
  // Release the audio stream too, or the proxy keeps feeding a dead session.
  const audioEl = document.getElementById('watch-audio');
  if (audioEl) { try { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } catch {} }
  // Tear the YT player fully down and swap in a fresh blank iframe. Reusing a
  // player after stopVideo() leaves the iframe off youtube.com, so the next
  // loadVideoById postMessage hits our own origin and silently fails to play.
  // A clean iframe forces watchPlay's create-from-scratch path on re-entry.
  watchResetFrame();
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch {}
  }
  if (onExit) {
    onExit();          // cast receiver: return to the idle screen, no redirect
  } else if (inPage) {
    render();
  } else {
    location.href = '/';
  }
  reconcileBackGuard();   // overlay gone — drop or hand the guard to the queue pane
  // Apply any hourly content refresh that arrived while we were bingeing on /tv.
  if (typeof tvFlushPendingRefresh === 'function') tvFlushPendingRefresh();
}


async function watchBootUrl(route) {
  let list = [];
  let mark = null;
  let badgeLabel = '';

  if (route.mode === 'queue' || route.mode === 'queue-test') {
    try {
      state.queue = await api.get('/api/queue');
    } catch (e) {
      alert('Failed to load queue: ' + e.message);
      location.href = '/';
      return;
    }
    list = shallowQueue().map(q => ({
      video_id: q.video_id, title: q.title,
      channel_name: q.channel_name, thumbnail_url: q.thumbnail_url,
      duration: q.duration,
    }));
    mark = route.mode === 'queue-test' ? null : async (id) => {
      await api.post(`/api/queue/${id}/watched`);
      state.queue = state.queue.filter(q => q.video_id !== id);
      setInQueue(id, false);
    };
    badgeLabel = route.mode === 'queue-test' ? 'TEST' : '';
  } else if (route.mode === 'folder') {
    const raw = sessionStorage.getItem('tempWatch');
    sessionStorage.removeItem('tempWatch');
    if (!raw) { location.href = '/'; return; }
    let data;
    try { data = JSON.parse(raw); } catch { location.href = '/'; return; }
    list = Array.isArray(data.videos) ? data.videos : [];
    badgeLabel = data.folderName ? `📁 ${data.folderName}` : '';
    mark = async (id) => { await api.post(`/api/videos/${id}/read`); };
  }

  if (!list.length) { location.href = '/'; return; }
  watchEnter({ mode: route.mode, inPage: false, mutedStart: true, list, mark, badgeLabel });
}
