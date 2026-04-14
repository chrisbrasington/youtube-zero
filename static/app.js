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
  channels:    [],
  queue:       [],
  queueOpen:   false,
  sortMode:    'manual',   // 'manual' | 'newest'
  manualExpand: new Set(), // channelIds force-expanded to full list
};

// Drag state
let dragSrcId = null;

// Player state
const player = {
  videoId:       null,
  title:         '',
  mode:          'normal',  // 'normal' | 'theater'
  queueVideoId:  null,      // set when playing from queue
};

// video_id → queue-able metadata (populated during render)
const videoMeta = new Map();

// ── View mode logic ───────────────────────────────────────────────────────────

function viewMode(channel) {
  // 'collapsed' = header only | 'compact' = header + unread strip | 'expanded' = full list
  const id = channel.channel_id;
  if (state.manualExpand.has(id)) return 'expanded';
  const hasUnread = (channel.videos || []).some(v => !v.is_read);
  return hasUnread ? 'compact' : 'collapsed';
}

function countUnread(channel) {
  return (channel.videos || []).filter(v => !v.is_read).length;
}

// ── Sort ──────────────────────────────────────────────────────────────────────

function displayChannels() {
  if (state.sortMode === 'newest') {
    return [...state.channels].sort((a, b) => {
      const aTop = (a.videos || [])[0]?.published_at || '';
      const bTop = (b.videos || [])[0]?.published_at || '';
      return bTop.localeCompare(aTop);
    });
  }
  return state.channels;
}

function renderSortBtn() {
  const btn = $('btn-sort');
  if (state.sortMode === 'newest') {
    btn.textContent = '↕ Newest first';
    btn.classList.add('active');
  } else {
    btn.textContent = '↕ Manual order';
    btn.classList.remove('active');
  }
}

// ── Render: channels ─────────────────────────────────────────────────────────

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
  let html = displayChannels().map(ch => renderChannel(ch)).join('');
  if (totalUnread === 0) html += '<div class="all-clear">✓ All caught up</div>';
  el.innerHTML = html;
}

