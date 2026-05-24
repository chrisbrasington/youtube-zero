'use strict';

/*
 * Feature-level wiring for quota, Signal, TV, and app settings.
 *
 * Classic script. Each section is self-contained and talks to its own
 * DOM nodes (looked up by id). Most functions mutate `state` to flip
 * configured flags, then call render() to refresh dependent UI.
 *
 * render() is defined in app.js but is resolved at call time via the
 * shared script scope, so the forward reference is fine.
 */


// ── Quota display ────────────────────────────────────────────────────────────

function formatLastChecked(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `Last checked: ${h}:${String(m).padStart(2, '0')} ${ap}`;
}


async function updateQuota() {
  try {
    const q = await api.get('/api/quota');
    const el  = $('quota-today');
    const pct = q.today / q.limit;
    const cls = pct >= 0.8 ? 'quota-danger' : pct >= 0.5 ? 'quota-warn' : 'quota-ok';
    const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
    el.textContent = `${fmt(q.today)}/${fmt(q.limit)}`;
    el.className   = cls;
    $('quota-display').title =
      `API quota — today: ${q.today} units, session: ${q.session} units, limit: ${q.limit}/day`;
    $('last-checked').textContent = formatLastChecked(q.last_refreshed);
  } catch {}
}


// ── Signal ───────────────────────────────────────────────────────────────────

async function loadSignalSettings() {
  try {
    const s = await api.get('/api/settings/signal');
    state.signalConfigured = s.configured;
    if (s.configured) {
      $('signal-number-input').value = s.number;
      $('signal-status').textContent = 'Linked — send buttons active.';
      $('signal-status').className = 'api-key-status ok';
      $('btn-signal-remove').style.display = '';
      render(); // show signal buttons on all videos
    }
    updateSignalVisibility();
  } catch {}
}


function updateSignalVisibility() {
  const qBtn = $('btn-signal-queue');
  if (qBtn) qBtn.classList.toggle('hidden', !state.signalConfigured);
}


async function linkSignal() {
  const number = $('signal-number-input').value.trim();
  if (!number) {
    $('signal-status').textContent = 'Enter your Signal phone number first.';
    $('signal-status').className = 'api-key-status err';
    return;
  }
  $('signal-status').textContent = 'Saving…';
  $('signal-status').className = 'api-key-status';
  try {
    await api.post('/api/settings/signal/link', { number });
    state.signalConfigured = true;
    $('btn-signal-remove').style.display = '';
    updateSignalVisibility();
    render();
    // Load QR
    $('signal-status').textContent = 'Loading QR code…';
    const img = $('signal-qr-img');
    img.onerror = () => {
      $('signal-status').textContent = 'Failed to load QR — is signal-api service running?';
      $('signal-status').className = 'api-key-status err';
      $('signal-qr-wrap').classList.add('hidden');
    };
    img.onload = () => {
      $('signal-status').textContent = 'Scan QR then send buttons activate on next refresh.';
      $('signal-status').className = 'api-key-status ok';
    };
    img.src = `/api/settings/signal/qr?t=${Date.now()}`;
    $('signal-qr-wrap').classList.remove('hidden');
  } catch (e) {
    $('signal-status').textContent = 'Error: ' + e.message;
    $('signal-status').className = 'api-key-status err';
  }
}


async function removeSignal() {
  try {
    await api.del('/api/settings/signal');
    state.signalConfigured = false;
    $('signal-number-input').value = '';
    $('signal-status').textContent = '';
    $('btn-signal-remove').style.display = 'none';
    $('signal-qr-wrap').classList.add('hidden');
    updateSignalVisibility();
    render();
  } catch (e) {
    $('signal-status').textContent = 'Error: ' + e.message;
    $('signal-status').className = 'api-key-status err';
  }
}


