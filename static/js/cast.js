'use strict';

/*
 * Cast — turn a /watch device into a "screen" and drive it from a phone.
 *
 * Classic script. Two cooperating halves share this file:
 *
 *   RECEIVER (runs on /watch) — registers a stable screen id, idles showing
 *   "ready to receive", and on a `play` command hands straight into the
 *   existing watchEnter()/watchPlay() lifecycle in watch.js. Live commands
 *   (pause/next/jump/…) map onto the same player functions. Playback state is
 *   polled and reported back so remotes stay in sync.
 *
 *   REMOTE (runs on /) — discovers connected screens via GET /api/cast/screens
 *   plus screen_* events on the global SSE stream, casts a single video or a
 *   queue/folder playlist, then shows a control panel that POSTs commands.
 *
 * Depends on globals from watch.js (watchEnter, watchPlay, watchAdvance,
 * watchPrev, watchExit, watchPlayer), state.js (state), dom.js ($, esc,
 * escAttr, status), api.js (api), and shallowQueue / findFolder /
 * folderMixedStrip / isShort defined elsewhere — all resolved at call time.
 */


// ── Shared screen identity (receiver) ────────────────────────────────────────

let castScreenId = null;
let castUserActivated = false;   // has a gesture happened on this screen tab?
let castReceiverES = null;
let castStatusTimer = null;
let castLastStatusKey = '';
let castCcOn = false;            // captions toggle (YT API has no getter — we track it)

// Kiosk mode (set via ?kiosk=1, e.g. the Android WebView wrapper): the host has
// already allowed autoplay-with-sound, so start unmuted and skip the tap hint.
const castKiosk = (() => {
  try { return new URLSearchParams(location.search).has('kiosk'); } catch { return false; }
})();


function castGetScreenId() {
  let id = localStorage.getItem('castScreenId');
  if (!id) {
    id = (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'scr-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('castScreenId', id);
  }
  return id;
}

function castGetScreenName() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('name');
    if (fromUrl) { localStorage.setItem('castScreenName', fromUrl); return fromUrl; }
  } catch {}
  return localStorage.getItem('castScreenName') || ('Screen ' + castGetScreenId().slice(0, 4));
}


// ── Receiver: idle screen ────────────────────────────────────────────────────

function castReceiverEnter() {
  castScreenId = castGetScreenId();
  document.body.classList.add('route-cast');
  castRenderIdle();
  $('cast-idle').classList.remove('hidden');
  castConnectReceiver();
  castStatusTimer = setInterval(castPollStatus, 1000);
}


let castIdleBound = false;
function castRenderIdle() {
  const el = $('cast-idle');
  el.innerHTML = `
    <div class="cast-idle-inner">
      <div class="cast-idle-icon">📺</div>
      <input id="cast-name-input" class="cast-name-input" value="${escAttr(castGetScreenName())}"
             autocomplete="off" spellcheck="false" aria-label="Screen name">
      <div class="cast-idle-status">Ready to receive</div>
      <div id="cast-idle-hint" class="cast-idle-hint${castKiosk ? ' hidden' : ''}">Tap anywhere to enable sound</div>
    </div>`;

  if (castIdleBound) return;
  castIdleBound = true;

  // Any gesture grants this document the sticky activation YouTube needs to
  // autoplay with audio on later (programmatic) plays.
  el.addEventListener('click', () => {
    castUserActivated = true;
    $('cast-idle-hint')?.classList.add('hidden');
  });

  el.addEventListener('change', e => {
    const input = e.target.closest('#cast-name-input');
    if (!input) return;
    castRename(input.value.trim());
  });
}


function castRename(name) {
  const clean = (name || '').slice(0, 40) || ('Screen ' + castGetScreenId().slice(0, 4));
  localStorage.setItem('castScreenName', clean);
  // Reconnect so the server (and remotes) pick up the new name.
  if (castReceiverES) { castReceiverES.close(); castReceiverES = null; }
  castConnectReceiver();
}