function renderChannel(ch) {
  const mode    = viewMode(ch);
  const unread  = countUnread(ch);
  const allDone = ch.videos.length > 0 && unread === 0;
  const cid     = escAttr(ch.channel_id);
  const refreshed = ch.last_refreshed ? timeAgo(ch.last_refreshed) : 'never';
  const draggable = state.sortMode === 'manual' ? 'draggable="true"' : '';

  let bodyHtml = '';
  if (mode === 'compact') {
    const unreadVids = ch.videos.filter(v => !v.is_read);
    bodyHtml = `
      <div class="video-strip">
        ${unreadVids.map(v => renderVideoTile(v, ch)).join('')}
      </div>`;
  } else if (mode === 'expanded') {
    bodyHtml = `
      <div class="videos-list">
        ${ch.videos.length === 0
          ? '<div class="no-videos">No videos cached — click ↻ to refresh.</div>'
          : ch.videos.map(v => renderVideoRow(v, ch)).join('')
        }
      </div>`;
  }

  return `
    <div class="channel-card" id="ch-${cid}" data-channel-id="${cid}" ${draggable}>
      <div class="channel-header" data-action="toggle-channel" data-channel-id="${cid}">
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
          <div class="ch-meta">${ch.handle ? '@' + esc(ch.handle) + ' · ' : ''}${esc(refreshed)}</div>
        </div>
        <div class="ch-right">
          ${unread > 0 ? `<span class="badge-new">${unread} new</span>` : ''}
          <button class="ch-btn unread"
                  data-action="mark-unread"
                  data-channel-id="${cid}"
                  title="Mark all as unread">↺</button>
          <button class="ch-btn refresh"
                  data-action="refresh-channel"
                  data-channel-id="${cid}"
                  title="Refresh">↻</button>
          <button class="ch-btn delete"
                  data-action="delete-channel"
                  data-channel-id="${cid}"
                  title="Remove">✕</button>
          <span class="ch-caret ${mode === 'expanded' ? 'open' : ''}">▼</span>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

// Compact tile (shown in the default strip)
function renderVideoTile(video, channel) {
  videoMeta.set(video.video_id, {
    video_id:      video.video_id,
    channel_id:    channel.channel_id,
    channel_name:  channel.name,
    title:         video.title,
    thumbnail_url: video.thumbnail_url || '',
    published_at:  video.published_at,
  });

  const vid     = escAttr(video.video_id);
  const inQueue = video.in_queue;

  return `
    <div class="video-tile"
         data-action="open-player"
         data-video-id="${vid}"
         data-title="${escAttr(video.title)}"
         title="${escAttr(video.title)}">
      <div class="tile-thumb-wrap">
        <img class="tile-thumb"
             src="${escAttr(video.thumbnail_url || '')}"
             alt=""
             onerror="this.style.display='none'">
        ${video.duration ? `<span class="tile-dur">${esc(video.duration)}</span>` : ''}
        <button class="tile-q-btn ${inQueue ? 'queued' : ''}"
                data-action="toggle-queue"
                data-video-id="${vid}"
                data-in-queue="${inQueue ? '1' : '0'}"
                title="${inQueue ? 'In queue — click to remove' : 'Add to queue'}">
          ${inQueue ? '✓' : '+'}
        </button>
      </div>
      <div class="tile-info">
        <div class="tile-title">${esc(video.title)}</div>
        <div class="tile-age">${timeAgo(video.published_at)}</div>
      </div>
    </div>`;
}

// Full row (shown in expanded view)
function renderVideoRow(video, channel) {
  videoMeta.set(video.video_id, {
    video_id:      video.video_id,
    channel_id:    channel.channel_id,
    channel_name:  channel.name,
    title:         video.title,
    thumbnail_url: video.thumbnail_url || '',
    published_at:  video.published_at,
  });

  const vid     = escAttr(video.video_id);
  const inQueue = video.in_queue;
  const isRead  = video.is_read;

  return `
    <div class="video-row ${isRead ? 'read' : ''}">
      <div class="v-thumb-wrap"
           data-action="open-player"
           data-video-id="${vid}"
           data-title="${escAttr(video.title)}"
           style="cursor:pointer">
        <img class="v-thumb"
             src="${escAttr(video.thumbnail_url || '')}"
             alt=""
             onerror="this.style.display='none'">
        ${video.duration ? `<span class="v-dur">${esc(video.duration)}</span>` : ''}
      </div>
      <div class="v-info">
        <a class="v-title"
           href="https://www.youtube.com/watch?v=${vid}"
           target="_blank" rel="noopener noreferrer">
          ${esc(video.title)}
        </a>
        <div class="v-age">${timeAgo(video.published_at)}</div>
      </div>
      <button class="v-read-btn ${isRead ? 'is-read' : 'is-unread'}"
              data-action="${isRead ? 'video-unread' : 'video-read'}"
              data-video-id="${vid}"
              title="${isRead ? 'Mark as unread' : 'Mark as read'}">●</button>
      <button class="v-q-btn ${inQueue ? 'queued' : ''}"
              data-action="toggle-queue"
              data-video-id="${vid}"
              data-in-queue="${inQueue ? '1' : '0'}"
              title="${inQueue ? 'In queue — click to remove' : 'Add to queue'}">
        ${inQueue ? '✓' : '+'}
      </button>
    </div>`;
}

// ── Render: queue ─────────────────────────────────────────────────────────────

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
          <button class="btn-play"
                  data-action="play-from-queue"
                  data-video-id="${escAttr(item.video_id)}"
                  data-title="${escAttr(item.title)}">▶ Play</button>
          <a class="btn-yt-open"
             href="https://www.youtube.com/watch?v=${escAttr(item.video_id)}"
             target="_blank" rel="noopener noreferrer"
             data-action="watch-yt"
             data-video-id="${escAttr(item.video_id)}">↗ YouTube</a>
          <button class="btn-remove"
                  data-action="remove-queue"
                  data-video-id="${escAttr(item.video_id)}">Remove</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ── Render: player ────────────────────────────────────────────────────────────

function renderPlayer() {
  const overlay = $('player-overlay');
  if (!player.videoId) {
    overlay.classList.add('hidden');
    $('player-frame').src = '';
    return;
  }
  overlay.classList.remove('hidden');
  $('player-title').textContent = player.title;
  $('player-yt-link').href = `https://www.youtube.com/watch?v=${player.videoId}`;
  $('player-box').className = `player-box${player.mode === 'theater' ? ' theater' : ''}`;
  // Only set src if changed (avoids reloading video on re-render)
  const frame = $('player-frame');
  const newSrc = `https://www.youtube.com/embed/${player.videoId}?autoplay=1&rel=0`;
  if (frame.src !== newSrc) frame.src = newSrc;
  $('btn-player-theater').textContent = player.mode === 'theater' ? '⬜ Normal' : '⬜ Theater';
  $('btn-player-watched').classList.toggle('hidden', !player.queueVideoId);
}