async function signalSendVideo(videoId, title, channelName, thumbnailUrl) {
  try {
    await api.post('/api/signal/send', {
      video_id: videoId,
      title,
      channel_name: channelName,
      thumbnail_url: thumbnailUrl || '',
    });
    status('Sent to Signal ✓', 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Signal error: ' + e.message, 'err');
  }
}


async function signalSendQueue() {
  try {
    await api.post('/api/signal/send-queue', {});
    status('Queue sent to Signal ✓', 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Signal error: ' + e.message, 'err');
  }
}


// ── TV (Android TV / SmartTube) ──────────────────────────────────────────────

async function tvSend(videoId) {
  try {
    status('Sending to TV…', 'loading');
    await api.post('/api/tv/play', { video_id: videoId });
    status('Sent to TV ✓', 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('TV error: ' + e.message, 'err');
  }
}


async function loadTvSettings() {
  try {
    const s = await api.get('/api/settings/tv');
    state.tvConfigured = !!s.configured;
    $('tv-ip-input').value = s.ip || '';
    $('tv-smarttube-check').checked = !!s.use_smarttube;
  } catch {}
}


async function saveTvSettings() {
  const ip = $('tv-ip-input').value.trim();
  if (!ip) { $('tv-status').textContent = 'IP required'; $('tv-status').className = 'api-key-status err'; return; }
  try {
    const s = await api.post('/api/settings/tv', {
      ip,
      use_smarttube: $('tv-smarttube-check').checked,
    });
    state.tvConfigured = !!s.configured;
    $('tv-status').textContent = 'Saved ✓';
    $('tv-status').className = 'api-key-status ok';
    render();
  } catch (e) {
    $('tv-status').textContent = 'Error: ' + e.message;
    $('tv-status').className = 'api-key-status err';
  }
}


async function tvTest() {
  const url = $('tv-test-url').value.trim();
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/) || (/^[A-Za-z0-9_-]{11}$/.test(url) ? [null, url] : null);
  if (!m) {
    $('tv-status').textContent = 'Invalid YouTube URL';
    $('tv-status').className = 'api-key-status err';
    return;
  }
  try {
    $('tv-status').textContent = 'Sending test…';
    $('tv-status').className = 'api-key-status loading';
    await api.post('/api/tv/play', { video_id: m[1] });
    $('tv-status').textContent = 'Sent ✓';
    $('tv-status').className = 'api-key-status ok';
    state.tvConfigured = true;
    render();
  } catch (e) {
    $('tv-status').textContent = 'Error: ' + e.message;
    $('tv-status').className = 'api-key-status err';
  }
}


async function tvConnect() {
  try {
    $('tv-status').textContent = 'Connecting… check TV for prompt';
    $('tv-status').className = 'api-key-status loading';
    const r = await api.post('/api/tv/connect', {});
    if (r.ok) {
      $('tv-status').textContent = `Connected to ${r.target} ✓`;
      $('tv-status').className = 'api-key-status ok';
      state.tvConfigured = true;
      render();
    } else {
      $('tv-status').textContent = `Failed: ${r.stderr || r.stdout || 'unknown'}`;
      $('tv-status').className = 'api-key-status err';
    }
  } catch (e) {
    $('tv-status').textContent = 'Error: ' + e.message;
    $('tv-status').className = 'api-key-status err';
  }
}


// ── App settings (API key + hide shorts) ─────────────────────────────────────

async function loadSettings() {
  try {
    const s = await api.get('/api/settings');
    if (s.has_api_key) {
      $('api-key-status').textContent = `Key saved (${s.masked})`;
      $('api-key-status').className = 'api-key-status ok';
    }
    // hideShorts: localStorage is the source of truth once set.
    // Only fall back to server value on first-ever visit (no localStorage entry).
    if (localStorage.getItem('hideShorts') === null) {
      state.hideShorts = !!s.hide_shorts;
      localStorage.setItem('hideShorts', state.hideShorts ? '1' : '0');
      render();
    }
    // Always sync checkbox to whatever state ended up as
    $('hide-shorts-check').checked = state.hideShorts;
  } catch {}
}


async function saveApiKey() {
  const key = $('api-key-input').value.trim();
  if (!key) return;
  try {
    await api.post('/api/settings/api-key', { api_key: key });
    $('api-key-input').value = '';
    $('api-key-status').textContent = 'Key saved!';
    $('api-key-status').className = 'api-key-status ok';
  } catch (e) {
    $('api-key-status').textContent = 'Error: ' + e.message;
    $('api-key-status').className = 'api-key-status err';
  }
}
