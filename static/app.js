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
  return `${Math.floor(d / 30)}mo ago`;
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
  feed:        { folders: [], channels: [] },
  queue:       [],
  queueOpen:   false,
  sortMode:    'manual',
  manualExpand: new Set(),   // channel_ids force-expanded to full list
  folderExpand: new Set(),   // folder ids force-expanded to show channels
};

let dragSrcId       = null;
let dragSrcType     = null;   // 'folder' | 'channel'
let dragSrcFolderId = null;   // current folder_id of the dragged channel (null = standalone)

const player = {
  videoId:      null,
  title:        '',
  mode:         'normal',
  queueVideoId: null,
};

const videoMeta = new Map();

// ── State accessors ───────────────────────────────────────────────────────────

function allChannels() {
  return [
    ...state.feed.channels,
    ...state.feed.folders.flatMap(f => f.channels),
  ];
}

function findChannel(channelId) {
  return allChannels().find(c => c.channel_id === channelId);
}

function findFolder(folderId) {
  return state.feed.folders.find(f => f.id === folderId);
}

// ── View mode ─────────────────────────────────────────────────────────────────

function channelViewMode(channel) {
  const id = channel.channel_id;
  if (state.manualExpand.has(id)) return 'expanded';
  return (channel.videos || []).some(v => !v.is_read) ? 'compact' : 'collapsed';
}

function folderViewMode(folder) {
  const id = folder.id;
  if (state.folderExpand.has(id)) return 'expanded';
  const hasUnread = (folder.channels || []).some(ch =>
    (ch.videos || []).some(v => !v.is_read)
  );
  return hasUnread ? 'compact' : 'collapsed';
}

function countUnread(channel) {
  return (channel.videos || []).filter(v => !v.is_read).length;
}

function folderUnreadCount(folder) {
  return (folder.channels || []).reduce((n, ch) => n + countUnread(ch), 0);
}

// ── Sort ──────────────────────────────────────────────────────────────────────

function mostRecentUnread(item) {
  // Works for both folders and standalone channels
  const vids = item.channels
    ? item.channels.flatMap(ch => ch.videos || [])
    : (item.videos || []);
  const unread = vids.filter(v => !v.is_read);
  return unread.length ? unread.reduce(
    (best, v) => v.published_at > best ? v.published_at : best, ''
  ) : '';
}

function topLevelItems() {
  const items = [
    ...state.feed.folders.map(f  => ({ type: 'folder',  item: f,  sort_order: f.sort_order  ?? f.id })),
    ...state.feed.channels.map(c => ({ type: 'channel', item: c,  sort_order: c.sort_order  ?? 0   })),
  ];
  if (state.sortMode === 'newest') {
    items.sort((a, b) => mostRecentUnread(b.item).localeCompare(mostRecentUnread(a.item)));
  } else {
    items.sort((a, b) => a.sort_order - b.sort_order);
  }
  return items;
}

function renderSortBtn() {
  const btn = $('btn-sort');
  btn.textContent  = state.sortMode === 'newest' ? '↕ Newest first' : '↕ Manual order';
  btn.className    = 'btn-sort' + (state.sortMode === 'newest' ? ' active' : '');
}

// ── Render: feed ──────────────────────────────────────────────────────────────