// ── Master render ─────────────────────────────────────────────────────────────

function render() {
  renderChannels();
  renderQueue();
  renderQueueBadge();
  renderSortBtn();
  renderPlayer();
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

// ── Actions: channels ─────────────────────────────────────────────────────────

async function addChannel() {
  const input = $('channel-input').value.trim();
  if (!input) return;
  $('btn-add-channel').disabled = true;
  status('Adding…', 'loading');
  try {
    const ch = await api.post('/api/channels', { input });
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
    state.manualExpand.delete(channelId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function markChannelRead(channelId) {
  try {
    const res = await api.post(`/api/channels/${channelId}/mark-read`);
    const ch = state.channels.find(c => c.channel_id === channelId);
    if (ch) {
      ch.read_before = res.read_before;
      ch.videos.forEach(v => { v.is_read = true; });
    }
    state.manualExpand.delete(channelId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function markChannelUnread(channelId) {
  try {
    await api.post(`/api/channels/${channelId}/mark-unread`);
    const ch = state.channels.find(c => c.channel_id === channelId);
    if (ch) {
      ch.read_before = null;
      ch.videos.forEach(v => { v.is_read = false; });
    }
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
    const ok  = res.results.filter(r => !r.error).length;
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
  if (viewMode(ch) === 'expanded') {
    state.manualExpand.delete(channelId);
  } else {
    state.manualExpand.add(channelId);
  }
  render();
}

// ── Actions: per-video read state ─────────────────────────────────────────────

async function toggleVideoRead(videoId, currentlyRead) {
  const endpoint = currentlyRead ? 'unread' : 'read';
  try {
    await api.post(`/api/videos/${videoId}/${endpoint}`);
    state.channels.forEach(ch =>
      ch.videos.forEach(v => {
        if (v.video_id === videoId) v.is_read = !currentlyRead;
      })
    );
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

// ── Actions: queue ────────────────────────────────────────────────────────────

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

async function watchOnYouTube(videoId) {
  try {
    await api.post(`/api/queue/${videoId}/watched`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    state.channels.forEach(ch =>
      ch.videos.forEach(v => { if (v.video_id === videoId) v.in_queue = false; })
    );
    render();
  } catch {}
}

// ── Actions: player ───────────────────────────────────────────────────────────

function openPlayer(videoId, title, queueVideoId = null) {
  player.videoId      = videoId;
  player.title        = title;
  player.queueVideoId = queueVideoId;
  renderPlayer();
}

function closePlayer() {
  player.videoId      = null;
  player.title        = '';
  player.queueVideoId = null;
  renderPlayer();
}

function setPlayerMode(mode) {
  player.mode = mode;
  renderPlayer();
}

async function playerMarkWatched() {
  if (!player.queueVideoId) return;
  const videoId = player.queueVideoId;
  closePlayer();
  try {
    await api.post(`/api/queue/${videoId}/watched`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    state.channels.forEach(ch =>
      ch.videos.forEach(v => { if (v.video_id === videoId) v.in_queue = false; })
    );
    renderQueue();
    renderQueueBadge();
  } catch {}
}

// ── Actions: sort + persist order ────────────────────────────────────────────

async function persistOrder() {
  try {
    await api.post('/api/channels/reorder', {
      ids: state.channels.map(c => c.channel_id),
    });
  } catch {}
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
  // Close player backdrop
  if (e.target.closest('[data-action="close-player-backdrop"]') &&
      !e.target.closest('.player-box')) {
    closePlayer(); return;
  }

  // Mark channel read (circle check)
  const markReadBtn = e.target.closest('[data-action="mark-read"]');
  if (markReadBtn) { e.stopPropagation(); markChannelRead(markReadBtn.dataset.channelId); return; }

  // Mark channel unread (↺)
  const markUnreadBtn = e.target.closest('[data-action="mark-unread"]');
  if (markUnreadBtn) { e.stopPropagation(); markChannelUnread(markUnreadBtn.dataset.channelId); return; }

  // Refresh channel
  const refreshBtn = e.target.closest('[data-action="refresh-channel"]');
  if (refreshBtn) { e.stopPropagation(); refreshChannel(refreshBtn.dataset.channelId); return; }

  // Delete channel
  const deleteBtn = e.target.closest('[data-action="delete-channel"]');
  if (deleteBtn) { e.stopPropagation(); deleteChannel(deleteBtn.dataset.channelId); return; }

  // Toggle channel collapse/expand (click anywhere on header, not buttons)
  const channelHeader = e.target.closest('.channel-header');
  if (channelHeader && !e.target.closest('.ch-btn') && !e.target.closest('.ch-check')) {
    toggleChannel(channelHeader.dataset.channelId); return;
  }

  // Open player (tile click or row thumb click — not queue button)
  const openEl = e.target.closest('[data-action="open-player"]');
  if (openEl && !e.target.closest('[data-action="toggle-queue"]')) {
    openPlayer(openEl.dataset.videoId, openEl.dataset.title); return;
  }

  // Per-video mark as read
  const vReadBtn = e.target.closest('[data-action="video-read"]');
  if (vReadBtn) { e.stopPropagation(); toggleVideoRead(vReadBtn.dataset.videoId, false); return; }

  // Per-video mark as unread
  const vUnreadBtn = e.target.closest('[data-action="video-unread"]');
  if (vUnreadBtn) { e.stopPropagation(); toggleVideoRead(vUnreadBtn.dataset.videoId, true); return; }

  // Queue toggle (+ / ✓ button on tile or row)
  const qBtn = e.target.closest('[data-action="toggle-queue"]');
  if (qBtn) {
    e.stopPropagation();
    const meta    = videoMeta.get(qBtn.dataset.videoId);
    const inQueue = qBtn.dataset.inQueue === '1';
    if (meta) toggleQueue(meta, inQueue);
    return;
  }

  // Play from queue
  const playBtn = e.target.closest('[data-action="play-from-queue"]');
  if (playBtn) {
    openPlayer(playBtn.dataset.videoId, playBtn.dataset.title, playBtn.dataset.videoId);
    return;
  }

  // Open in YouTube (queue item) + mark watched
  const ytLink = e.target.closest('[data-action="watch-yt"]');
  if (ytLink) {
    // link already opens tab via href; just mark watched
    watchOnYouTube(ytLink.dataset.videoId);
    return;
  }

  // Remove from queue
  const removeBtn = e.target.closest('[data-action="remove-queue"]');
  if (removeBtn) { removeFromQueue(removeBtn.dataset.videoId); return; }
});

// ── Drag and drop (manual order only) ────────────────────────────────────────

document.addEventListener('dragstart', e => {
  const card = e.target.closest('.channel-card[draggable]');
  if (!card) return;
  dragSrcId = card.dataset.channelId;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => card.classList.add('dragging'), 0);
});

document.addEventListener('dragend', () => {
  document.querySelectorAll('.channel-card').forEach(c =>
    c.classList.remove('dragging', 'drag-over')
  );
  dragSrcId = null;
});

document.addEventListener('dragover', e => {
  const card = e.target.closest('.channel-card[draggable]');
  if (!card || card.dataset.channelId === dragSrcId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.channel-card').forEach(c => c.classList.remove('drag-over'));
  card.classList.add('drag-over');
});

document.addEventListener('drop', e => {
  const card = e.target.closest('.channel-card[draggable]');
  if (!card || !dragSrcId || card.dataset.channelId === dragSrcId) return;
  e.preventDefault();
  const srcIdx = state.channels.findIndex(c => c.channel_id === dragSrcId);
  const dstIdx = state.channels.findIndex(c => c.channel_id === card.dataset.channelId);
  if (srcIdx === -1 || dstIdx === -1) return;
  const [moved] = state.channels.splice(srcIdx, 1);
  state.channels.splice(dstIdx, 0, moved);
  render();
  persistOrder();
});

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && player.videoId) { closePlayer(); return; }
  if (e.key === 'f' && player.videoId && !e.target.matches('input')) {
    $('player-frame').requestFullscreen?.();
  }
});

// ── Player controls wiring ────────────────────────────────────────────────────

$('btn-player-close').addEventListener('click', closePlayer);
$('btn-player-theater').addEventListener('click', () => {
  setPlayerMode(player.mode === 'theater' ? 'normal' : 'theater');
});
$('btn-player-fullscreen').addEventListener('click', () => {
  $('player-frame').requestFullscreen?.().catch(() => {});
});
$('btn-player-watched').addEventListener('click', playerMarkWatched);

// ── Header wiring ─────────────────────────────────────────────────────────────

$('btn-add-channel').addEventListener('click', addChannel);
$('channel-input').addEventListener('keydown', e => { if (e.key === 'Enter') addChannel(); });
$('btn-refresh-all').addEventListener('click', refreshAll);
$('btn-clear-all').addEventListener('click', clearAll);
$('btn-sort').addEventListener('click', () => {
  state.sortMode = state.sortMode === 'manual' ? 'newest' : 'manual';
  render();
});
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

// ── Auto-refresh ──────────────────────────────────────────────────────────────

const REFRESH_STEPS  = [5, 10, 15, 30, 60, 120, 240, 720, 1440]; // minutes
const REFRESH_LABELS = ['5m','10m','15m','30m','1h','2h','4h','12h','24h'];

let autoRefreshTimer  = null;
let countdownTimer    = null;
let nextRefreshAt     = null;

function formatCountdown(totalSecs) {
  if (totalSecs <= 0)  return '0s';
  if (totalSecs < 60)  return `${totalSecs}s`;
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function updateCountdown() {
  const el = $('auto-refresh-countdown');
  if (!nextRefreshAt) { el.textContent = ''; return; }
  const secs = Math.ceil(Math.max(0, nextRefreshAt - Date.now()) / 1000);
  el.textContent = formatCountdown(secs);
}

function syncAutoRefresh() {
  // Clear existing timers
  clearTimeout(autoRefreshTimer);
  clearInterval(countdownTimer);
  autoRefreshTimer = countdownTimer = null;
  nextRefreshAt = null;

  const check = $('auto-refresh-check');
  const idx   = parseInt($('auto-refresh-slider').value, 10);
  $('auto-refresh-interval').textContent = REFRESH_LABELS[idx];

  if (!check.checked) {
    $('auto-refresh-countdown').textContent = '';
    return;
  }

  const ms = REFRESH_STEPS[idx] * 60 * 1000;
  nextRefreshAt = Date.now() + ms;

  // Tick countdown every second
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);

  // Fire refresh, then re-schedule (so countdown resets cleanly after each run)
  autoRefreshTimer = setTimeout(async () => {
    await refreshAll();
    syncAutoRefresh();
  }, ms);
}

function loadAutoRefreshPrefs() {
  const enabled = localStorage.getItem('arEnabled');
  const idx     = localStorage.getItem('arIdx');
  const check   = $('auto-refresh-check');
  const slider  = $('auto-refresh-slider');
  check.checked = enabled === null ? true : enabled === '1';
  slider.value  = idx !== null ? idx : '3';
  $('auto-refresh-interval').textContent = REFRESH_LABELS[parseInt(slider.value, 10)];
}

$('auto-refresh-check').addEventListener('change', () => {
  localStorage.setItem('arEnabled', $('auto-refresh-check').checked ? '1' : '0');
  syncAutoRefresh();
});
$('auto-refresh-slider').addEventListener('input', () => {
  const idx = parseInt($('auto-refresh-slider').value, 10);
  localStorage.setItem('arIdx', idx);
  syncAutoRefresh();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

loadSettings();
loadAutoRefreshPrefs();
syncAutoRefresh();
loadAll();
