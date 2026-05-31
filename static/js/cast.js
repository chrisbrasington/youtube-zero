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
  $('watch-layout').classList.add('hidden');
  $('cast-idle').classList.remove('hidden');
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
      if (document.body.classList.contains('route-cast') && !castReceiverES) {
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
      try {
        if (castCcOn) { watchPlayer?.loadModule?.('captions'); watchPlayer?.loadModule?.('cc'); }
        else { watchPlayer?.unloadModule?.('captions'); watchPlayer?.unloadModule?.('cc'); }
      } catch {}
      break;
  }
}


// Remote fullscreen. The OS Fullscreen API can't be *entered* without a gesture
// on the screen itself, so a network command can't reliably use it. Instead we
// toggle a CSS "cover" mode that fills the viewport with the video (always
// works), and *also* attempt real fullscreen as a bonus for TV/kiosk browsers
// that allow it.
function castToggleCover() {
  const on = document.body.classList.toggle('cast-cover');
  if (on) {
    watchRequestFullscreen();
  } else if (document.fullscreenElement) {
    try { document.exitFullscreen?.(); } catch {}
  }
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
}


// ── Remote: choosing a destination / screen ──────────────────────────────────

let castPickResolve = null;

function castShowPick(title, options) {
  return new Promise(resolve => {
    castPickResolve = resolve;
    const el = $('cast-pick');
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
async function castPickScreen() {
  if (castScreens.length === 0) return null;
  if (castScreens.length === 1) return castScreens[0].id;
  const choice = await castShowPick('Which screen?',
    castScreens.map(s => ({ label: '📺 ' + (s.name || 'Screen'), value: s.id })));
  return choice || null;
}


// ── Remote: entry points (single video / queue / folder) ─────────────────────

async function castSingleVideo(video) {
  const sid = await castPickScreen();
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
}

function castCloseRemote() {
  $('cast-remote').classList.add('hidden');
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

  const nowPlaying = cur ? `
    <div class="cast-now">
      <img class="cast-now-thumb" src="${escAttr(castRemoteThumb(cur))}" alt=""
           onerror="this.style.visibility='hidden'">
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
  const pick = e.target.closest('[data-cast-pick]');
  if (pick) { castResolvePick(pick.dataset.castPick || null); return; }
  if (e.target.closest('[data-action="cast-pick-backdrop"]') === e.target) { castResolvePick(null); return; }

  if (e.target.closest('[data-cast-close]')) { castCloseRemote(); return; }
  const ctl = e.target.closest('[data-cast-ctl]');
  if (ctl) { castSendCommand(ctl.dataset.castCtl); return; }
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
