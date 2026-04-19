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
  feed:             { folders: [], channels: [] },
  queue:            [],
  queueOpen:        localStorage.getItem('queueOpen') === '1',
  sortMode:         'manual',
  hideShorts:       localStorage.getItem('hideShorts') === '1',  // sync read, no async needed
  manualExpand:     new Set(),
  folderExpand:     new Set(),
  signalConfigured: false,
};

function isShort(video) {
  if (!state.hideShorts || !video.duration) return false;
  const parts = video.duration.split(':').map(Number);
  const secs = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + (parts[1] || 0);
  return secs < 120;
}

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
  return (channel.videos || []).some(v => !v.is_read && !isShort(v)) ? 'compact' : 'collapsed';
}

function folderViewMode(folder) {
  const id = folder.id;
  if (state.folderExpand.has(id)) return 'expanded';
  const hasUnread = (folder.channels || []).some(ch =>
    (ch.videos || []).some(v => !v.is_read && !isShort(v))
  );
  return hasUnread ? 'compact' : 'collapsed';
}

function countUnread(channel) {
  return (channel.videos || []).filter(v => !v.is_read && !isShort(v)).length;
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
    $('all-clear-badge').classList.add('hidden');
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

  $('all-clear-badge').classList.toggle('hidden', totalUnread !== 0);

  el.innerHTML = items.map(({ type, item }) =>
    type === 'folder' ? renderFolder(item) : renderChannel(item, false)
  ).join('');
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
    const mixedVids = folderMixedStrip(folder).filter(v => !isShort(v));
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
    (folder.channels || []).every(ch => countUnread(ch) === 0);

  return `
    <div class="folder-card" id="fl-${fid}" data-folder-id="${fid}" ${draggable}>
      <div class="folder-header" data-action="toggle-folder" data-folder-id="${fid}">
        <div class="ch-check ${allDone ? 'done' : ''}"
             data-action="mark-folder-read"
             data-folder-id="${fid}"
             title="Mark all as read">✓</div>
        <button class="folder-icon-btn"
                data-action="open-icon-picker"
                data-folder-id="${fid}"
                title="Change icon">${esc(folder.icon || '📁')}</button>
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
    const unreadVids = ch.videos.filter(v => !v.is_read && !isShort(v));
    bodyHtml = `
      <div class="video-strip">
        ${unreadVids.map(v => renderVideoTile(v, ch, false)).join('')}
      </div>`;
  } else if (mode === 'expanded') {
    const visibleVids = ch.videos.filter(v => !isShort(v));
    bodyHtml = `
      <div class="videos-list">
        ${visibleVids.length === 0
          ? '<div class="no-videos">No videos cached — click ↻ to refresh.</div>'
          : visibleVids.map(v => renderVideoRow(v, ch)).join('')
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
        <button class="tile-read-btn"
                data-action="video-read"
                data-video-id="${vid}"
                title="Mark as read">●</button>
        ${state.signalConfigured ? `<button class="tile-signal-btn"
                data-action="signal-send"
                data-video-id="${vid}"
                data-title="${escAttr(video.title)}"
                data-channel-name="${escAttr(channel.name)}"
                data-thumbnail-url="${escAttr(video.thumbnail_url || '')}"
                title="Send to Signal Notes to Self">✉</button>` : ''}
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
      ${state.signalConfigured ? `<button class="v-signal-btn"
              data-action="signal-send"
              data-video-id="${vid}"
              data-title="${escAttr(video.title)}"
              data-channel-name="${escAttr(channel.name)}"
              data-thumbnail-url="${escAttr(video.thumbnail_url || '')}"
              title="Send to Signal Notes to Self">✉</button>` : ''}
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
    <div class="q-item" draggable="true" data-drag-context="queue" data-video-id="${escAttr(item.video_id)}">
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
          ${state.signalConfigured ? `<button class="btn-signal"
                  data-action="signal-send"
                  data-video-id="${escAttr(item.video_id)}"
                  data-title="${escAttr(item.title)}"
                  data-channel-name="${escAttr(item.channel_name)}"
                  data-thumbnail-url="${escAttr(item.thumbnail_url || '')}"
                  title="Send to Signal Notes to Self">✉</button>` : ''}
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
  const raw = $('channel-input').value;
  const lines = raw.split(/[\n\r,]+/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) { await addChannels(lines); return; }
  const input = lines[0] || '';
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

async function addChannels(inputs) {
  const valid = inputs.map(s => s.trim()).filter(Boolean);
  if (!valid.length) return;

  $('btn-add-channel').disabled = true;
  $('channel-input').value = '';
  let added = 0, failed = 0;

  for (let i = 0; i < valid.length; i++) {
    status(`Adding ${i + 1}/${valid.length}: ${valid[i]}…`, 'loading');
    try {
      const ch = await api.post('/api/channels', { input: valid[i] });
      state.feed.channels.push(ch);
      added++;
      render();
    } catch {
      failed++;
    }
  }

  status(`Added ${added}${failed ? `, ${failed} failed` : ''}`, added ? 'ok' : 'err');
  setTimeout(() => status(''), 4000);
  $('btn-add-channel').disabled = false;
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

function setRefreshProgress(pct) {
  const wrap = $('refresh-progress');
  const bar  = $('refresh-progress-bar');
  if (!wrap || !bar) return;
  if (pct <= 0) {
    bar.style.width = '0';
    wrap.classList.add('hidden');
  } else {
    wrap.classList.remove('hidden');
    bar.style.width = `${Math.round(pct * 100)}%`;
  }
}

function refreshAll() {
  const btn = $('btn-refresh-all');
  btn.disabled = true;
  $('refresh-spinner').classList.add('hidden');

  return new Promise(resolve => {
    const source = new EventSource('/api/refresh-all/stream');

    source.onmessage = async e => {
      const data = JSON.parse(e.data);
      if (data.done) {
        source.close();
        state.feed = await api.get('/api/feed');
        render();
        const ok  = data.results.filter(r => !r.error).length;
        const err = data.results.filter(r =>  r.error).length;
        status(`Refreshed ${ok} channel${ok !== 1 ? 's' : ''}${err ? `, ${err} failed` : ''}`, err ? 'err' : 'ok');
        setTimeout(() => status(''), 4000);
        updateQuota();
        btn.disabled = false;
        $('refresh-label').innerHTML = '↻<span class="btn-label"> Refresh All</span>';
        setRefreshProgress(0);
        resolve();
      } else {
        $('refresh-label').textContent = `↻ ${data.i}/${data.total} ${data.name}`;
        setRefreshProgress(data.i / data.total);
      }
    };

    source.onerror = () => {
      source.close();
      status('Refresh failed', 'err');
      btn.disabled = false;
      $('refresh-label').innerHTML = '↻<span class="btn-label"> Refresh All</span>';
      setRefreshProgress(0);
      resolve();
    };
  });
}

async function clearAll() {
  if (!confirm('☢ Nuclear clear: mark ALL channels as read?\n\nYour queue is unaffected.')) return;
  try {
    await api.post('/api/clear-all');
    state.feed = await api.get('/api/feed');
    state.manualExpand.clear();
    state.folderExpand.clear();
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

async function clearQueue() {
  if (state.queue.length === 0) return;
  try {
    await api.del('/api/queue');
    const clearedIds = state.queue.map(q => q.video_id);
    state.queue = [];
    clearedIds.forEach(id => setInQueue(id, false));
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

// ── Icon picker ───────────────────────────────────────────────────────────────

// [emoji, 'space-separated search keywords']
const EMOJI_SET = [
  // Folders / organization
  ['📁','folder files default'],['🗂️','folder tabs organize'],['🗃️','file cabinet archive'],
  ['📂','folder open'],['🗄️','cabinet storage files'],['📌','pin bookmark'],
  ['🔖','bookmark save'],['📋','clipboard list'],['📎','paperclip attach'],
  ['🗒️','notepad memo list'],['🗓️','calendar schedule date'],['📅','calendar date'],
  // Gaming
  ['🎮','gaming game controller play'],['🕹️','joystick arcade retro gaming'],
  ['👾','alien space invaders retro gaming'],['🏆','trophy winner achievement gaming'],
  ['🎯','target dart gaming aim'],['🎲','dice board game random'],['♟️','chess strategy game'],
  ['🃏','cards poker game'],['🎳','bowling game'],['🎰','slot casino gambling'],
  ['👑','crown king winner royalty'],['⚔️','sword battle rpg fight'],['🛡️','shield defense rpg'],
  ['🗡️','dagger rpg battle'],['🏹','bow arrow rpg ranger'],['🧩','puzzle game brain'],
  ['🀄','mahjong game tiles'],['🎪','carnival fun fair'],['🎠','carousel fun fair'],
  ['🧸','teddy bear toy cute'],['🪀','yoyo toy game'],['🪁','slingshot toy'],
  ['🎭','theater drama role play'],['🃏','joker wild card'],
  // Pirate / adventure
  ['🏴‍☠️','pirate flag skull crossbones jolly roger'],['☠️','skull crossbones death pirate'],
  ['🗺️','map treasure adventure explore'],['⚓','anchor nautical ship boat'],
  ['🦜','parrot pirate bird'],['🪝','hook pirate captain'],['🧭','compass navigate explore'],
  ['⛵','sailboat ship sea adventure'],['🚢','ship cruise ocean travel'],
  // Video / streaming
  ['📺','tv television watch stream'],['🎬','film clapper movie video'],
  ['🎥','camera movie film video'],['📹','video camera record'],
  ['🎞️','film strip movie'],['📽️','projector film cinema'],['🎦','cinema movie watch'],
  ['▶️','play button stream watch'],['📡','satellite broadcast stream dish'],
  ['🎙️','microphone podcast recording'],['📸','photo camera photography'],
  // Music / audio
  ['🎵','music note song'],['🎶','music notes songs'],['🎸','guitar music rock'],
  ['🎹','piano keyboard music'],['🎺','trumpet music brass'],['🥁','drums music beat'],
  ['🎷','saxophone music jazz'],['🎻','violin music classical'],['🎤','microphone sing vocal'],
  ['🎧','headphones music listen'],['📻','radio music broadcast'],['🔊','speaker volume sound'],
  ['🪗','accordion music folk'],['🪘','drum music percussion'],['🎼','sheet music score'],
  ['🪕','banjo country folk music'],['🔔','bell ring alert sound'],['🎚️','mixer fader audio'],
  // Tech / coding
  ['💻','laptop computer coding tech'],['🖥️','desktop monitor computer'],
  ['📱','phone mobile smartphone'],['⌨️','keyboard typing code'],['🖱️','mouse computer'],
  ['🔧','wrench tool fix repair'],['⚙️','gear settings config'],['🤖','robot ai automation'],
  ['💾','disk save data retro'],['🔌','plug power electric'],['🖨️','printer tech office'],
  ['💡','lightbulb idea innovation'],['🔋','battery power charge'],['📲','phone app download'],
  ['🧑‍💻','developer coder programmer tech'],['👨‍💻','programmer developer code'],
  ['🖲️','trackball mouse computer'],['💿','cd disc data optical'],['📀','dvd disc media'],
  ['🧮','abacus math calculate'],['📟','pager beeper retro tech'],['☎️','phone telephone retro'],
  ['🔦','flashlight torch light'],['🔭','telescope astronomy space look'],
  // Science / research
  ['🔬','microscope science lab research'],['🧬','dna biology genetics science'],
  ['🧪','flask chemistry science lab test'],['🌡️','thermometer temperature measure'],
  ['⚗️','beaker chemistry lab experiment'],['🧫','petri dish biology culture'],
  ['🧲','magnet physics attract'],['⚛️','atom physics nuclear quantum'],
  ['🔩','bolt screw engineering mechanical'],['🧰','toolbox repair fix build'],
  ['🪛','screwdriver fix tool'],['🪚','saw cut wood tool'],['⚒️','hammer pick tool'],
  // Nature / outdoors
  ['🌿','plant nature green herb'],['🌲','tree pine forest nature'],['🌊','wave ocean water sea'],
  ['🔥','fire flame hot energy'],['⭐','star favorite gold'],['🌙','moon night crescent'],
  ['☀️','sun day bright solar'],['🌸','cherry blossom flower spring japan'],
  ['🍀','clover lucky green four'],['🌈','rainbow color pride'],
  ['⚡','lightning bolt electric storm energy'],['❄️','snowflake cold winter ice frost'],
  ['🍃','leaf nature plant wind'],['🌺','hibiscus flower tropical'],['🌻','sunflower yellow bright'],
  ['🌵','cactus desert dry'],['🍄','mushroom fungi nature'],['🌾','wheat grain harvest farm'],
  ['🪨','rock stone boulder'],['🪸','coral ocean reef sea'],['🐚','shell ocean beach'],
  ['🌋','volcano fire mountain lava'],['🏜️','desert sand dry heat'],['🏕️','camp tent outdoor'],
  ['🧊','ice cube cold freeze'],['💧','water drop rain'],['🌪️','tornado storm wind'],
  // Space
  ['🚀','rocket space launch nasa'],['🛸','ufo space alien flying saucer'],
  ['🌍','earth globe world europe africa'],['🌎','earth globe americas'],
  ['🌕','full moon lunar space'],['🌌','galaxy milky way space stars'],
  ['🪐','saturn planet rings space'],['🛰️','satellite space orbit'],
  ['☄️','comet meteor space asteroid'],['🌠','shooting star wish space'],
  ['🔭','telescope astronomy observe'],['👨‍🚀','astronaut space explore'],
  // Sports / fitness
  ['⚽','soccer football sport ball'],['🏀','basketball sport nba'],
  ['🏈','football american sport nfl'],['⚾','baseball sport mlb'],
  ['🎾','tennis sport court'],['🏐','volleyball sport net'],['🎱','billiards pool sport cue'],
  ['🏊','swimming sport pool'],['🚴','cycling bike sport road'],
  ['🏋️','weightlifting gym fitness strength'],['🤸','gymnastics sport flexibility'],
  ['🥊','boxing sport fight gloves'],['🏄','surfing sport wave ocean'],
  ['⛷️','skiing sport winter snow'],['🧗','climbing sport wall bouldering'],
  ['🏇','horse racing sport jockey'],['🤼','wrestling sport fight'],['🥋','martial arts karate'],
  ['🏒','hockey stick ice sport'],['🎿','ski winter sport snow'],['🧘','yoga meditation fitness'],
  ['🏸','badminton sport racquet'],['🏓','ping pong table tennis'],['🥅','goal net sport'],
  ['🏌️','golf sport club'],['🤺','fencing sword sport'],['🧜','mermaid swim fantasy'],
  // Food / drink
  ['🍕','pizza food italian'],['🍔','burger food fast'],['🍜','noodles ramen food asian'],
  ['🍣','sushi japanese food raw'],['☕','coffee drink hot morning'],['🍺','beer drink pub'],
  ['🥤','drink soda juice cold'],['🍰','cake dessert sweet slice'],['🍩','donut sweet pastry'],
  ['🌮','taco mexican food'],['🍎','apple fruit red healthy'],['🥑','avocado food green healthy'],
  ['🍜','ramen noodle soup'],['🧁','cupcake cake sweet'],['🍫','chocolate sweet candy'],
  ['🍻','cheers beer toast drink'],['🥂','champagne toast celebrate'],['🍷','wine red drink'],
  ['🧃','juice box drink kids'],['🍵','tea green cup hot'],['🥃','whiskey spirit drink'],
  ['🍪','cookie bake sweet'],['🎂','birthday cake celebrate'],['🥞','pancakes breakfast food'],
  // Travel / places
  ['✈️','airplane travel fly flight'],['🚗','car drive road travel'],
  ['🚂','train rail steam travel'],['🏠','home house building'],
  ['🏖️','beach vacation sun sand'],['🧭','compass navigate explore direction'],
  ['🗼','eiffel tower paris france'],['🏔️','mountain peak hiking climb'],
  ['🌆','city skyline urban evening'],['🏝️','island tropical paradise'],
  ['🚁','helicopter fly air'],['🏎️','race car fast speed'],['🚂','locomotive train steam'],
  ['🗽','statue liberty new york usa'],['🏯','castle japan fortress'],
  ['⛩️','shrine japan torii gate'],['🌁','foggy bridge san francisco'],
  ['🚠','cable car mountain transport'],['🛶','canoe kayak paddle water'],
  ['🏟️','stadium arena sport venue'],['🎡','ferris wheel fair carnival'],
  // Art / creative
  ['🎨','palette art paint design color'],['✏️','pencil draw sketch write'],
  ['📝','note memo write journal'],['📚','books read study library learn'],
  ['🖼️','picture art frame gallery painting'],['🖌️','brush paint art stroke'],
  ['🖊️','pen write ink sign'],['📐','ruler triangle drawing geometry'],
  ['🪡','thread sew craft'],['🧶','yarn knit craft wool'],['🧵','thread sew stitch'],
  ['🪆','matryoshka doll russia craft'],['🗿','moai statue art mystery'],
  ['🏺','vase pottery ancient art'],['🎠','carousel art design'],
  // Business / finance
  ['💼','briefcase business work professional'],['📊','bar chart graph data analytics'],
  ['💰','money bag finance wealth rich'],['📈','chart up growth trend'],
  ['🏦','bank finance institution'],['📉','chart down decline loss'],
  ['🤝','handshake deal agreement'],['📣','megaphone announce loud'],
  ['💳','credit card payment'],['🏧','atm cash machine bank'],
  ['📦','box package shipping delivery'],['🏪','store shop retail'],
  ['🏬','department store mall shopping'],['🏢','office building work'],
  // People / roles
  ['👨‍🍳','chef cook food kitchen'],['👩‍🎨','artist creative design paint'],
  ['🧑‍🎤','singer musician rock star perform'],['👨‍🚀','astronaut space pilot'],
  ['🧑‍🔬','scientist researcher lab'],['👨‍⚕️','doctor medical health'],
  ['🧑‍🏫','teacher professor education learn'],['👷','worker construction hard hat'],
  ['🕵️','detective spy mystery investigate'],['🧙','wizard mage magic fantasy'],
  ['🧝','elf fantasy magic nature'],['🧛','vampire halloween dark fantasy'],
  ['🧟','zombie undead horror'],['🤠','cowboy western hat'],['🥷','ninja stealth martial'],
  // Animals
  ['🐱','cat pet animal meow'],['🐶','dog pet animal woof'],['🦊','fox animal clever'],
  ['🦁','lion animal king jungle'],['🐺','wolf animal howl pack'],['🦅','eagle bird sky'],
  ['🐉','dragon fantasy fire mythical'],['🦄','unicorn fantasy magic rainbow'],
  ['🐻','bear animal forest'],['🐼','panda animal cute china'],
  ['🦋','butterfly nature insect transform'],['🐬','dolphin ocean smart animal'],
  ['🐸','frog amphibian green'],['🦎','lizard reptile gecko'],['🐍','snake reptile python'],
  ['🦆','duck bird water quack'],['🦉','owl bird night wisdom'],['🐧','penguin bird cold'],
  ['🦈','shark ocean fish danger'],['🐙','octopus sea tentacle'],['🦑','squid sea ocean'],
  ['🐝','bee honey insect pollinate'],['🦟','mosquito insect bug'],['🕷️','spider web arachnid'],
  ['🦖','t-rex dinosaur prehistoric fossil'],['🦕','brachiosaurus dinosaur prehistoric'],
  ['🐲','dragon mythical fantasy green'],['🐊','crocodile alligator reptile'],
  // Flags / special
  ['🏴‍☠️','pirate jolly roger skull flag black'],['🏳️‍🌈','rainbow pride flag colorful'],
  ['🚩','red flag warning marker location'],['🏁','checkered flag finish race'],
  ['🎌','crossed flags japan ceremony'],['🏳️','white flag surrender peace'],
  ['🏴','black flag'],['🇺🇸','usa american flag united states'],
  // Misc / symbols
  ['❤️','heart love favorite red'],['💜','purple heart'],['💙','blue heart'],
  ['💚','green heart'],['🧡','orange heart'],['💛','yellow heart'],['🖤','black heart'],
  ['🔑','key unlock access security'],['🎁','gift present birthday surprise'],
  ['🎉','party popper celebrate'],['🌐','globe web internet network'],
  ['💫','dizzy star spin special'],['✨','sparkle magic shine glitter'],
  ['🎊','confetti celebrate party'],['🔐','lock closed secure private'],
  ['⚠️','warning alert caution danger'],['✅','check done complete success'],
  ['🏷️','tag label price'],['🔮','crystal ball magic predict future'],
  ['🧿','evil eye protect talisman'],['🪬','evil eye amulet protect'],
  ['♻️','recycle green eco environment'],['⚜️','fleur de lis symbol'],
  ['🔯','star of david hexagram'],['☯️','yin yang balance peace'],
  ['☮️','peace sign symbol'],['⚡','lightning bolt fast energy electric'],
  ['💎','diamond gem precious jewel'],['🪙','coin money gold silver'],
  ['🧲','magnet attract pull force'],['🪄','magic wand wizard spell'],
  ['🎀','ribbon bow gift decoration'],['🎗️','ribbon awareness cause'],
  ['🪞','mirror reflect vanity'],['🪟','window view glass'],['🛋️','sofa couch relax'],
  ['🪑','chair seat sit'],['🚪','door entrance exit room'],
  ['🧸','teddy bear plush soft cute'],['🪆','nesting doll matryoshka'],
  ['🏮','red lantern japan festival light'],['🪔','diya candle light india'],
  ['🕯️','candle flame light warm'],['💈','barber pole hair cut'],
  ['🗺️','world map geography globe explore'],
];

let pickerFolderId = null;

function showIconPicker(folderId, anchorEl) {
  pickerFolderId = folderId;
  const picker = $('icon-picker');
  $('icon-search').value = '';
  renderIconGrid('');
  picker.classList.remove('hidden');

  // Position below anchor, clamp to viewport
  const rect   = anchorEl.getBoundingClientRect();
  const pw     = 284;
  const left   = Math.min(rect.left, window.innerWidth - pw - 8);
  let   top    = rect.bottom + 4;
  if (top + 320 > window.innerHeight) top = rect.top - 324;
  picker.style.left = `${Math.max(4, left)}px`;
  picker.style.top  = `${Math.max(4, top)}px`;

  $('icon-search').focus();
}

function hideIconPicker() {
  $('icon-picker').classList.add('hidden');
  pickerFolderId = null;
}

function renderIconGrid(query) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? EMOJI_SET.filter(([, kw]) => kw.includes(q))
    : EMOJI_SET;
  $('icon-grid').innerHTML = filtered
    .map(([emoji]) =>
      `<button class="icon-btn" data-action="pick-icon" data-emoji="${escAttr(emoji)}">${emoji}</button>`
    ).join('');
}

async function setFolderIcon(folderId, icon) {
  try {
    await api.post(`/api/folders/${folderId}/set-icon`, { icon });
    const folder = findFolder(folderId);
    if (folder) folder.icon = icon;
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

$('icon-search').addEventListener('input', e => renderIconGrid(e.target.value));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pickerFolderId) { hideIconPicker(); return; }
});
// Close picker on outside click
document.addEventListener('mousedown', e => {
  if (pickerFolderId && !e.target.closest('#icon-picker') && !e.target.closest('[data-action="open-icon-picker"]')) {
    hideIconPicker();
  }
});

// ── Quota display ─────────────────────────────────────────────────────────────

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
  } catch {}
}

// ── Signal ────────────────────────────────────────────────────────────────────

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

// ── Settings ──────────────────────────────────────────────────────────────────

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

// ── Event delegation ──────────────────────────────────────────────────────────

document.addEventListener('click', e => {
  // Player backdrop
  if (e.target.closest('[data-action="close-player-backdrop"]') &&
      !e.target.closest('.player-box')) {
    closePlayer(); return;
  }

  // Folder: toggle
  const fHeader = e.target.closest('.folder-header');
  if (fHeader && !e.target.closest('.ch-btn') && !e.target.closest('.ch-check') &&
      !e.target.closest('.folder-icon-btn')) {
    toggleFolder(parseInt(fHeader.dataset.folderId, 10)); return;
  }

  // Icon picker: open
  const iconBtn = e.target.closest('[data-action="open-icon-picker"]');
  if (iconBtn) { e.stopPropagation(); showIconPicker(parseInt(iconBtn.dataset.folderId, 10), iconBtn); return; }

  // Icon picker: pick
  const pickBtn = e.target.closest('[data-action="pick-icon"]');
  if (pickBtn) { setFolderIcon(pickerFolderId, pickBtn.dataset.emoji); hideIconPicker(); return; }

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

  // Signal send
  const sigBtn = e.target.closest('[data-action="signal-send"]');
  if (sigBtn) {
    e.stopPropagation();
    signalSendVideo(sigBtn.dataset.videoId, sigBtn.dataset.title, sigBtn.dataset.channelName, sigBtn.dataset.thumbnailUrl);
    return;
  }

  // Open player (tile or row thumb)
  const openEl = e.target.closest('[data-action="open-player"]');
  if (openEl && !e.target.closest('[data-action="toggle-queue"]') && !e.target.closest('[data-action="signal-send"]') && !e.target.closest('[data-action="video-read"]') && !e.target.closest('[data-action="video-unread"]')) {
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

let queueDragSrcId = null;

document.addEventListener('dragstart', e => {
  // Queue item drag
  const qItem = e.target.closest('.q-item[draggable]');
  if (qItem) {
    queueDragSrcId = qItem.dataset.videoId;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => qItem.classList.add('dragging'), 0);
    return;
  }

  // Feed drag
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
  document.querySelectorAll('.channel-card, .folder-card, .q-item').forEach(c =>
    c.classList.remove('dragging', 'drag-over', 'drag-into')
  );
  dragSrcId = dragSrcType = dragSrcFolderId = null;
  queueDragSrcId = null;
});

document.addEventListener('dragover', e => {
  // Queue reorder
  if (queueDragSrcId) {
    const target = e.target.closest('.q-item');
    if (target && target.dataset.videoId !== queueDragSrcId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.q-item').forEach(q => q.classList.remove('drag-over'));
      target.classList.add('drag-over');
    }
    return;
  }

  if (!dragSrcId) return;

  document.querySelectorAll('.drag-over, .drag-into').forEach(c =>
    c.classList.remove('drag-over', 'drag-into')
  );

  if (dragSrcType === 'channel') {
    const folderCard = e.target.closest('.folder-card');
    if (folderCard) {
      const targetFolderId = parseInt(folderCard.dataset.folderId, 10);
      if (targetFolderId !== dragSrcFolderId) {
        // Different folder → drop-into highlight
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        folderCard.classList.add('drag-into');
        return;
      }
      // Same folder → fall through to channel reorder below
    }
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
  // Queue reorder
  if (queueDragSrcId) {
    const target = e.target.closest('.q-item');
    if (!target || target.dataset.videoId === queueDragSrcId) return;
    e.preventDefault();
    const si = state.queue.findIndex(q => q.video_id === queueDragSrcId);
    const di = state.queue.findIndex(q => q.video_id === target.dataset.videoId);
    if (si === -1 || di === -1) return;
    const [m] = state.queue.splice(si, 1);
    state.queue.splice(di, 0, m);
    state.queue.forEach((q, i) => { q.sort_order = i; });
    renderQueue();
    api.post('/api/queue/reorder', { ids: state.queue.map(q => q.video_id) }).catch(() => {});
    return;
  }

  if (!dragSrcId) return;

  if (dragSrcType === 'channel') {
    const folderCard = e.target.closest('.folder-card');
    if (folderCard) {
      const targetFolderId = parseInt(folderCard.dataset.folderId, 10);
      if (targetFolderId !== dragSrcFolderId) {
        e.preventDefault();
        setFolder(dragSrcId, String(targetFolderId));
        return;
      }
      // Same folder — fall through to channel reorder
    }
    const channelCard = e.target.closest('.channel-card');
    if (channelCard && channelCard.dataset.channelId !== dragSrcId) {
      e.preventDefault();
      reorderChannels(dragSrcId, channelCard.dataset.channelId);
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
  const srcInFolder = state.feed.folders.find(f => f.channels.some(c => c.channel_id === srcId));
  const dstInFolder = state.feed.folders.find(f => f.channels.some(c => c.channel_id === dstId));

  let list;
  if (srcInFolder && dstInFolder && srcInFolder.id === dstInFolder.id) {
    list = srcInFolder.channels;
  } else if (!srcInFolder && !dstInFolder) {
    list = state.feed.channels;
  } else {
    return;
  }

  const si = list.findIndex(c => c.channel_id === srcId);
  const di = list.findIndex(c => c.channel_id === dstId);
  if (si === -1 || di === -1) return;
  const [m] = list.splice(si, 1);
  list.splice(di, 0, m);
  list.forEach((ch, i) => { ch.sort_order = i; });
  render();
  api.post('/api/channels/reorder', { ids: list.map(c => c.channel_id) }).catch(() => {});
}

function applyFeedItemOrder(items, srcIdx, dstIdx) {
  const [moved] = items.splice(srcIdx, 1);
  items.splice(dstIdx, 0, moved);
  // Update sort_order so topLevelItems() re-sort preserves the new positions
  items.forEach((entry, i) => { entry.item.sort_order = i; });
  state.feed.folders  = items.filter(i => i.type === 'folder').map(i => i.item);
  state.feed.channels = items.filter(i => i.type === 'channel').map(i => i.item);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (!player.videoId || e.target.matches('input,textarea')) return;
  if (e.key === 'Escape') { closePlayer(); return; }
  if (e.key === 'f') { $('player-frame').requestFullscreen?.(); return; }
  if (e.key === 't') {
    player.mode = player.mode === 'theater' ? 'normal' : 'theater';
    renderPlayer();
    return;
  }
  if (e.key === 'y') {
    window.open(`https://www.youtube.com/watch?v=${player.videoId}`, '_blank', 'noopener,noreferrer');
    closePlayer();
    return;
  }
  if (e.key === 's' && state.signalConfigured) {
    const meta = videoMeta.get(player.videoId);
    if (meta) signalSendVideo(meta.video_id, meta.title, meta.channel_name, meta.thumbnail_url);
    closePlayer();
    return;
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
$('btn-save-key').addEventListener('click', saveApiKey);
$('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });
$('btn-signal-link').addEventListener('click', linkSignal);
$('btn-signal-remove').addEventListener('click', removeSignal);
$('btn-signal-queue').addEventListener('click', signalSendQueue);
$('btn-clear-queue').addEventListener('click', clearQueue);
$('signal-number-input').addEventListener('keydown', e => { if (e.key === 'Enter') linkSignal(); });
$('hide-shorts-check').addEventListener('change', async () => {
  state.hideShorts = $('hide-shorts-check').checked;
  localStorage.setItem('hideShorts', state.hideShorts ? '1' : '0');
  render();
  api.post('/api/settings/hide-shorts', { hide_shorts: state.hideShorts })
    .catch(e => console.warn('hide-shorts save failed:', e));
});

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
      else if (msg.type === 'signal_cmd') {
        if (msg.phase === 'received') signalToast(`signal: ${msg.cmd} received`);
        else if (msg.phase === 'done') signalToast(`signal: ${msg.cmd} response sent ✓`);
      }
    } catch (_) {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEventSource, 5000);
  };
}

(async () => {
  loadAutoRefreshPrefs();
  syncAutoRefresh();
  updateQuota();
  if (state.queueOpen) $('queue-pane').classList.remove('hidden');
  await loadAll();            // build UI with state from localStorage
  await loadSettings();       // reconcile DB → re-render only if value changed
  await loadSignalSettings(); // check Signal config, show/hide send buttons
  connectEventSource();
})();