function castReturnToIdle() {
  document.body.classList.remove('cast-cover');
  castNavReset();
  $('watch-layout').classList.add('hidden');
  if (castIsTv()) {
    render();           // /tv: back to the browse feed, not a blank idle screen
  } else {
    $('cast-idle').classList.remove('hidden');
  }
  castLastStatusKey = '';   // force an idle status on the next poll
}


// ── Receiver: command channel ────────────────────────────────────────────────

function castConnectReceiver() {
  const url = `/api/cast/stream/${encodeURIComponent(castScreenId)}`
            + `?name=${encodeURIComponent(castGetScreenName())}`;
  const es = new EventSource(url);
  castReceiverES = es;
  es.onmessage = (e) => {
    if (e.data === 'connected') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'play') castOnPlayCommand(msg);
    else if (msg.type === 'command') castOnCommand(msg);
  };
  es.onerror = () => {
    es.close();
    if (castReceiverES === es) castReceiverES = null;
    setTimeout(() => {
      const stillReceiving = document.body.classList.contains('route-cast') || castIsTv();
      if (stillReceiving && !castReceiverES) {
        castConnectReceiver();
      }
    }, 3000);
  };
}


function castOnPlayCommand(payload) {
  const list = (payload.videos || []).map(v => ({
    video_id: v.video_id, title: v.title,
    channel_name: v.channel_name, thumbnail_url: v.thumbnail_url,
    duration: v.duration,
  }));
  if (!list.length) return;
  $('cast-idle').classList.add('hidden');
  document.body.classList.add('cast-cover');   // start filling the screen
  castNavReset();                              // fresh play → no leftover focus cursor
  watchEnter({
    mode: 'cast',
    inPage: true,
    mutedStart: !(castUserActivated || castKiosk),   // kiosk/gesture → unmuted; else muted (+ banner)
    list,
    startId: payload.start_id || null,
    mark: castMakeMark(payload.mark_mode),
    onExit: castReturnToIdle,
  });
  watchRequestFullscreen();   // best-effort real fullscreen (TV/kiosk); harmless if blocked
}


function castMakeMark(mode) {
  if (mode === 'none') return null;
  const url = (id) => mode === 'read' ? `/api/videos/${id}/read` : `/api/queue/${id}/watched`;
  return async (id) => { try { await api.post(url(id)); } catch {} };
}


function castOnCommand(msg) {
  switch (msg.action) {
    case 'pause':     try { watchPlayer?.pauseVideo?.(); } catch {} break;
    case 'resume':    try { watchPlayer?.playVideo?.();  } catch {} break;
    case 'next':      watchAdvance({ fromEnd: false }); break;
    case 'mark_next': watchAdvance({ fromEnd: true });  break;
    case 'prev':      watchPrev(); break;
    case 'jump':      if (msg.video_id && state.watch?.active) watchPlay(msg.video_id); break;
    case 'stop':      watchExit(); break;
    case 'seek':
      if (typeof msg.value === 'number' && state.watch?.active) {
        try { watchPlayer?.seekTo?.(msg.value, true); } catch {}
      }
      break;
    case 'fullscreen': castToggleCover(); break;
    case 'cc':
      castCcOn = !castCcOn;
      castSetCaptions(castCcOn);
      break;
  }
}


// Toggle captions on the receiver's player. The IFrame API's caption controls
// are undocumented and version-dependent: the module is named 'captions' on the
// legacy player and 'cc' on the HTML5 one, and turning captions ON requires
// actually selecting a *track* — loading the module alone shows nothing. The
// tracklist isn't populated the instant the module loads (and not at all until
// the video has begun), so when no track is ready yet we retry briefly.
function castSetCaptions(on, attempt = 0) {
  const p = watchPlayer;
  if (!p || !p.loadModule) return;
  const MODULES = ['captions', 'cc'];
  try {
    if (!on) {
      MODULES.forEach(m => { try { p.setOption(m, 'track', {}); } catch {} });
      MODULES.forEach(m => { try { p.unloadModule(m); } catch {} });
      return;
    }
    MODULES.forEach(m => { try { p.loadModule(m); } catch {} });
    // Pick a track to display — prefer English, else the first available.
    let track = null, mod = null;
    for (const m of MODULES) {
      let list = null;
      try { list = p.getOption(m, 'tracklist'); } catch {}
      if (list && list.length) {
        track = list.find(t => /^en/i.test(t.languageCode || '')) || list[0];
        mod = m;
        break;
      }
    }
    if (track && mod) {
      try { p.setOption(mod, 'track', track); } catch {}
    } else if (attempt < 10 && castCcOn) {
      // Tracklist not ready yet — retry while the toggle is still on.
      setTimeout(() => castSetCaptions(true, attempt + 1), 300);
    }
  } catch {}
}


