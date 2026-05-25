'use strict';

// const, dom, api, and state live in /static/js/{const,dom,api,state}.js,
// loaded before this file via <script> tags in index.html.

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
    const mixedVids = folderMixedStrip(folder).filter(v => !isShort(v, v._channel));
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
          ${unread > 0 ? `<button class="ch-btn watch-folder" data-action="watch-folder" data-folder-id="${fid}" title="Watch all visible videos in this folder">▶</button>` : ''}
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
    const unreadVids = ch.videos.filter(v => !v.is_read && !isShort(v, ch));
    bodyHtml = `
      <div class="video-strip">
        ${unreadVids.map(v => renderVideoTile(v, ch, false)).join('')}
      </div>`;
  } else if (mode === 'expanded') {
    const visibleVids = ch.videos.filter(v => !isShort(v, ch));
    const allowShortsChecked = ch.allow_shorts ? 'checked' : '';
    bodyHtml = `
      <div class="videos-list">
        <label class="allow-shorts-toggle">
          <input type="checkbox" ${allowShortsChecked}
                 data-action="toggle-allow-shorts" data-channel-id="${cid}">
          Allow shorts from this channel
        </label>
        ${visibleVids.length === 0
          ? '<div class="no-videos">No videos cached — click ↻ to refresh.</div>'
          : visibleVids.map(v => renderVideoRow(v, ch)).join('')
        }
      </div>`;
  }

  const muted = !!ch.muted;
  return `
    <div class="channel-card ${nested ? 'nested' : ''} ${muted ? 'muted' : ''}" id="ch-${cid}"
         data-channel-id="${cid}" ${draggable}>
      <div class="channel-header" data-action="toggle-channel" data-channel-id="${cid}">
        <div class="ch-check ${allDone ? 'done' : ''}"
             data-action="mark-read" data-channel-id="${cid}"
             title="Mark all as read">✓</div>
        <img class="ch-thumb" src="${escAttr(ch.thumbnail_url || '')}"
             alt="${escAttr(ch.name)}" onerror="this.style.opacity='0'">
        <div class="ch-info">
          <div class="ch-name">${esc(ch.name)}${muted ? ' <span class="ch-muted-tag">muted</span>' : ''}</div>
          <div class="ch-meta">${ch.handle ? '@' + esc(ch.handle) + ' · ' : ''}${esc(refreshed)}</div>
        </div>
        <div class="ch-right">
          ${unread > 0 ? `<span class="badge-new">${unread} new</span>` : ''}
          <select class="ch-folder-select"
                  data-action="set-folder" data-channel-id="${cid}"
                  title="Move to folder">${folderOptions}</select>
          <button class="ch-btn mute ${muted ? 'on' : ''}"
                  data-action="toggle-mute" data-channel-id="${cid}"
                  data-muted="${muted ? '1' : '0'}"
                  title="${muted ? 'Unmute channel' : 'Mute channel — hides videos, auto-marks new ones read'}">${muted ? '🔇' : '🔊'}</button>
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
        ${state.tvConfigured ? `<button class="tile-tv-btn"
                data-action="tv-send"
                data-video-id="${vid}"
                title="Play on TV">📺</button>` : ''}
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
      ${state.tvConfigured ? `<button class="v-tv-btn"
              data-action="tv-send"
              data-video-id="${vid}"
              title="Play on TV">📺</button>` : ''}
    </div>`;
}

// ── Render: queue ─────────────────────────────────────────────────────────────

function shallowQueue() { return state.queue.filter(q => !q.is_deep); }
function deepQueue()    { return state.queue.filter(q =>  q.is_deep); }

function renderQueueBadge() {
  const n = shallowQueue().length;
  const badge = $('queue-badge');
  badge.textContent = n;
  badge.className = 'queue-badge' + (n === 0 ? ' empty' : '');
  $('btn-queue').className = 'btn-queue' + (state.queueOpen ? ' active' : '');
}

