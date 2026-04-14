'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5)  return `${w}w ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function status(msg, type = '') {
  const el = $('status-msg');
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ' ' + type : '');
}

// ── API ───────────────────────────────────────────────────────────────────────

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  },
  async post(path, body = {}) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: 'DELETE' });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  },
};

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  channels: [],
  queue:    [],
  queueOpen:       false,
  manualExpand:    new Set(),  // channelIds user explicitly opened
  manualCollapse:  new Set(),  // channelIds user explicitly closed
};

// Map video_id → {video_id, channel_id, channel_name, title, thumbnail_url, published_at}
// Populated during render so event handlers can look up data without inline JSON
const videoMeta = new Map();

// ── Read / collapse logic ─────────────────────────────────────────────────────

function isRead(video, channel) {
  if (!channel.read_before) return false;
  return video.published_at <= channel.read_before;
}

function countUnread(channel) {
  return (channel.videos || []).filter(v => !isRead(v, channel)).length;
}

function shouldCollapse(channel) {
  const id = channel.channel_id;
  if (state.manualCollapse.has(id)) return true;
  if (state.manualExpand.has(id))   return false;
  // Default: collapse when every video is read
  if (!channel.videos || channel.videos.length === 0) return false;
  return channel.videos.every(v => isRead(v, channel));
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderQueueBadge() {
  const n = state.queue.length;
  const badge = $('queue-badge');
  badge.textContent = n;
  badge.className = 'queue-badge' + (n === 0 ? ' empty' : '');
  $('btn-queue').className = 'btn-queue' + (state.queueOpen ? ' active' : '');
}

function renderQueue() {
  const el = $('queue-list');
  if (state.queue.length === 0) {
    el.innerHTML = '<div class="queue-empty">Queue is empty</div>';
    return;
  }
  el.innerHTML = state.queue.map(item => `
    <div class="q-item">
      <img class="q-thumb" src="${escAttr(item.thumbnail_url)}" alt=""
           onerror="this.src='data:image/svg+xml,<svg/>'">
      <div class="q-info">
        <div class="q-title">${esc(item.title)}</div>
        <div class="q-channel">${esc(item.channel_name)}</div>
        <div class="q-actions">
          <button class="btn-watch"
                  data-action="watch"
                  data-video-id="${escAttr(item.video_id)}">▶ Watch</button>
          <button class="btn-remove"
                  data-action="remove-queue"
                  data-video-id="${escAttr(item.video_id)}">Remove</button>
        </div>
      </div>
    </div>
  `).join('');
}

function renderChannels() {
  const el = $('channels-list');

  if (state.channels.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <h3>No channels yet</h3>
        <p>Add a YouTube channel above to get started.</p>
      </div>`;
    return;
  }

  const totalUnread = state.channels.reduce((sum, ch) => sum + countUnread(ch), 0);
  const allClear = totalUnread === 0;

  let html = state.channels.map(ch => renderChannel(ch)).join('');

  if (allClear) {
    html += '<div class="all-clear">✓ All caught up</div>';
  }

  el.innerHTML = html;
}

function renderChannel(ch) {
  const collapsed = shouldCollapse(ch);
  const unread    = countUnread(ch);
  const allDone   = (ch.videos || []).length > 0 && unread === 0;
  const refreshed = ch.last_refreshed ? timeAgo(ch.last_refreshed) : 'never';
  const cid       = escAttr(ch.channel_id);

  const videosHtml = collapsed ? '' : `
    <div class="videos-list">
      ${(ch.videos || []).length === 0
        ? '<div class="no-videos">No videos cached — click ↻ to refresh.</div>'
        : (ch.videos || []).map(v => renderVideo(v, ch)).join('')
      }
    </div>`;

  return `
    <div class="channel-card" id="ch-${cid}">
      <div class="channel-header"
           data-action="toggle-channel"
           data-channel-id="${cid}">
        <div class="ch-check ${allDone ? 'done' : ''}"
             data-action="mark-read"
             data-channel-id="${cid}"
             title="Mark all as read">✓</div>
        <img class="ch-thumb"
             src="${escAttr(ch.thumbnail_url || '')}"
             alt="${escAttr(ch.name)}"
             onerror="this.style.opacity='0'">
        <div class="ch-info">
          <div class="ch-name">${esc(ch.name)}</div>
          <div class="ch-meta">
            ${ch.handle ? '@' + esc(ch.handle) + ' · ' : ''}refreshed ${esc(refreshed)}
          </div>
        </div>
        <div class="ch-right">
          ${unread > 0 ? `<span class="badge-new">${unread} new</span>` : ''}
          <button class="ch-btn refresh"
                  data-action="refresh-channel"
                  data-channel-id="${cid}"
                  title="Refresh">↻</button>
          <button class="ch-btn delete"
                  data-action="delete-channel"
                  data-channel-id="${cid}"
                  title="Remove">✕</button>
          <span class="ch-caret ${collapsed ? '' : 'open'}">▼</span>
        </div>
      </div>
      ${videosHtml}
    </div>`;
}

function renderVideo(video, channel) {
  // Register for event delegation
  videoMeta.set(video.video_id, {
    video_id:      video.video_id,
    channel_id:    channel.channel_id,
    channel_name:  channel.name,
    title:         video.title,
    thumbnail_url: video.thumbnail_url || '',
    published_at:  video.published_at,
  });

  const read    = isRead(video, channel);
  const inQueue = video.in_queue;
  const vid     = escAttr(video.video_id);
  const ytUrl   = `https://www.youtube.com/watch?v=${vid}`;

  return `
    <div class="video-row ${read ? 'read' : ''}">
      <a href="${ytUrl}" target="_blank" rel="noopener noreferrer">
        <div class="v-thumb-wrap">
          <img class="v-thumb"
               src="${escAttr(video.thumbnail_url || '')}"
               alt=""
               onerror="this.style.display='none'">
          ${video.duration ? `<span class="v-dur">${esc(video.duration)}</span>` : ''}
        </div>
      </a>
      <div class="v-info">
        <a class="v-title"
           href="${ytUrl}"
           target="_blank"
           rel="noopener noreferrer">
          ${esc(video.title)}
        </a>
        <div class="v-age">${timeAgo(video.published_at)}</div>
      </div>
      <button class="v-q-btn ${inQueue ? 'queued' : ''}"
              data-action="toggle-queue"
              data-video-id="${vid}"
              data-in-queue="${inQueue ? '1' : '0'}"
              title="${inQueue ? 'In queue — click to remove' : 'Add to queue'}">
        ${inQueue ? '✓' : '+'}
      </button>
    </div>`;
}

function render() {
  renderChannels();
  renderQueue();
  renderQueueBadge();
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadAll() {
  try {
    [state.channels, state.queue] = await Promise.all([
      api.get('/api/channels'),
      api.get('/api/queue'),
    ]);
    render();
  } catch (e) {
    status('Failed to load: ' + e.message, 'err');
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function addChannel() {
  const input = $('channel-input').value.trim();
  if (!input) return;
  $('btn-add-channel').disabled = true;
  status('Adding…', 'loading');
  try {
    const ch = await api.post('/api/channels', { input });
    // Merge into state (avoid full reload)
    state.channels.push(ch);
    $('channel-input').value = '';
    render();
    status(`Added ${ch.name}`, 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  } finally {
    $('btn-add-channel').disabled = false;
  }
}

async function deleteChannel(channelId) {
  const ch = state.channels.find(c => c.channel_id === channelId);
  if (!ch || !confirm(`Remove "${ch.name}"?`)) return;
  try {
    await api.del(`/api/channels/${channelId}`);
    state.channels = state.channels.filter(c => c.channel_id !== channelId);
    state.manualCollapse.delete(channelId);
    state.manualExpand.delete(channelId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function markRead(channelId) {
  try {
    const res = await api.post(`/api/channels/${channelId}/mark-read`);
    const ch = state.channels.find(c => c.channel_id === channelId);
    if (ch) ch.read_before = res.read_before;
    state.manualCollapse.add(channelId);
    state.manualExpand.delete(channelId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function refreshChannel(channelId) {
  status('Refreshing…', 'loading');
  try {
    await api.post(`/api/channels/${channelId}/refresh`);
    state.channels = await api.get('/api/channels');
    render();
    status('Refreshed', 'ok');
    setTimeout(() => status(''), 2000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function refreshAll() {
  const btn = $('btn-refresh-all');
  btn.disabled = true;
  $('refresh-spinner').classList.remove('hidden');
  $('refresh-label').textContent = 'Refreshing…';
  status('Refreshing all channels…', 'loading');
  try {
    const res = await api.post('/api/refresh-all');
    state.channels = await api.get('/api/channels');
    render();
    const ok = res.results.filter(r => !r.error).length;
    const err = res.results.filter(r =>  r.error).length;
    status(`Refreshed ${ok} channel${ok !== 1 ? 's' : ''}${err ? `, ${err} failed` : ''}`, 'ok');
    setTimeout(() => status(''), 4000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    $('refresh-spinner').classList.add('hidden');
    $('refresh-label').textContent = '↻ Refresh All';
  }
}

async function clearAll() {
  if (!confirm('☢ Nuclear clear: mark ALL channels as read?\n\nYour queue is unaffected.')) return;
  try {
    await api.post('/api/clear-all');
    state.channels = await api.get('/api/channels');
    state.manualExpand.clear();
    state.channels.forEach(ch => state.manualCollapse.add(ch.channel_id));
    render();
    status('All cleared', 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

function toggleChannel(channelId) {
  const ch = state.channels.find(c => c.channel_id === channelId);
  if (!ch) return;
  if (shouldCollapse(ch)) {
    state.manualExpand.add(channelId);
    state.manualCollapse.delete(channelId);
  } else {
    state.manualCollapse.add(channelId);
    state.manualExpand.delete(channelId);
  }
  render();
}

async function toggleQueue(meta, currentlyInQueue) {
  if (currentlyInQueue) {
    await removeFromQueue(meta.video_id);
  } else {
    await addToQueue(meta);
  }
}

async function addToQueue(meta) {
  try {
    await api.post('/api/queue', meta);
    state.queue = await api.get('/api/queue');
    // Update in_queue flag in channel videos
    state.channels.forEach(ch =>
      ch.videos.forEach(v => { if (v.video_id === meta.video_id) v.in_queue = true; })
    );
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function removeFromQueue(videoId) {
  try {
    await api.del(`/api/queue/${videoId}`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    state.channels.forEach(ch =>
      ch.videos.forEach(v => { if (v.video_id === videoId) v.in_queue = false; })
    );
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function watchVideo(videoId) {
  window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
  try {
    await api.post(`/api/queue/${videoId}/watched`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    state.channels.forEach(ch =>
      ch.videos.forEach(v => { if (v.video_id === videoId) v.in_queue = false; })
    );
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const s = await api.get('/api/settings');
    if (s.has_api_key) {
      $('api-key-status').textContent = `Key saved (${s.masked})`;
      $('api-key-status').className = 'api-key-status ok';
    }
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

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener('click', e => {
  // Channel: toggle collapse (header click, but not sub-buttons)
  const header = e.target.closest('[data-action="toggle-channel"]');
  if (header && !e.target.closest('[data-action]')) {
    toggleChannel(header.dataset.channelId);
    return;
  }
  if (header && e.target === header) {
    toggleChannel(header.dataset.channelId);
    return;
  }

  // Mark channel read
  const markReadBtn = e.target.closest('[data-action="mark-read"]');
  if (markReadBtn) {
    e.stopPropagation();
    markRead(markReadBtn.dataset.channelId);
    return;
  }

  // Refresh channel
  const refreshBtn = e.target.closest('[data-action="refresh-channel"]');
  if (refreshBtn) {
    e.stopPropagation();
    refreshChannel(refreshBtn.dataset.channelId);
    return;
  }

  // Delete channel
  const deleteBtn = e.target.closest('[data-action="delete-channel"]');
  if (deleteBtn) {
    e.stopPropagation();
    deleteChannel(deleteBtn.dataset.channelId);
    return;
  }

  // Toggle caret / header (clicks that land on the header area but not any button)
  const channelHeader = e.target.closest('.channel-header');
  if (channelHeader && !e.target.closest('.ch-btn') && !e.target.closest('.ch-check')) {
    toggleChannel(channelHeader.dataset.channelId);
    return;
  }

  // Queue add/remove on video row
  const qBtn = e.target.closest('[data-action="toggle-queue"]');
  if (qBtn) {
    e.stopPropagation();
    const videoId  = qBtn.dataset.videoId;
    const inQueue  = qBtn.dataset.inQueue === '1';
    const meta     = videoMeta.get(videoId);
    if (meta) toggleQueue(meta, inQueue);
    return;
  }

  // Watch from queue
  const watchBtn = e.target.closest('[data-action="watch"]');
  if (watchBtn) {
    watchVideo(watchBtn.dataset.videoId);
    return;
  }

  // Remove from queue
  const removeBtn = e.target.closest('[data-action="remove-queue"]');
  if (removeBtn) {
    removeFromQueue(removeBtn.dataset.videoId);
    return;
  }
});

// ── Header button wiring ──────────────────────────────────────────────────────

$('btn-add-channel').addEventListener('click', addChannel);
$('channel-input').addEventListener('keydown', e => { if (e.key === 'Enter') addChannel(); });

$('btn-refresh-all').addEventListener('click', refreshAll);
$('btn-clear-all').addEventListener('click', clearAll);

$('btn-queue').addEventListener('click', () => {
  state.queueOpen = !state.queueOpen;
  $('queue-pane').classList.toggle('hidden', !state.queueOpen);
  renderQueueBadge();
});
$('btn-close-queue').addEventListener('click', () => {
  state.queueOpen = false;
  $('queue-pane').classList.add('hidden');
  renderQueueBadge();
});

$('btn-settings').addEventListener('click', () => {
  $('settings-panel').classList.toggle('hidden');
});
$('btn-save-key').addEventListener('click', saveApiKey);
$('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });

// ── Boot ──────────────────────────────────────────────────────────────────────

loadSettings();
loadAll();