// Remote fullscreen. The OS Fullscreen API can't be *entered* without a gesture
// on the screen itself, so a network command can't reliably use it. Instead we
// toggle a CSS "cover" mode that fills the viewport with the video (always
// works), and *also* attempt real fullscreen as a bonus for TV/kiosk browsers
// that allow it.
function castSetCover(on) {
  const wasOn = document.body.classList.contains('cast-cover');
  document.body.classList.toggle('cast-cover', on);
  if (on) {
    castNavReset();             // cover ON = watching; no on-screen focus cursor
    watchRequestFullscreen();
  } else if (wasOn && document.fullscreenElement) {
    try { document.exitFullscreen?.(); } catch {}
  }
}

function castToggleCover() {
  castSetCover(!document.body.classList.contains('cast-cover'));
}


// ── Receiver: TV-remote D-pad navigation ─────────────────────────────────────
//
// On a TV (the android-screen APK) the remote's D-pad is forwarded here as
// castKey() — the APK consumes the keys so the focused YouTube iframe can't.
// Two modes, keyed off body.cast-cover:
//   • cover ON  = watching:   ←/→ seek, OK play/pause, ↑/↓ reveal the queue UI.
//   • cover OFF = navigating:  a focus cursor walks a vertical ring
//        index 0      → header buttons (←/→ pick which)
//        index 1      → the video panel
//        index 2..n+1 → up-next queue items
//     ↑/↓ move the cursor; OK activates; ↑ at the top returns to fullscreen.

const CAST_HEADER_BTNS = ['btn-watch-skip', 'btn-watch-skip-mark',
                          'btn-watch-fullscreen', 'btn-watch-exit'];
const CAST_SEEK_STEP = 5;   // seconds per ←/→ nudge (matches the old arrow seek)

let castNav = { active: false, index: 0, col: 0 };


function castIsReceiver() {
  return !!(state.watch && state.watch.active && state.watch.mode === 'cast');
}

// /tv is the cast receiver fused with the browse feed (see tv.js).
function castIsTv() {
  return document.body.classList.contains('route-tv');
}

// Whether the player overlay D-pad nav should drive playback. True for a pure
// cast receiver and for any playback launched from /tv (single/queue/folder).
function castNavEligible() {
  return castIsReceiver() || castIsTv();
}

function castNavReset() {
  castNav.active = false;
  document.querySelectorAll('.dpad-focus').forEach(el => el.classList.remove('dpad-focus'));
}

function castSeek(delta) {
  if (!watchPlayer) return;
  try {
    const t = (watchPlayer.getCurrentTime?.() || 0) + delta;
    watchPlayer.seekTo(Math.max(0, t), true);
  } catch {}
}


// Invoked by the APK on the remote's BACK button. If a player overlay is open,
// close it — returning to the browse page on /tv, or the idle screen on /watch
// (same as the close/exit control) — and report handled. Otherwise return false
// so the app handles Back itself (exits).
function castBack() {
  if (state.watch?.active) { watchExit(); return true; }
  return false;
}


// Entry point invoked by the APK for each D-pad direction ('up'|'down'|'left'|'right').
function castKey(name) {
  // A player overlay is open → drive playback (cast receiver, or /tv playback).
  if (state.watch?.active && castNavEligible()) {
    if (document.body.classList.contains('cast-cover')) {
      // Watching mode.
      if (name === 'left')  return castSeek(-CAST_SEEK_STEP);
      if (name === 'right') return castSeek(CAST_SEEK_STEP);
      if (name === 'up' || name === 'down') return castNavEnter(name);
      if (name === 'ok')    return castTogglePlay();
      return;
    }
    // Nav mode (in-overlay focus ring).
    if (name === 'up' || name === 'down') return castNavMove(name);
    if (name === 'left' || name === 'right') {
      if (castNav.active && castNav.index === 0) return castNavCol(name);
      return castSeek(name === 'left' ? -CAST_SEEK_STEP : CAST_SEEK_STEP);
    }
    if (name === 'ok') return castNavSelect();
    return;
  }
  // No overlay, on /tv → drive the browse-feed focus grid (see tv.js).
  if (castIsTv()) tvBrowseKey(name);
}


