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


function watchStartFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  const vids = folderMixedStrip(folder).filter(v => !isShort(v, v._channel));
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
  safe('play',          () => { try { watchPlayer?.playVideo();  } catch {} });
  safe('pause',         () => { try { watchPlayer?.pauseVideo(); } catch {} });
  safe('nexttrack',     () => watchAdvance({ fromEnd: true }));
  safe('previoustrack', () => watchPrev());
  safe('seekbackward',  (d) => { try { watchPlayer?.seekTo((watchPlayer.getCurrentTime?.() || 0) - (d?.seekOffset || 10), true); } catch {} });
  safe('seekforward',   (d) => { try { watchPlayer?.seekTo((watchPlayer.getCurrentTime?.() || 0) + (d?.seekOffset || 10), true); } catch {} });
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


function watchPlay(videoId) {
  state.watch.currentVideoId = videoId;
  const item = (state.watch.list || []).find(v => v.video_id === videoId);
  // Record "started watching" so the video lands in history even if never finished.
  if (videoId) {
    api.post(`/api/videos/${videoId}/played`, item
      ? { title: item.title, channel_name: item.channel_name, thumbnail_url: item.thumbnail_url }
      : {}).catch(() => {});
  }
  $('watch-title').textContent = item ? item.title : '';
  $('watch-yt-link').href = `https://www.youtube.com/watch?v=${videoId}`;
  if (watchPlayer && watchPlayer.loadVideoById) {
    watchPlayer.loadVideoById(videoId);
  } else {
    const origin = encodeURIComponent(location.origin);
    const mute   = state.watch.mutedStart ? '&mute=1' : '';
    const frame  = $('watch-frame');
    frame.src = `https://www.youtube.com/embed/${videoId}?autoplay=1${mute}&rel=0&enablejsapi=1&origin=${origin}`;
    frame.addEventListener('load', () => {
      watchSetupYT();
      if (state.watch?.mutedStart) watchArmUnmute();
    }, { once: true });
  }
  watchRenderQueue();
  watchUpdateMediaSession();
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
      $('watch-layout').classList.toggle('theater');
      return;
    }
    if (!watchPlayer) return;
    try {
      if (/^[0-9]$/.test(e.key)) {
        const pct = parseInt(e.key, 10) / 10;
        const dur = watchPlayer.getDuration?.();
        if (dur) watchPlayer.seekTo(dur * pct, true);
        e.preventDefault();
        return;
      }
      if (e.key === ' ' || e.key === 'k') {
        const st = watchPlayer.getPlayerState?.();
        if (st === 1) watchPlayer.pauseVideo(); else watchPlayer.playVideo();
        e.preventDefault();
        return;
      }
      if (e.key === 'j')          { watchPlayer.seekTo((watchPlayer.getCurrentTime?.() || 0) - 10, true); e.preventDefault(); return; }
      if (e.key === 'l')          { watchPlayer.seekTo((watchPlayer.getCurrentTime?.() || 0) + 10, true); e.preventDefault(); return; }
      if (e.key === 'ArrowLeft')  { watchPlayer.seekTo((watchPlayer.getCurrentTime?.() || 0) - 5,  true); e.preventDefault(); return; }
      if (e.key === 'ArrowRight') { watchPlayer.seekTo((watchPlayer.getCurrentTime?.() || 0) + 5,  true); e.preventDefault(); return; }
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
  };
  document.body.classList.add('route-watch');
  $('watch-layout').classList.remove('hidden');

  if (config.badgeLabel) {
    $('watch-mode-badge').textContent = config.badgeLabel;
    $('watch-mode-badge').classList.remove('hidden');
  } else {
    $('watch-mode-badge').classList.add('hidden');
  }

  watchBindDom();

  if (!state.watch.list.length) { watchExit(); return; }
  watchRenderQueue();
  const startId = config.startId && state.watch.list.find(v => v.video_id === config.startId)
    ? config.startId
    : state.watch.list[0].video_id;
  watchPlay(startId);
}


function watchExit() {
  if (!state.watch) return;
  const inPage = state.watch.inPage;
  const onExit = state.watch.onExit;
  state.watch = null;
  if (document.fullscreenElement) { try { document.exitFullscreen?.(); } catch {} }
  document.body.classList.remove('route-watch');
  $('watch-layout').classList.add('hidden');
  $('watch-layout').classList.remove('theater');
  $('watch-unmute').classList.add('hidden');
  try { watchPlayer?.stopVideo?.(); } catch {}
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
