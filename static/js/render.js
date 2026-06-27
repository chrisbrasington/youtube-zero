'use strict';

/*
 * All rendering for youtube-zero — feed, folder, channel, video tile,
 * video row, queue, player — plus the sort comparator that decides
 * top-level ordering and the initial loadAll() that primes state from
 * the API.
 *
 * Classic script. Render functions write to innerHTML and as a side
 * effect populate videoMeta (declared in state.js) so the click
 * dispatcher in events.js can look up full metadata from a video id.
 *
 * render() is the single re-render entry point — action handlers in
 * actions.js call it after every state mutation.
 */


// ── Sort ─────────────────────────────────────────────────────────────────────

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


// ── Feed ─────────────────────────────────────────────────────────────────────

function renderFeed() {
  const el = $('channels-list');
  let items = topLevelItems();

  // /tv is unwatched-only: a folder/channel drops out once nothing's left to watch.
  if (castIsTv()) {
    items = items.filter(({ type, item }) =>
      (type === 'folder' ? folderUnreadCount(item) : countUnread(item)) > 0);
  }

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

  // Feed rebuilt → restore the TV-remote focus ring if we're on /tv (see tv.js).
  if (typeof tvRefocus === 'function') tvRefocus();
}


// ── Folder ───────────────────────────────────────────────────────────────────

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


// ── Channel ──────────────────────────────────────────────────────────────────

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


// ── Video tile (compact strip) ───────────────────────────────────────────────

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


// ── Video row (expanded channel list) ────────────────────────────────────────

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


// ── Queue ────────────────────────────────────────────────────────────────────

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


// ── Player overlay ───────────────────────────────────────────────────────────

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


// ── Master render entry point ────────────────────────────────────────────────

function render() {
  renderFeed();
  renderQueue();
  renderQueueBadge();
  renderSortBtn();
  renderPlayer();
  if (typeof msSyncCards === 'function') msSyncCards();
}


// ── Initial state load ───────────────────────────────────────────────────────

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