// Highest valid ring index: 0 header, 1 video, 2..(1+len) queue items.
function castNavMax() {
  return 1 + (state.watch?.list || []).length;
}

function castNavEnter(dir) {
  castSetCover(false);
  castNav.active = true;
  castNav.col = 0;
  castNav.index = dir === 'up' ? 0 : 1;   // up → header, down → video panel
  castNavRender();
}

function castNavMove(dir) {
  if (!castNav.active) return castNavEnter(dir);
  if (dir === 'up') {
    if (castNav.index === 0) return castSetCover(true);   // up past the top → fullscreen
    castNav.index -= 1;
  } else {
    castNav.index = Math.min(castNav.index + 1, castNavMax());
  }
  castNavRender();
}

function castNavCol(dir) {
  const n = CAST_HEADER_BTNS.length;
  castNav.col = dir === 'left' ? Math.max(0, castNav.col - 1)
                               : Math.min(n - 1, castNav.col + 1);
  castNavRender();
}

function castNavTarget() {
  if (castNav.index === 0) return $(CAST_HEADER_BTNS[castNav.col]);
  if (castNav.index === 1) return $('watch-frame-wrap');
  const items = $('watch-queue-list').querySelectorAll('[data-watch-play]');
  return items[castNav.index - 2] || null;
}

function castNavRender() {
  document.querySelectorAll('.dpad-focus').forEach(el => el.classList.remove('dpad-focus'));
  if (!castNav.active) return;
  const el = castNavTarget();
  if (!el) return;
  el.classList.add('dpad-focus');
  if (castNav.index >= 2) el.scrollIntoView({ block: 'nearest' });
}

function castNavSelect() {
  if (!castNav.active) return;
  if (castNav.index === 0) { castNavTarget()?.click(); return; }   // header button
  if (castNav.index === 1) { castSetCover(true); return; }         // video → fullscreen
  const id = castNavTarget()?.dataset?.videoId;                    // queue item → jump
  if (id) {
    if (id !== state.watch?.currentVideoId) watchPlay(id);
    castSetCover(true);   // jump + go fullscreen
  }
}

// Called from watchRenderQueue() after the up-next list rebuilds (the new HTML
// dropped the focus ring). Clamp into range in case the list shrank, then redraw.
function castNavReRender() {
  if (!castNav.active) return;
  castNav.index = Math.min(castNav.index, castNavMax());
  castNavRender();
}


// Called by the Android wrapper when the remote's center/OK (or a media-play-pause
// key) is pressed. In nav mode it activates the focused element; otherwise it
// toggles the receiver's player with a single tap.
function castTogglePlay() {
  if (castNav.active) { castNavSelect(); return; }                 // player overlay focus ring
  if (castIsTv() && !state.watch?.active) { tvBrowseKey('ok'); return; }  // browse grid
  if (!state.watch?.active || !watchPlayer) return;
  try {
    const st = watchPlayer.getPlayerState?.();
    if (st === 1) watchPlayer.pauseVideo();   // 1 = PLAYING
    else watchPlayer.playVideo();
  } catch {}
}