function qItemHtml(item, subscribedIds, group) {
  const isSubscribed = subscribedIds.has(item.channel_id);
  const isDeep = group === 'deep';
  const deepBtn = isDeep
    ? `<button class="q-icon-btn q-deep-toggle" data-action="queue-undeep"
              data-video-id="${escAttr(item.video_id)}"
              title="Move back to main queue">⤒</button>`
    : `<button class="q-icon-btn q-deep-toggle" data-action="queue-deep"
              data-video-id="${escAttr(item.video_id)}"
              title="Move to deep queue">⤓</button>`;
  return `
    <div class="q-item" draggable="true" data-drag-context="queue"
         data-video-id="${escAttr(item.video_id)}" data-group="${group}">
      <div class="q-thumb-wrap"
           data-action="play-from-queue"
           data-video-id="${escAttr(item.video_id)}"
           data-title="${escAttr(item.title)}">
        <img class="q-thumb" src="${escAttr(item.thumbnail_url)}" alt=""
             onerror="this.src='data:image/svg+xml,<svg/>'">
        ${item.duration ? `<span class="q-dur">${esc(item.duration)}</span>` : ''}
      </div>
      <div class="q-info">
        <div class="q-title">${esc(item.title)}</div>
        <div class="q-channel">${esc(item.channel_name)}</div>
        <div class="q-actions">
          <button class="q-icon-btn q-play"
                  data-action="play-from-queue"
                  data-video-id="${escAttr(item.video_id)}"
                  data-title="${escAttr(item.title)}"
                  title="Play">▶</button>
          <a class="q-icon-btn"
             href="https://www.youtube.com/watch?v=${escAttr(item.video_id)}"
             target="_blank" rel="noopener noreferrer"
             data-action="watch-yt"
             data-video-id="${escAttr(item.video_id)}"
             title="Open on YouTube (marks watched)">↗</a>
          ${!isSubscribed && item.channel_id ? `<button class="q-icon-btn"
                  data-action="subscribe-from-queue"
                  data-channel-id="${escAttr(item.channel_id)}"
                  title="Subscribe to ${escAttr(item.channel_name)}">+</button>` : ''}
          ${state.signalConfigured ? `<button class="q-icon-btn q-signal"
                  data-action="signal-send"
                  data-video-id="${escAttr(item.video_id)}"
                  data-title="${escAttr(item.title)}"
                  data-channel-name="${escAttr(item.channel_name)}"
                  data-thumbnail-url="${escAttr(item.thumbnail_url || '')}"
                  title="Send to Signal Notes to Self">✉</button>` : ''}
          ${state.tvConfigured ? `<button class="q-icon-btn q-tv"
                  data-action="tv-send"
                  data-video-id="${escAttr(item.video_id)}"
                  title="Play on TV">📺</button>` : ''}
          ${deepBtn}
          <button class="q-icon-btn q-remove"
                  data-action="remove-queue"
                  data-video-id="${escAttr(item.video_id)}"
                  title="Remove from queue">✕</button>
        </div>
      </div>
    </div>
  `;
}

function renderQueue() {
  const el = $('queue-list');
  const subscribedIds = new Set(allChannels().map(c => c.channel_id));
  const shallow = shallowQueue();
  const deep    = deepQueue();

  let html = '';
  if (shallow.length === 0 && deep.length === 0) {
    html += '<div class="queue-empty">Queue is empty</div>';
  } else if (shallow.length === 0) {
    html += '<div class="queue-empty queue-empty-shallow">Main queue is empty</div>';
  } else {
    html += `<div class="q-group" data-group="shallow">${
      shallow.map(it => qItemHtml(it, subscribedIds, 'shallow')).join('')
    }</div>`;
  }

  if (deep.length > 0) {
    const expanded = state.deepOpen;
    html += `
      <div class="deep-section ${expanded ? 'expanded' : 'collapsed'}">
        <div class="deep-header" data-action="toggle-deep" role="button" tabindex="0">
          <span class="deep-caret">${expanded ? '▾' : '▸'}</span>
          <span class="deep-title">Deep Queue</span>
          <span class="deep-count">${deep.length}</span>
          ${!expanded ? `<div class="deep-preview">${
            deep.slice(0, 12).map(it => `
              <img class="deep-preview-thumb" src="${escAttr(it.thumbnail_url)}"
                   alt="" title="${escAttr(it.title)}"
                   onerror="this.src='data:image/svg+xml,<svg/>'">`).join('')
          }${deep.length > 12 ? `<span class="deep-preview-more">+${deep.length - 12}</span>` : ''}</div>` : ''}
        </div>
        ${expanded ? `<div class="q-group" data-group="deep">${
          deep.map(it => qItemHtml(it, subscribedIds, 'deep')).join('')
        }</div>` : ''}
      </div>`;
  }

  el.innerHTML = html;
}

// ── Render: player ────────────────────────────────────────────────────────────