function renderFeed() {
  const el = $('channels-list');
  const items = topLevelItems();

  if (items.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <h3>No channels yet</h3>
        <p>Add a YouTube channel or create a folder above.</p>
      </div>`;
    return;
  }

  const totalUnread = items.reduce((n, { type, item }) =>
    n + (type === 'folder' ? folderUnreadCount(item) : countUnread(item)), 0
  );

  let html = items.map(({ type, item }) =>
    type === 'folder' ? renderFolder(item) : renderChannel(item, false)
  ).join('');

  if (totalUnread === 0) html += '<div class="all-clear">✓ All caught up</div>';
  el.innerHTML = html;
}

// ── Render: folder ────────────────────────────────────────────────────────────

function folderMixedStrip(folder) {
  // All unread videos across channels, sorted newest first
  const vids = folder.channels.flatMap(ch =>
    ch.videos
      .filter(v => !v.is_read)
      .map(v => ({ ...v, _channel: ch }))
  );
  vids.sort((a, b) => b.published_at.localeCompare(a.published_at));
  return vids;
}

function renderFolder(folder) {
  const mode    = folderViewMode(folder);
  const unread  = folderUnreadCount(folder);
  const fid     = escAttr(String(folder.id));
  const draggable = state.sortMode === 'manual' ? 'draggable="true"' : '';

  let bodyHtml = '';
  if (mode === 'compact') {
    const mixedVids = folderMixedStrip(folder);
    bodyHtml = `
      <div class="video-strip">
        ${mixedVids.map(v => renderVideoTile(v, v._channel, true)).join('')}
      </div>`;
  } else if (mode === 'expanded') {
    bodyHtml = `
      <div class="folder-channels">
        ${(folder.channels || []).map(ch => renderChannel(ch, true)).join('')}
      </div>`;
  }

  const allDone = (folder.channels || []).length > 0 &&
    (folder.channels || []).every(ch => (ch.videos || []).every(v => v.is_read));

  return `
    <div class="folder-card" id="fl-${fid}" data-folder-id="${fid}" ${draggable}>
      <div class="folder-header" data-action="toggle-folder" data-folder-id="${fid}">
        <div class="ch-check ${allDone ? 'done' : ''}"
             data-action="mark-folder-read"
             data-folder-id="${fid}"
             title="Mark all as read">✓</div>
        <span class="folder-icon">📁</span>
        <span class="folder-name">${esc(folder.name)}</span>
        <div class="folder-right">
          ${unread > 0 ? `<span class="badge-new">${unread} new</span>` : ''}
          <button class="ch-btn refresh" data-action="refresh-folder" data-folder-id="${fid}" title="Refresh all channels">↻</button>
          <button class="ch-btn" data-action="rename-folder" data-folder-id="${fid}" title="Rename">✏</button>
          <button class="ch-btn delete" data-action="delete-folder" data-folder-id="${fid}" title="Delete folder">✕</button>
          <span class="ch-caret ${mode === 'expanded' ? 'open' : ''}">▼</span>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

// ── Render: channel ───────────────────────────────────────────────────────────

function renderChannel(ch, nested) {
  const mode    = channelViewMode(ch);
  const unread  = countUnread(ch);
  const allDone = ch.videos.length > 0 && unread === 0;
  const cid     = escAttr(ch.channel_id);
  const refreshed = ch.last_refreshed ? timeAgo(ch.last_refreshed) : 'never';
  const draggable = state.sortMode === 'manual' ? 'draggable="true"' : '';

  // Folder select options
  const folderOptions = [
    `<option value="">No folder</option>`,
    ...state.feed.folders.map(f =>
      `<option value="${escAttr(String(f.id))}" ${ch.folder_id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`
    ),
  ].join('');

  let bodyHtml = '';
  if (mode === 'compact') {
    const unreadVids = ch.videos.filter(v => !v.is_read);
    bodyHtml = `
      <div class="video-strip">
        ${unreadVids.map(v => renderVideoTile(v, ch, false)).join('')}
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
    <div class="channel-card ${nested ? 'nested' : ''}" id="ch-${cid}"
         data-channel-id="${cid}" ${draggable}>
      <div class="channel-header" data-action="toggle-channel" data-channel-id="${cid}">
        <div class="ch-check ${allDone ? 'done' : ''}"
             data-action="mark-read" data-channel-id="${cid}"
             title="Mark all as read">✓</div>
        <img class="ch-thumb" src="${escAttr(ch.thumbnail_url || '')}"
             alt="${escAttr(ch.name)}" onerror="this.style.opacity='0'">
        <div class="ch-info">
          <div class="ch-name">${esc(ch.name)}</div>
          <div class="ch-meta">${ch.handle ? '@' + esc(ch.handle) + ' · ' : ''}${esc(refreshed)}</div>
        </div>
        <div class="ch-right">
          ${unread > 0 ? `<span class="badge-new">${unread} new</span>` : ''}
          <select class="ch-folder-select"
                  data-action="set-folder" data-channel-id="${cid}"
                  title="Move to folder">${folderOptions}</select>
          <button class="ch-btn unread" data-action="mark-unread" data-channel-id="${cid}" title="Mark all as unread">↺</button>
          <button class="ch-btn refresh" data-action="refresh-channel" data-channel-id="${cid}" title="Refresh">↻</button>
          <button class="ch-btn delete" data-action="delete-channel" data-channel-id="${cid}" title="Remove">✕</button>
          <span class="ch-caret ${mode === 'expanded' ? 'open' : ''}">▼</span>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

// ── Render: video tile ────────────────────────────────────────────────────────

function renderVideoTile(video, channel, showChannel) {
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
        <img class="tile-thumb" src="${escAttr(video.thumbnail_url || '')}" alt=""
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
        ${showChannel ? `<div class="tile-age" style="color:var(--accent);font-size:10px">${esc(channel.name)}</div>` : ''}
        <div class="tile-age">${timeAgo(video.published_at)}</div>
      </div>
    </div>`;
}

// ── Render: video row (expanded) ──────────────────────────────────────────────

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
        <img class="v-thumb" src="${escAttr(video.thumbnail_url || '')}" alt=""
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
  const frame = $('player-frame');
  const src = `https://www.youtube.com/embed/${player.videoId}?autoplay=1&rel=0`;
  if (frame.src !== src) frame.src = src;
  $('btn-player-theater').textContent = player.mode === 'theater' ? '⬜ Normal' : '⬜ Theater';
  $('btn-player-watched').classList.toggle('hidden', !player.queueVideoId);
}

// ── Master render ─────────────────────────────────────────────────────────────

function render() {
  renderFeed();
  renderQueue();
  renderQueueBadge();
  renderSortBtn();
  renderPlayer();
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function loadAll() {
  try {
    [state.feed, state.queue] = await Promise.all([
      api.get('/api/feed'),
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
    state.feed.channels.push(ch);
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
  const ch = findChannel(channelId);
  if (!ch || !confirm(`Remove "${ch.name}"?`)) return;
  try {
    await api.del(`/api/channels/${channelId}`);
    state.feed.channels = state.feed.channels.filter(c => c.channel_id !== channelId);
    state.feed.folders.forEach(f => {
      f.channels = f.channels.filter(c => c.channel_id !== channelId);
    });
    state.manualExpand.delete(channelId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function markChannelRead(channelId) {
  try {
    const res = await api.post(`/api/channels/${channelId}/mark-read`);
    const ch = findChannel(channelId);
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
    const ch = findChannel(channelId);
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
    state.feed = await api.get('/api/feed');
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
    state.feed = await api.get('/api/feed');
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
    state.feed = await api.get('/api/feed');
    state.manualExpand.clear();
    render();
    status('All cleared', 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

function toggleChannel(channelId) {
  const ch = findChannel(channelId);
  if (!ch) return;
  if (channelViewMode(ch) === 'expanded') {
    state.manualExpand.delete(channelId);
  } else {
    state.manualExpand.add(channelId);
  }
  render();
}

async function setFolder(channelId, folderId) {
  const numericId = folderId ? parseInt(folderId, 10) : null;
  try {
    await api.post(`/api/channels/${channelId}/set-folder`, { folder_id: numericId });
    state.feed = await api.get('/api/feed');
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

// ── Actions: folders ──────────────────────────────────────────────────────────

async function createFolder() {
  const name = prompt('Folder name:')?.trim();
  if (!name) return;
  try {
    const folder = await api.post('/api/folders', { name });
    state.feed.folders.push(folder);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function deleteFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  const chanCount = folder.channels.length;
  const msg = chanCount
    ? `Delete folder "${folder.name}"? Its ${chanCount} channel${chanCount !== 1 ? 's' : ''} will move to root.`
    : `Delete folder "${folder.name}"?`;
  if (!confirm(msg)) return;
  try {
    await api.del(`/api/folders/${folderId}`);
    state.feed = await api.get('/api/feed');
    state.folderExpand.delete(folderId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function renameFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  const name = prompt('New folder name:', folder.name)?.trim();
  if (!name || name === folder.name) return;
  try {
    await api.post(`/api/folders/${folderId}/rename`, { name });
    folder.name = name;
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

function toggleFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  if (folderViewMode(folder) === 'expanded') {
    state.folderExpand.delete(folderId);
  } else {
    state.folderExpand.add(folderId);
  }
  render();
}

async function markFolderRead(folderId) {
  try {
    const res = await api.post(`/api/folders/${folderId}/mark-read`);
    const folder = findFolder(folderId);
    if (folder) {
      folder.channels.forEach(ch => {
        ch.read_before = res.read_before;
        ch.videos.forEach(v => { v.is_read = true; });
      });
    }
    state.folderExpand.delete(folderId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function refreshFolder(folderId) {
  status('Refreshing folder…', 'loading');
  try {
    await api.post(`/api/folders/${folderId}/refresh`);
    state.feed = await api.get('/api/feed');
    render();
    status('Folder refreshed', 'ok');
    setTimeout(() => status(''), 2000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

// ── Actions: per-video read state ─────────────────────────────────────────────

async function toggleVideoRead(videoId, currentlyRead) {
  const endpoint = currentlyRead ? 'unread' : 'read';
  try {
    await api.post(`/api/videos/${videoId}/${endpoint}`);
    allChannels().forEach(ch =>
      ch.videos.forEach(v => { if (v.video_id === videoId) v.is_read = !currentlyRead; })
    );
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

// ── Actions: queue ────────────────────────────────────────────────────────────

function setInQueue(videoId, val) {
  allChannels().forEach(ch =>
    ch.videos.forEach(v => { if (v.video_id === videoId) v.in_queue = val; })
  );
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
    setInQueue(meta.video_id, true);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function removeFromQueue(videoId) {
  try {
    await api.del(`/api/queue/${videoId}`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    setInQueue(videoId, false);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function watchOnYouTube(videoId) {
  try {
    await api.post(`/api/queue/${videoId}/watched`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    setInQueue(videoId, false);
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
  player.videoId = player.title = player.queueVideoId = null;
  renderPlayer();
}

async function playerMarkWatched() {
  if (!player.queueVideoId) return;
  const vid = player.queueVideoId;
  closePlayer();
  try {
    await api.post(`/api/queue/${vid}/watched`);
    state.queue = state.queue.filter(q => q.video_id !== vid);
    setInQueue(vid, false);
    renderQueue();
    renderQueueBadge();
  } catch {}
}

// ── Actions: sort + persist ───────────────────────────────────────────────────

async function persistFeedOrder() {
  const items = topLevelItems().map(({ type, item }) => ({
    type,
    id: type === 'folder' ? String(item.id) : item.channel_id,
  }));
  try { await api.post('/api/feed/reorder', { items }); } catch {}
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
  // Player backdrop
  if (e.target.closest('[data-action="close-player-backdrop"]') &&
      !e.target.closest('.player-box')) {
    closePlayer(); return;
  }

  // Folder: toggle
  const fHeader = e.target.closest('.folder-header');
  if (fHeader && !e.target.closest('.ch-btn') && !e.target.closest('.ch-check')) {
    toggleFolder(parseInt(fHeader.dataset.folderId, 10)); return;
  }

  // Folder: mark all read
  const mfrBtn = e.target.closest('[data-action="mark-folder-read"]');
  if (mfrBtn) { e.stopPropagation(); markFolderRead(parseInt(mfrBtn.dataset.folderId, 10)); return; }

  // Folder: refresh
  const rfBtn = e.target.closest('[data-action="refresh-folder"]');
  if (rfBtn) { e.stopPropagation(); refreshFolder(parseInt(rfBtn.dataset.folderId, 10)); return; }

  // Folder: rename
  const renameBtn = e.target.closest('[data-action="rename-folder"]');
  if (renameBtn) { e.stopPropagation(); renameFolder(parseInt(renameBtn.dataset.folderId, 10)); return; }

  // Folder: delete
  const delFolderBtn = e.target.closest('[data-action="delete-folder"]');
  if (delFolderBtn) { e.stopPropagation(); deleteFolder(parseInt(delFolderBtn.dataset.folderId, 10)); return; }

  // Channel: mark read
  const mrBtn = e.target.closest('[data-action="mark-read"]');
  if (mrBtn) { e.stopPropagation(); markChannelRead(mrBtn.dataset.channelId); return; }

  // Channel: mark unread
  const muBtn = e.target.closest('[data-action="mark-unread"]');
  if (muBtn) { e.stopPropagation(); markChannelUnread(muBtn.dataset.channelId); return; }

  // Channel: refresh
  const refBtn = e.target.closest('[data-action="refresh-channel"]');
  if (refBtn) { e.stopPropagation(); refreshChannel(refBtn.dataset.channelId); return; }

  // Channel: delete
  const delBtn = e.target.closest('[data-action="delete-channel"]');
  if (delBtn) { e.stopPropagation(); deleteChannel(delBtn.dataset.channelId); return; }

  // Channel: toggle expand
  const chHeader = e.target.closest('.channel-header');
  if (chHeader && !e.target.closest('.ch-btn') && !e.target.closest('.ch-check') &&
      !e.target.closest('.ch-folder-select')) {
    toggleChannel(chHeader.dataset.channelId); return;
  }

  // Open player (tile or row thumb)
  const openEl = e.target.closest('[data-action="open-player"]');
  if (openEl && !e.target.closest('[data-action="toggle-queue"]')) {
    openPlayer(openEl.dataset.videoId, openEl.dataset.title); return;
  }

  // Per-video read/unread
  const vr = e.target.closest('[data-action="video-read"]');
  if (vr) { e.stopPropagation(); toggleVideoRead(vr.dataset.videoId, false); return; }
  const vu = e.target.closest('[data-action="video-unread"]');
  if (vu) { e.stopPropagation(); toggleVideoRead(vu.dataset.videoId, true); return; }

  // Queue toggle
  const qBtn = e.target.closest('[data-action="toggle-queue"]');
  if (qBtn) {
    e.stopPropagation();
    const meta   = videoMeta.get(qBtn.dataset.videoId);
    const inQ    = qBtn.dataset.inQueue === '1';
    if (meta) toggleQueue(meta, inQ);
    return;
  }

  // Play from queue
  const playBtn = e.target.closest('[data-action="play-from-queue"]');
  if (playBtn) {
    openPlayer(playBtn.dataset.videoId, playBtn.dataset.title, playBtn.dataset.videoId); return;
  }

  // YouTube link (mark watched)
  const ytLink = e.target.closest('[data-action="watch-yt"]');
  if (ytLink) { watchOnYouTube(ytLink.dataset.videoId); return; }

  // Remove from queue
  const rmBtn = e.target.closest('[data-action="remove-queue"]');
  if (rmBtn) { removeFromQueue(rmBtn.dataset.videoId); return; }
});

// Move-to-folder select (change event)
document.addEventListener('change', e => {
  const sel = e.target.closest('[data-action="set-folder"]');
  if (sel) {
    e.stopPropagation();
    setFolder(sel.dataset.channelId, sel.value || null);
  }
});

// ── Drag and drop ─────────────────────────────────────────────────────────────

function anyCard(el) {
  return el.closest('.channel-card') || el.closest('.folder-card');
}

document.addEventListener('dragstart', e => {
  const card = anyCard(e.target);
  if (!card) return;
  if (card.dataset.folderId) {
    dragSrcId       = card.dataset.folderId;
    dragSrcType     = 'folder';
    dragSrcFolderId = null;
  } else {
    dragSrcId       = card.dataset.channelId;
    dragSrcType     = 'channel';
    const ch        = findChannel(dragSrcId);
    dragSrcFolderId = ch?.folder_id ?? null;
  }
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => card.classList.add('dragging'), 0);
});

document.addEventListener('dragend', () => {
  document.querySelectorAll('.channel-card, .folder-card').forEach(c =>
    c.classList.remove('dragging', 'drag-over', 'drag-into')
  );
  dragSrcId = dragSrcType = dragSrcFolderId = null;
});

document.addEventListener('dragover', e => {
  if (!dragSrcId) return;

  document.querySelectorAll('.drag-over, .drag-into').forEach(c =>
    c.classList.remove('drag-over', 'drag-into')
  );

  if (dragSrcType === 'channel') {
    // Hovering over a folder card → "drop into folder" indicator
    const folderCard = e.target.closest('.folder-card');
    if (folderCard) {
      const targetFolderId = parseInt(folderCard.dataset.folderId, 10);
      if (targetFolderId !== dragSrcFolderId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        folderCard.classList.add('drag-into');
      }
      return;
    }
    // Hovering over another channel → reorder
    const channelCard = e.target.closest('.channel-card');
    if (channelCard && channelCard.dataset.channelId !== dragSrcId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      channelCard.classList.add('drag-over');
    }
    return;
  }

  if (dragSrcType === 'folder') {
    // Folder reorder: hover over any top-level item
    const topCard = e.target.closest('.channel-card:not(.nested)') || e.target.closest('.folder-card');
    if (topCard) {
      const targetId = topCard.dataset.channelId || topCard.dataset.folderId;
      if (targetId !== dragSrcId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        topCard.classList.add('drag-over');
      }
    }
  }
});

document.addEventListener('drop', e => {
  if (!dragSrcId) return;

  if (dragSrcType === 'channel') {
    // Drop onto folder → move channel into that folder
    const folderCard = e.target.closest('.folder-card');
    if (folderCard) {
      e.preventDefault();
      const targetFolderId = parseInt(folderCard.dataset.folderId, 10);
      if (targetFolderId !== dragSrcFolderId) {
        setFolder(dragSrcId, String(targetFolderId));
      }
      return;
    }

    // Drop onto another channel → reorder within the same context
    const channelCard = e.target.closest('.channel-card');
    if (channelCard && channelCard.dataset.channelId !== dragSrcId) {
      e.preventDefault();
      const targetId = channelCard.dataset.channelId;
      reorderChannels(dragSrcId, targetId);
    }
    return;
  }

  if (dragSrcType === 'folder') {
    const topCard = e.target.closest('.channel-card:not(.nested)') || e.target.closest('.folder-card');
    if (!topCard) return;
    const targetId = topCard.dataset.channelId || topCard.dataset.folderId;
    if (targetId === dragSrcId) return;
    e.preventDefault();

    const items = topLevelItems();
    const srcIdx = items.findIndex(({ type, item }) =>
      (type === 'folder' ? String(item.id) : item.channel_id) === dragSrcId
    );
    const dstIdx = items.findIndex(({ type, item }) =>
      (type === 'folder' ? String(item.id) : item.channel_id) === targetId
    );
    if (srcIdx === -1 || dstIdx === -1) return;
    applyFeedItemOrder(items, srcIdx, dstIdx);
    render();
    persistFeedOrder();
  }
});

function reorderChannels(srcId, dstId) {
  // Find which list both channels live in (same folder or both standalone)
  const srcInFolder = state.feed.folders.find(f => f.channels.some(c => c.channel_id === srcId));
  const dstInFolder = state.feed.folders.find(f => f.channels.some(c => c.channel_id === dstId));

  let list;
  if (srcInFolder && dstInFolder && srcInFolder.id === dstInFolder.id) {
    list = srcInFolder.channels;
  } else if (!srcInFolder && !dstInFolder) {
    list = state.feed.channels;
  } else {
    return; // different contexts — use dropdown to move between folders
  }

  const si = list.findIndex(c => c.channel_id === srcId);
  const di = list.findIndex(c => c.channel_id === dstId);
  if (si === -1 || di === -1) return;
  const [m] = list.splice(si, 1);
  list.splice(di, 0, m);
  render();
  persistFeedOrder();
}

function applyFeedItemOrder(items, srcIdx, dstIdx) {
  const [moved] = items.splice(srcIdx, 1);
  items.splice(dstIdx, 0, moved);
  state.feed.folders  = items.filter(i => i.type === 'folder').map(i => i.item);
  state.feed.channels = items.filter(i => i.type === 'channel').map(i => i.item);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && player.videoId) { closePlayer(); return; }
  if (e.key === 'f' && player.videoId && !e.target.matches('input,textarea')) {
    $('player-frame').requestFullscreen?.();
  }
});

// ── Player controls ───────────────────────────────────────────────────────────

$('btn-player-close').addEventListener('click', closePlayer);
$('btn-player-theater').addEventListener('click', () => {
  player.mode = player.mode === 'theater' ? 'normal' : 'theater';
  renderPlayer();
});
$('btn-player-fullscreen').addEventListener('click', () => {
  $('player-frame').requestFullscreen?.().catch(() => {});
});
$('btn-player-watched').addEventListener('click', playerMarkWatched);

// ── Header wiring ─────────────────────────────────────────────────────────────

$('btn-add-channel').addEventListener('click', addChannel);
$('channel-input').addEventListener('keydown', e => { if (e.key === 'Enter') addChannel(); });
$('btn-new-folder').addEventListener('click', createFolder);
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

const REFRESH_STEPS  = [5, 10, 15, 30, 60, 120, 240, 720, 1440];
const REFRESH_LABELS = ['5m','10m','15m','30m','1h','2h','4h','12h','24h'];

let autoRefreshTimer = null;
let countdownTimer   = null;
let nextRefreshAt    = null;

function formatCountdown(totalSecs) {
  if (totalSecs <= 0) return '0s';
  if (totalSecs < 60) return `${totalSecs}s`;
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function updateCountdown() {
  const el = $('auto-refresh-countdown');
  if (!nextRefreshAt) { el.textContent = ''; return; }
  el.textContent = formatCountdown(Math.ceil(Math.max(0, nextRefreshAt - Date.now()) / 1000));
}

function syncAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  clearInterval(countdownTimer);
  autoRefreshTimer = countdownTimer = null;
  nextRefreshAt = null;

  const check = $('auto-refresh-check');
  const idx   = parseInt($('auto-refresh-slider').value, 10);
  $('auto-refresh-interval').textContent = REFRESH_LABELS[idx];

  if (!check.checked) { $('auto-refresh-countdown').textContent = ''; return; }

  const ms = REFRESH_STEPS[idx] * 60 * 1000;
  nextRefreshAt = Date.now() + ms;
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);
  autoRefreshTimer = setTimeout(async () => {
    await refreshAll();
    syncAutoRefresh();
  }, ms);
}

function loadAutoRefreshPrefs() {
  const enabled = localStorage.getItem('arEnabled');
  const idx     = localStorage.getItem('arIdx');
  $('auto-refresh-check').checked = enabled === null ? true : enabled === '1';
  $('auto-refresh-slider').value  = idx !== null ? idx : '3';
  $('auto-refresh-interval').textContent = REFRESH_LABELS[parseInt($('auto-refresh-slider').value, 10)];
}

$('auto-refresh-check').addEventListener('change', () => {
  localStorage.setItem('arEnabled', $('auto-refresh-check').checked ? '1' : '0');
  syncAutoRefresh();
});
$('auto-refresh-slider').addEventListener('input', () => {
  localStorage.setItem('arIdx', $('auto-refresh-slider').value);
  syncAutoRefresh();
});

// ── Boot ──────────────────────────────────────────────────────────────────────

loadSettings();
loadAutoRefreshPrefs();
syncAutoRefresh();
loadAll();