function castPollStatus() {
  if (!castScreenId) return;
  let vid = null, ps = null, idx = 0, count = 0, title = '', cur = 0, dur = 0;
  if (state.watch?.active) {
    vid = state.watch.currentVideoId;
    const list = state.watch.list || [];
    count = list.length;
    idx = Math.max(0, list.findIndex(v => v.video_id === vid));
    const item = list.find(v => v.video_id === vid);
    title = item ? item.title : '';
    try {
      ps  = watchPlayer?.getPlayerState?.();
      cur = watchPlayer?.getCurrentTime?.() || 0;
      dur = watchPlayer?.getDuration?.()    || 0;
    } catch {}
  }
  // current_time advances every tick while playing — that's intended so the
  // remote's seek bar tracks live (≈1 POST/sec). Paused → time frozen → no POST.
  const key = `${vid}|${ps}|${idx}|${count}|${Math.floor(cur)}|${Math.floor(dur)}`;
  if (key === castLastStatusKey) return;
  castLastStatusKey = key;
  api.post(`/api/cast/${castScreenId}/status`, {
    video_id: vid, title, player_state: ps, index: idx, count,
    current_time: cur, duration: dur,
  }).catch(() => {});
}


// ── Remote: screen discovery ─────────────────────────────────────────────────

let castScreens = [];          // [{id, name, status}]
let castActiveScreen = null;   // screen id the remote is currently driving


function castAvailable() { return castScreens.length > 0; }


async function castRefreshScreens() {
  try { castScreens = await api.get('/api/cast/screens'); }
  catch { castScreens = []; }
  castUpdateUI();
}


// Fed from connectEventSource() in wire.js when a screen_* event arrives.
function castOnScreenEvent(msg) {
  if (msg.type === 'screen_online') {
    if (!castScreens.some(s => s.id === msg.screen_id)) {
      castScreens.push({ id: msg.screen_id, name: msg.name, status: null });
    }
  } else if (msg.type === 'screen_offline') {
    castScreens = castScreens.filter(s => s.id !== msg.screen_id);
    if (castActiveScreen === msg.screen_id) {
      castActiveScreen = null;
      castCloseRemote();
      status('Screen disconnected', 'err');
      setTimeout(() => status(''), 2500);
    }
  } else if (msg.type === 'screen_status') {
    const s = castScreens.find(x => x.id === msg.screen_id);
    if (s) s.status = msg.status;
    else castScreens.push({ id: msg.screen_id, name: msg.status?.name || 'Screen', status: msg.status });
    if (castActiveScreen === msg.screen_id && !$('cast-remote').classList.contains('hidden')) {
      castRenderRemote(false);
    }
  }
  castUpdateUI();
}


function castUpdateUI() {
  const btn = $('btn-cast');
  if (btn) btn.classList.toggle('hidden', !castAvailable());
  castRenderResumeBar();
}


// Connected screens that are actively playing something (status carries a
// current video). Empty when every screen is idle.
function castWatchingScreens() {
  return castScreens.filter(s => s.status && s.status.video_id);
}


