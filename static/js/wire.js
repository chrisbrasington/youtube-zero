'use strict';

/*
 * Header + settings panel imperative wiring + EventSource client.
 *
 * Classic script, loaded after app.js so action functions (addChannel,
 * createFolder, refreshAll, ...) are in scope. This file does only
 * one thing per element: bind the DOM listener.
 *
 * Also defines connectEventSource() and signalToast() used by the
 * boot IIFE.
 */


// ── Player controls ──────────────────────────────────────────────────────────

$('btn-player-close').addEventListener('click', closePlayer);
$('btn-player-theater').addEventListener('click', () => {
  player.mode = player.mode === 'theater' ? 'normal' : 'theater';
  renderPlayer();
});
$('btn-player-fullscreen').addEventListener('click', () => {
  $('player-frame').requestFullscreen?.().catch(() => {});
});
$('btn-player-watched').addEventListener('click', playerMarkWatched);


// ── Header: add / refresh / queue / clear / sort / settings ──────────────────

$('btn-add-channel').addEventListener('click', addChannel);
$('channel-input').addEventListener('keydown', e => { if (e.key === 'Enter') addChannel(); });
$('channel-input').addEventListener('paste', e => {
  const text = e.clipboardData.getData('text');
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    e.preventDefault();
    addChannels(lines);
  }
});
$('btn-new-folder').addEventListener('click', createFolder);
$('btn-refresh-all').addEventListener('click', refreshAll);
$('btn-random').addEventListener('click', randomPlay);
$('btn-clear-all').addEventListener('click', clearAll);
$('btn-sort').addEventListener('click', () => {
  state.sortMode = state.sortMode === 'manual' ? 'newest' : 'manual';
  render();
});
$('btn-queue').addEventListener('click', () => {
  state.queueOpen = !state.queueOpen;
  localStorage.setItem('queueOpen', state.queueOpen ? '1' : '0');
  $('queue-pane').classList.toggle('hidden', !state.queueOpen);
  renderQueueBadge();
});
$('btn-close-queue').addEventListener('click', () => {
  state.queueOpen = false;
  localStorage.setItem('queueOpen', '0');
  $('queue-pane').classList.add('hidden');
  renderQueueBadge();
});
$('btn-settings').addEventListener('click', () => {
  $('settings-panel').classList.toggle('hidden');
});
$('btn-history').addEventListener('click', () => { location.href = '/history'; });


// ── Settings panel ───────────────────────────────────────────────────────────

$('btn-save-key').addEventListener('click', saveApiKey);
$('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });
$('btn-signal-link').addEventListener('click', linkSignal);
$('btn-signal-remove').addEventListener('click', removeSignal);
$('btn-signal-queue').addEventListener('click', signalSendQueue);
$('btn-clear-queue').addEventListener('click', () => clearQueue(false));
$('btn-watch-queue').addEventListener('click', () => castIsTv() ? watchStartQueue() : castOrWatchQueue());
$('btn-cast').addEventListener('click', () => castOpenRemote());
$('btn-watch-transfer').addEventListener('click', () => castTransferLocal());
$('signal-number-input').addEventListener('keydown', e => { if (e.key === 'Enter') linkSignal(); });
$('btn-tv-save').addEventListener('click', saveTvSettings);
$('btn-tv-connect').addEventListener('click', tvConnect);
$('btn-tv-test').addEventListener('click', tvTest);
$('tv-ip-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveTvSettings(); });
$('hide-shorts-check').addEventListener('change', async () => {
  state.hideShorts = $('hide-shorts-check').checked;
  localStorage.setItem('hideShorts', state.hideShorts ? '1' : '0');
  render();
  api.post('/api/settings/hide-shorts', { hide_shorts: state.hideShorts })
    .catch(e => console.warn('hide-shorts save failed:', e));
});

function applyWrapStrip() {
  document.body.classList.toggle('wrap-strip', state.wrapStrip);
}
$('wrap-strip-check').checked = state.wrapStrip;
applyWrapStrip();
$('wrap-strip-check').addEventListener('change', () => {
  state.wrapStrip = $('wrap-strip-check').checked;
  localStorage.setItem('wrapStrip', state.wrapStrip ? '1' : '0');
  applyWrapStrip();
});

$('force-mobile-check').checked = state.forceMobile;
syncMobileUI();
matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).addEventListener('change', syncMobileUI);
matchMedia('(max-width: 900px)').addEventListener('change', syncMobileUI);
matchMedia('(orientation: landscape)').addEventListener('change', syncMobileUI);
$('force-mobile-check').addEventListener('change', () => {
  state.forceMobile = $('force-mobile-check').checked;
  localStorage.setItem('forceMobile', state.forceMobile ? '1' : '0');
  syncMobileUI();
});


// ── Cache buster (settings panel) ────────────────────────────────────────────

async function clearBrowserCache() {
  const st = $('clear-cache-status');
  st.textContent = 'Clearing…';
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    }
  } catch {}
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch {}
  try {
    await Promise.all([
      fetch('/',                  { cache: 'reload' }),
      fetch('/static/js/boot.js', { cache: 'reload' }),
      fetch('/static/style.css',  { cache: 'reload' }),
    ]);
  } catch {}
  const u = new URL(location.href);
  u.searchParams.set('_cb', Date.now());
  location.replace(u.toString());
}
$('btn-clear-cache').addEventListener('click', clearBrowserCache);


// ── EventSource client (refresh + signal-cmd toasts) ─────────────────────────

let signalToastTimer = null;
function signalToast(text) {
  status(text, 'signal');
  clearTimeout(signalToastTimer);
  signalToastTimer = setTimeout(() => status(''), 4000);
}

function connectEventSource() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'refreshed') loadAll();
      else if (msg.type === 'refresh_start') {
        $('refresh-label').textContent = `↻ 0/${msg.total}`;
        setRefreshProgress(0.001);
      }
      else if (msg.type === 'refresh_progress') {
        $('refresh-label').textContent = `↻ ${msg.i}/${msg.total} ${msg.name}`;
        setRefreshProgress(msg.i / msg.total);
      }
      else if (msg.type === 'refresh_done') {
        $('refresh-label').innerHTML = '↻<span class="btn-label"> Refresh All</span>';
        setRefreshProgress(0);
        updateQuota();
      }
      else if (msg.type === 'signal_cmd') {
        if (msg.phase === 'received') signalToast(`signal: ${msg.cmd} received`);
        else if (msg.phase === 'done') signalToast(`signal: ${msg.cmd} response sent ✓`);
      }
      else if (msg.type === 'screen_online' || msg.type === 'screen_offline' || msg.type === 'screen_status') {
        castOnScreenEvent(msg);
      }
    } catch (_) {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEventSource, 5000);
  };
}