function renderPlayer() {
  const overlay = $('player-overlay');
  if (!player.videoId) {
    overlay.classList.add('hidden');
    if (ytPlayer && ytPlayer.stopVideo) {
      try { ytPlayer.stopVideo(); } catch {}
    }
    ytLoadedId = null;
    return;
  }
  overlay.classList.remove('hidden');
  $('player-title').textContent = player.title;
  $('player-yt-link').href = `https://www.youtube.com/watch?v=${player.videoId}`;
  $('player-box').className = `player-box${player.mode === 'theater' ? ' theater' : ''}`;
  const frame = $('player-frame');
  if (ytPlayer && ytPlayer.loadVideoById) {
    if (ytLoadedId !== player.videoId) {
      ytPlayer.loadVideoById(player.videoId);
      ytLoadedId = player.videoId;
    }
  } else {
    const origin = encodeURIComponent(location.origin);
    const src = `https://www.youtube.com/embed/${player.videoId}?autoplay=1&rel=0&enablejsapi=1&origin=${origin}`;
    if (frame.src !== src) {
      frame.src = src;
      frame.addEventListener('load', () => setupYTPlayer(), { once: true });
    }
  }
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

let lastLoadAt = 0;

async function loadAll() {
  try {
    [state.feed, state.queue] = await Promise.all([
      api.get('/api/feed'),
      api.get('/api/queue'),
    ]);
    render();
    lastLoadAt = Date.now();
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
    $('channel-input').value = '';
    if (ch.video_found) {
      renderQueue();
      status(`Video found: ${ch.title}`, 'ok');
    } else {
      state.feed.channels.push(ch);
      render();
      status(`Added ${ch.name}`, 'ok');
    }
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  } finally {
    $('btn-add-channel').disabled = false;
  }
}

async function subscribeFromQueue(channelId) {
  status('Adding…', 'loading');
  try {
    const ch = await api.post('/api/channels', { input: channelId });
    state.feed.channels.push(ch);
    render();
    renderQueue();
    status(`Added ${ch.name}`, 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
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
      if (ch.video_found) {
        renderQueue();
      } else {
        state.feed.channels.push(ch);
        render();
      }
      added++;
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

async function toggleAllowShorts(channelId, allow) {
  try {
    await api.post(`/api/channels/${channelId}/allow-shorts`, { allow });
    const ch = findChannel(channelId);
    if (ch) ch.allow_shorts = allow ? 1 : 0;
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function toggleMute(channelId, muted) {
  try {
    await api.post(`/api/channels/${channelId}/mute`, { muted });
    state.feed = await api.get('/api/feed');
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

async function clearQueue(deep = false) {
  const target = state.queue.filter(q => !!q.is_deep === deep);
  if (target.length === 0) return;
  try {
    await api.del(`/api/queue${deep ? '?deep=1' : ''}`);
    const clearedIds = target.map(q => q.video_id);
    state.queue = state.queue.filter(q => !!q.is_deep !== deep);
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

async function setQueueDeep(videoId, isDeep) {
  try {
    await api.post(`/api/queue/${videoId}/deep`, { is_deep: !!isDeep });
    state.queue = await api.get('/api/queue');
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

// ── Actions: sort + persist ───────────────────────────────────────────────────

async function persistFeedOrder() {
  const items = topLevelItems().map(({ type, item }) => ({
    type,
    id: type === 'folder' ? String(item.id) : item.channel_id,
  }));
  try { await api.post('/api/feed/reorder', { items }); } catch {}
}


// quota + signal + tv + settings live in /static/js/features.js.

// click + change event delegation lives in /static/js/events.js.


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
$('btn-save-key').addEventListener('click', saveApiKey);
$('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });
$('btn-signal-link').addEventListener('click', linkSignal);
$('btn-signal-remove').addEventListener('click', removeSignal);
$('btn-signal-queue').addEventListener('click', signalSendQueue);
$('btn-clear-queue').addEventListener('click', () => clearQueue(false));
$('btn-watch-queue').addEventListener('click', () => watchStartQueue());
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
      fetch('/',                 { cache: 'reload' }),
      fetch('/static/app.js',    { cache: 'reload' }),
      fetch('/static/style.css', { cache: 'reload' }),
    ]);
  } catch {}
  const u = new URL(location.href);
  u.searchParams.set('_cb', Date.now());
  location.replace(u.toString());
}
$('btn-clear-cache').addEventListener('click', clearBrowserCache);

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
  $('auto-refresh-check').checked = enabled === '1';
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

// ── Pull-to-refresh (mobile) ──────────────────────────────────────────────────

(function setupPullToRefresh() {
  const pane = $('channels-pane');
  if (!pane) return;
  let startY = null;
  let pulling = false;
  const THRESHOLD = 70;

  pane.addEventListener('touchstart', (e) => {
    // Skip if touch started inside a swipe-dismissible element
    if (e.target.closest('.video-tile, .video-row, .q-item')) {
      startY = null;
      return;
    }
    if (pane.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = false;
    } else {
      startY = null;
    }
  }, { passive: true });

  pane.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const delta = e.touches[0].clientY - startY;
    if (delta > 10) {
      pulling = true;
      const pct = Math.min(delta / THRESHOLD, 1);
      setRefreshProgress(pct);  // bar fills 0-100% as you pull
    }
  }, { passive: true });

  pane.addEventListener('touchend', (e) => {
    if (startY === null) { setRefreshProgress(0); return; }
    const delta = (e.changedTouches[0].clientY - startY);
    if (pulling && delta >= THRESHOLD) {
      setRefreshProgress(0);
      refreshAll();
    } else {
      setRefreshProgress(0);
    }
    startY = null;
    pulling = false;
  }, { passive: true });
})();

// ── Swipe to dismiss (mobile) ─────────────────────────────────────────────────

(function setupSwipeDismiss() {
  const THRESHOLD = 100;

  let el = null, type = null, vid = null;
  let startX = 0, startY = 0, dx = 0, dy = 0, axis = null;

  function pickTarget(target) {
    // Only thumbnail area initiates swipe — text region passes through to scroll
    if (target.closest('.tile-thumb-wrap')) {
      const tile = target.closest('.video-tile');
      if (tile) return { el: tile, type: 'video', vid: tile.dataset.videoId };
    }
    if (target.closest('.v-thumb-wrap')) {
      const row = target.closest('.video-row');
      if (row) {
        const v = row.querySelector('[data-video-id]');
        return v ? { el: row, type: 'video', vid: v.dataset.videoId } : null;
      }
    }
    return null;
  }

  document.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    const m = pickTarget(e.target);
    if (!m || !m.vid) return;
    el = m.el; type = m.type; vid = m.vid;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = dy = 0;
    axis = null;
    el.style.transition = '';
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!el) return;
    dx = e.touches[0].clientX - startX;
    dy = e.touches[0].clientY - startY;
    if (axis === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis === 'x') {
      if (e.cancelable) e.preventDefault();
      const d = Math.max(0, dx);
      el.style.transform = `translateX(${d}px)`;
      el.style.opacity = String(Math.max(0.3, 1 - d / 300));
    }
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!el) return;
    if (axis === 'x' && dx >= THRESHOLD) {
      el.style.transition = 'transform .2s, opacity .2s';
      el.style.transform = 'translateX(110%)';
      el.style.opacity = '0';
      if (type === 'video') toggleVideoRead(vid, false);
    } else {
      el.style.transition = 'transform .15s, opacity .15s';
      el.style.transform = '';
      el.style.opacity = '';
    }
    el = null; type = null; vid = null;
  }, { passive: true });
})();

// ── Action sheet swipe (mobile) ───────────────────────────────────────────────

(function setupSheetSwipe() {
  const THRESHOLD = 50;
  let startX = 0, startY = 0, dx = 0, axis = null, active = false;

  document.addEventListener('touchstart', (e) => {
    if (!e.target.closest('#action-sheet-thumb')) return;
    active = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0; axis = null;
    const thumb = $('action-sheet-thumb');
    if (thumb) thumb.style.transition = '';
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!active) return;
    dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (axis === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis === 'x') {
      if (e.cancelable) e.preventDefault();
      const thumb = $('action-sheet-thumb');
      if (thumb) {
        thumb.style.transform = `translateX(${dx}px)`;
        thumb.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 400));
      }
    }
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!active) return;
    active = false;
    const thumb = $('action-sheet-thumb');
    if (thumb) {
      thumb.style.transition = 'transform .15s, opacity .15s';
      thumb.style.transform = '';
      thumb.style.opacity = '';
    }
    if (axis === 'x' && Math.abs(dx) >= THRESHOLD) {
      advanceSheet(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
})();

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
    } catch (_) {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEventSource, 5000);
  };
}

// watch overlay (in-page + /watch URL) lives in /static/js/watch.js.


(async () => {
  loadAutoRefreshPrefs();
  syncAutoRefresh();

  const route = watchRouteFor(location.pathname);
  if (route) {
    await watchBootUrl(route);
    return;
  }

  updateQuota();
  if (state.queueOpen) $('queue-pane').classList.remove('hidden');
  await loadAll();            // build UI with state from localStorage
  await loadSettings();       // reconcile DB → re-render only if value changed
  await loadSignalSettings(); // check Signal config, show/hide send buttons
  await loadTvSettings();
  render();                   // re-render so TV buttons appear once configured
  connectEventSource();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > 60_000) {
      loadAll();
    }
  });
})();