// Top-of-page prompt on the main remote (/) when screen(s) are mid-playback:
// one row per playing screen; tapping opens the full remote panel (thumbnail,
// seek, controls, queue) and takes over that screen. Hidden on the
// receiver/other routes and while the remote panel is already open.
// Re-evaluated on every screen discovery/status event.
function castRenderResumeBar() {
  const bar = $('cast-resume');
  if (!bar) return;
  const onMainPage = !['route-tv', 'route-cast', 'route-watch', 'route-history']
    .some(c => document.body.classList.contains(c));
  const remoteOpen = !$('cast-remote').classList.contains('hidden');
  const screens = (onMainPage && !remoteOpen) ? castWatchingScreens() : [];
  if (!screens.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.innerHTML = screens.map(s => `
    <button class="cast-resume-item" data-action="cast-resume" data-screen-id="${escAttr(s.id)}"
            title="Resume control of ${escAttr(s.name || 'screen')}">
      <img class="cast-resume-thumb" src="https://i.ytimg.com/vi/${escAttr(s.status.video_id)}/mqdefault.jpg" alt="">
      <span class="cast-resume-text">
        <span class="cast-resume-now">📺 ${esc(s.name || 'Screen')} is watching</span>
        <span class="cast-resume-title">${esc(s.status.title || '')}</span>
      </span>
      <span class="cast-resume-cta">▶ Resume control</span>
    </button>`).join('');
  bar.classList.remove('hidden');
}


// Take over a playing screen from this browser — opens the populated remote.
function castResumeControl(screenId) {
  if (!screenId) return;
  castActiveScreen = screenId;
  castOpenRemote();
}


// ── Remote: choosing a destination / screen ──────────────────────────────────

let castPickResolve = null;

function castShowPick(title, options, thumb = null) {
  return new Promise(resolve => {
    castPickResolve = resolve;
    const el = $('cast-pick');
    const img = el.querySelector('.cast-pick-thumb');
    if (img) {
      if (thumb) { img.src = thumb; img.classList.remove('hidden'); }
      else { img.removeAttribute('src'); img.classList.add('hidden'); }
    }
    el.querySelector('.cast-pick-title').textContent = title;
    el.querySelector('.cast-pick-options').innerHTML = options.map(o =>
      `<button class="sheet-btn" data-cast-pick="${escAttr(String(o.value))}">${esc(o.label)}</button>`
    ).join('');
    el.classList.remove('hidden');
  });
}

function castResolvePick(value) {
  $('cast-pick').classList.add('hidden');
  const r = castPickResolve;
  castPickResolve = null;
  if (r) r(value);
}


// Returns a screen id (auto when there's exactly one), or null if cancelled.
// `thumb` (optional) shows a large preview of what's being cast in the picker.
async function castPickScreen(thumb = null) {
  if (castScreens.length === 0) return null;
  if (castScreens.length === 1) return castScreens[0].id;
  const choice = await castShowPick('Which screen?',
    castScreens.map(s => ({ label: '📺 ' + (s.name || 'Screen'), value: s.id })), thumb);
  return choice || null;
}


// ── Remote: entry points (single video / queue / folder) ─────────────────────

async function castSingleVideo(video) {
  const thumb = video.video_id
    ? `https://i.ytimg.com/vi/${video.video_id}/hqdefault.jpg`
    : (video.thumbnail_url || null);
  const sid = await castPickScreen(thumb);
  if (!sid) return;
  castSendPlay(sid, [video], 'read');
}


async function castOrWatchQueue() {
  const list = shallowQueue().map(q => ({
    video_id: q.video_id, title: q.title,
    channel_name: q.channel_name, thumbnail_url: q.thumbnail_url, duration: q.duration,
  }));
  if (!list.length) { status('Queue empty', 'err'); setTimeout(() => status(''), 2000); return; }
  if (!castAvailable()) { watchStartQueue(); return; }
  const dest = await castShowPick('Play queue', [
    { label: '▶ Play Here', value: 'here' },
    { label: '📺 Play on Screen', value: 'screen' },
  ]);
  if (dest === 'here') { watchStartQueue(); return; }
  if (dest === 'screen') {
    const sid = await castPickScreen();
    if (sid) castSendPlay(sid, list, 'queue');
  }
}


async function castOrWatchFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  const vids = folderMixedStrip(folder).filter(v => !isShort(v, v._channel));
  if (!vids.length) { status('Folder has no videos to watch', 'err'); setTimeout(() => status(''), 2000); return; }
  if (!castAvailable()) { watchStartFolder(folderId); return; }
  const dest = await castShowPick(`Play 📁 ${folder.name}`, [
    { label: '▶ Play Here', value: 'here' },
    { label: '📺 Play on Screen', value: 'screen' },
  ]);
  if (dest === 'here') { watchStartFolder(folderId); return; }
  if (dest === 'screen') {
    const sid = await castPickScreen();
    if (!sid) return;
    const list = vids.map(v => ({
      video_id: v.video_id, title: v.title,
      channel_name: v._channel.name, thumbnail_url: v.thumbnail_url, duration: v.duration,
    }));
    castSendPlay(sid, list, 'read');
  }
}


// ── Remote: command transport ────────────────────────────────────────────────

async function castSendPlay(screenId, videos, markMode, startId = null) {
  try {
    await api.post(`/api/cast/${screenId}/play`, { videos, mark_mode: markMode, start_id: startId });
    castActiveScreen = screenId;
    castOpenRemote();
    status('Playing on screen ✓', 'ok'); setTimeout(() => status(''), 2000);
  } catch (e) {
    if (String(e.message).includes('not connected')) {
      status('Screen disconnected', 'err'); castRefreshScreens();
    } else {
      status('Cast error: ' + e.message, 'err');
    }
  }
}


async function castSendCommand(action, videoId = null, value = null) {
  if (!castActiveScreen) return;
  try {
    await api.post(`/api/cast/${castActiveScreen}/command`, { action, video_id: videoId, value });
  } catch (e) {
    if (String(e.message).includes('not connected')) {
      status('Screen disconnected', 'err');
      castActiveScreen = null;
      castCloseRemote();
      castRefreshScreens();
    }
  }
}


// ── Remote: control panel ────────────────────────────────────────────────────

function castOpenRemote() {
  if (!castActiveScreen) {
    castActiveScreen = castScreens[0] ? castScreens[0].id : null;
  }
  if (!castActiveScreen) return;
  $('cast-remote').classList.remove('hidden');
  castRenderRemote(true);
  castRenderResumeBar();   // panel now open → hide the resume prompt
}

function castCloseRemote() {
  $('cast-remote').classList.add('hidden');
  castRenderResumeBar();   // re-offer the prompt if the screen is still playing
}


function castRemoteThumb(v) {
  return (v && v.thumbnail_url) || (v ? `https://i.ytimg.com/vi/${v.video_id}/mqdefault.jpg` : '');
}


let castRemoteSig = '';      // structural signature — rebuild only when it changes
let castScrubbing = false;   // user is dragging the seek bar; ignore live ticks

// Rebuilds the panel structure only when the screen / current video / list
// changes; otherwise updates the dynamic bits (play-pause, time, seek) in place
// so a per-second status tick doesn't yank the slider out from under a finger.
function castRenderRemote(force) {
  const screen = castScreens.find(s => s.id === castActiveScreen);
  const st = screen?.status || {};
  const vids = st.videos || [];
  const curId = st.video_id;
  const sig = `${castActiveScreen}|${curId}|${vids.map(v => v.video_id).join(',')}`;
  if (force || sig !== castRemoteSig) {
    castRemoteSig = sig;
    castScrubbing = false;
    $('cast-remote').innerHTML = castRemoteHTML(screen, st, vids, curId);
  }
  castSyncRemote();
}


function castRemoteHTML(screen, st, vids, curId) {
  const cur = vids.find(v => v.video_id === curId)
            || (curId ? { video_id: curId, title: st.title || '' } : null);

  const bigThumb = cur && cur.video_id
    ? `https://i.ytimg.com/vi/${cur.video_id}/hqdefault.jpg`
    : (cur ? castRemoteThumb(cur) : '');
  const nowPlaying = cur ? `
    <div class="cast-now">
      <img class="cast-now-thumb" src="${escAttr(bigThumb)}" alt=""
           onerror="this.onerror=null;this.src='${escAttr(castRemoteThumb(cur))}'">
      <div class="cast-now-title">${esc(cur.title || '')}</div>
    </div>` : `
    <div class="cast-now cast-now-idle">Idle — nothing playing</div>`;

  const seekbar = curId ? `
    <div class="cast-seekbar">
      <span id="cast-time-cur" class="cast-time">0:00</span>
      <input id="cast-seek" class="cast-seek" type="range" min="0" max="0" value="0" step="1"
             data-cast-seek aria-label="Seek">
      <span id="cast-time-dur" class="cast-time">0:00</span>
    </div>` : '';

  const list = (curId && vids.length) ? `
    <div class="queue-list cast-remote-list">
      ${vids.map(v => `
        <div class="q-item ${v.video_id === curId ? 'playing' : ''}"
             data-cast-jump data-video-id="${escAttr(v.video_id)}">
          <div class="q-thumb-wrap">
            <img class="q-thumb" src="${escAttr(castRemoteThumb(v))}" alt=""
                 onerror="this.src='data:image/svg+xml,<svg/>'">
            ${v.duration ? `<span class="q-dur">${esc(v.duration)}</span>` : ''}
          </div>
          <div class="q-info">
            <div class="q-title">${esc(v.title || '')}</div>
            <div class="q-channel">${esc(v.channel_name || '')}</div>
          </div>
        </div>`).join('')}
    </div>` : '';

  return `
    <div class="cast-remote-box">
      <div class="cast-remote-header">
        <span class="cast-remote-name">📺 ${esc(screen?.name || 'Screen')}</span>
        <button class="btn-icon player-btn" data-cast-close title="Close remote">✕</button>
      </div>
      ${nowPlaying}
      <div class="cast-remote-controls">
        <button class="btn-icon player-btn" data-cast-ctl="prev" title="Previous">⏮</button>
        <button class="btn-icon player-btn cast-ctl-big" id="cast-playpause"
                data-cast-ctl="resume" title="Play">▶</button>
        <button class="btn-icon player-btn" data-cast-ctl="next" title="Skip">⏭</button>
        <button class="btn-icon player-btn" data-cast-ctl="mark_next" title="Mark watched &amp; skip">✓⏭</button>
        <button class="btn-icon player-btn cast-ctl-cc" data-cast-ctl="cc" title="Toggle captions">CC</button>
        <button class="btn-icon player-btn" data-cast-ctl="fullscreen" title="Toggle fullscreen on screen">⛶</button>
        <button class="btn-icon player-btn" data-cast-ctl="stop" title="Stop">⏹</button>
      </div>
      ${seekbar}
      ${list}
    </div>`;
}


function castSyncRemote() {
  const screen = castScreens.find(s => s.id === castActiveScreen);
  const st = screen?.status || {};
  const playing = st.player_state === 1;   // YT.PlayerState.PLAYING

  const pp = document.getElementById('cast-playpause');
  if (pp) {
    pp.dataset.castCtl = playing ? 'pause' : 'resume';
    pp.textContent = playing ? '⏸' : '▶';
    pp.title = playing ? 'Pause' : 'Play';
  }

  const dur = Math.floor(st.duration || 0);
  const cur = Math.floor(st.current_time || 0);
  const range = document.getElementById('cast-seek');
  if (range) {
    range.max = dur > 0 ? dur : 0;
    range.disabled = dur <= 0;
    if (!castScrubbing) range.value = Math.min(cur, dur || cur);
  }
  const shown = (castScrubbing && range) ? parseInt(range.value, 10) : cur;
  const curEl = document.getElementById('cast-time-cur');
  const durEl = document.getElementById('cast-time-dur');
  if (curEl) curEl.textContent = castFmtTime(shown);
  if (durEl) durEl.textContent = castFmtTime(dur);
}


function castFmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}


// Delegated clicks for the remote panel + the destination/screen chooser.
document.addEventListener('click', e => {
  const resume = e.target.closest('[data-action="cast-resume"]');
  if (resume) { castResumeControl(resume.dataset.screenId); return; }

  const pick = e.target.closest('[data-cast-pick]');
  if (pick) { castResolvePick(pick.dataset.castPick || null); return; }
  if (e.target.closest('[data-action="cast-pick-backdrop"]') === e.target) { castResolvePick(null); return; }

  if (e.target.closest('[data-cast-close]')) { castCloseRemote(); return; }
  const ctl = e.target.closest('[data-cast-ctl]');
  if (ctl) {
    const action = ctl.dataset.castCtl;
    castSendCommand(action);
    // Stop exits the screen entirely — nothing left to drive, so close the panel.
    if (action === 'stop') castCloseRemote();
    return;
  }
  const jump = e.target.closest('[data-cast-jump]');
  if (jump && jump.dataset.videoId) { castSendCommand('jump', jump.dataset.videoId); return; }
  if (e.target.closest('[data-action="cast-remote-backdrop"]') === e.target) { castCloseRemote(); return; }
});


// Seek bar: while dragging, hold off live ticks and preview the time; on release
// (change), seek the screen to the chosen second.
document.addEventListener('input', e => {
  const seek = e.target.closest('[data-cast-seek]');
  if (!seek) return;
  castScrubbing = true;
  const curEl = document.getElementById('cast-time-cur');
  if (curEl) curEl.textContent = castFmtTime(parseInt(seek.value, 10));
});
document.addEventListener('change', e => {
  const seek = e.target.closest('[data-cast-seek]');
  if (!seek) return;
  castScrubbing = false;
  castSendCommand('seek', null, parseInt(seek.value, 10));
});
