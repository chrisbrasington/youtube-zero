'use strict';

/*
 * All rendering for youtube-zero — feed, folder, channel, video tile,
 * video row, queue, player — plus the sort comparator that decides
 * top-level ordering and the initial loadAll() that primes state from
 * the API.
 *
 * The queue and the deep queue are folder cards inside the feed rather
 * than a pane of their own: the queue leads the list, the deep queue
 * closes it, and the videos in both are ordinary video tiles.
 *
 * Classic script. Render functions write to innerHTML and as a side
 * effect populate videoMeta (declared in state.js) so the click
 * dispatcher in events.js can look up full metadata from a video id.
 *
 * render() is the single re-render entry point — action handlers in
 * actions.js call it after every state mutation.
 */


// ── Sort ─────────────────────────────────────────────────────────────────────

// Always the manual order — the drag order set in Manage mode.
function topLevelItems() {
  return [
    ...state.feed.folders.map(f  => ({ type: 'folder',  item: f,  sort_order: f.sort_order  ?? f.id })),
    ...state.feed.channels.map(c => ({ type: 'channel', item: c,  sort_order: c.sort_order  ?? 0   })),
  ].sort((a, b) => a.sort_order - b.sort_order);
}


// ── Feed ─────────────────────────────────────────────────────────────────────

// The queue bookends the feed: what you've lined up to watch sits above
// everything, what you've parked sits below it. Both are folder cards, so a
// queued video looks and behaves exactly like a video anywhere else on the page.
function renderFeed() {
  const el = $('channels-list');
  let items = topLevelItems();

  // /tv is unwatched-only: a folder/channel drops out once nothing's left to watch.
  if (castIsTv()) {
    items = items.filter(({ type, item }) =>
      (type === 'folder' ? folderUnreadCount(item) : countUnread(item)) > 0);
  }

  const body = items.length === 0
    ? `<div class="empty-state">
         <h3>No channels yet</h3>
         <p>Add a YouTube channel or create a folder above.</p>
       </div>`
    : items.map(({ type, item }) =>
        type === 'folder' ? renderFolder(item) : renderChannel(item, false)
      ).join('');

  const totalUnread = items.reduce((n, { type, item }) =>
    n + (type === 'folder' ? folderUnreadCount(item) : countUnread(item)), 0
  );

  // Queued videos are still waiting on you, so they hold the badge back too.
  $('all-clear-badge').classList.toggle(
    'hidden', totalUnread !== 0 || shallowQueue().length > 0);

  el.innerHTML = renderQueueCard() + body + renderDeepCard();

  // Feed rebuilt → restore the TV-remote focus ring if we're on /tv (see tv.js).
  if (typeof tvRefocus === 'function') tvRefocus();
}


// ── Folder ───────────────────────────────────────────────────────────────────

// All unread videos across a folder's channels, newest first. Honours the
// per-folder channel filter, so narrowing the strip narrows what ▶ plays too —
// the visible cards and the play list are the same list.
function folderMixedStrip(folder) {
  const only = state.folderChannelFilter.get(folder.id);
  const narrowed = only ? folder.channels.filter(ch => ch.channel_id === only) : null;
  // A filtered channel that's since been deleted or moved out would otherwise
  // hide the whole folder with no visible cause.
  const channels = narrowed && narrowed.length ? narrowed : folder.channels;
  const vids = channels.flatMap(ch =>
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
  // Reordering is a Manage-mode activity — don't let a browse-mode drag
  // silently rearrange the feed.
  const draggable = state.manageMode ? 'draggable="true"' : '';

  // Active channel filter, if any — narrows the strip and what ▶ plays.
  const filterId  = state.folderChannelFilter.get(folder.id);
  const filterChan = filterId
    ? (folder.channels || []).find(ch => ch.channel_id === filterId)
    : null;
  const filterVisible = filterChan ? countUnread(filterChan) : 0;

  let bodyHtml = '';
  if (mode === 'compact') {
    const mixedVids = folderMixedStrip(folder).filter(v => !isShort(v, v._channel));
    bodyHtml = `
      <div class="video-strip">
        ${mixedVids.map(v => renderVideoTile(v, v._channel, true, folder.id)).join('')}
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
    <div class="folder-card ${unread > 0 ? 'has-new' : ''}" id="fl-${fid}" data-folder-id="${fid}" ${draggable}>
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
        ${filterChan ? `
          <button class="folder-filter"
                  data-action="clear-folder-filter" data-folder-id="${fid}"
                  title="Show the whole folder again">
            ${esc(filterChan.name)} <span class="folder-filter-x">✕</span>
          </button>` : ''}
        <div class="folder-right">
          ${unread > 0
            ? `<span class="badge-new">${filterChan ? filterVisible + ' of ' + unread : unread + ' new'}</span>`
            : `<span class="badge-quiet">${(folder.channels || []).length} ch</span>`}
          ${unread > 0 ? `<button class="ch-btn watch-folder" data-action="watch-folder" data-folder-id="${fid}" title="Watch all visible videos in this folder">▶</button>` : ''}
          <button class="ch-btn refresh" data-action="refresh-folder" data-folder-id="${fid}" title="Refresh all channels">↻</button>
          <button class="ch-btn" data-action="rename-folder" data-folder-id="${fid}" title="Rename">✏</button>
          <button class="ch-btn delete" data-action="delete-folder" data-folder-id="${fid}" title="Delete folder">✕</button>
          <button class="ch-btn ch-caret ${mode === 'expanded' ? 'open' : ''}"
                  data-action="expand-folder" data-folder-id="${fid}"
                  title="${mode === 'expanded' ? 'Back to the video strip' : 'Show channels in this folder'}">▼</button>
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
  // Reordering is a Manage-mode activity — don't let a browse-mode drag
  // silently rearrange the feed.
  const draggable = state.manageMode ? 'draggable="true"' : '';

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

// `opts.queue` is 'shallow' or 'deep' when the tile lives in one of the queue
// cards. Everything about the tile stays the same except the first rail button,
// which becomes the move that makes sense from where you're standing: park it
// for later, or pull it back up.
function renderVideoTile(video, channel, showChannel, folderId = null, opts = {}) {
  videoMeta.set(video.video_id, {
    video_id:      video.video_id,
    channel_id:    channel.channel_id,
    channel_name:  channel.name,
    title:         video.title,
    thumbnail_url: video.thumbnail_url || '',
    published_at:  video.published_at,
    duration:      video.duration,
  });

  const vid     = escAttr(video.video_id);
  const group   = opts.queue || null;
  const inQueue = video.in_queue;
  const inQuickQueue = state.quickQueueVideos.includes(video.video_id);
  // Inside a queue card every tile is queued, so the ring and the ⤓ marker are
  // noise; the running position is still worth showing in the main queue.
  const qpos    = group ? null : queuePositionOf(video.video_id);
  const qnum    = group === 'shallow' ? queuePositionOf(video.video_id) : null;
  const isFiltered = folderId != null &&
    state.folderChannelFilter.get(folderId) === channel.channel_id;

  const firstRailBtn =
    group === 'deep'
      ? `<button class="rail-btn rail-queue"
                 data-action="queue-undeep"
                 data-video-id="${vid}"
                 title="Move back up to the queue">+ Queue</button>`
    : group === 'shallow'
      ? `<button class="rail-btn rail-later"
                 data-action="queue-deep"
                 data-video-id="${vid}"
                 title="Park in the deep queue">+ Later</button>`
      : `<button class="rail-btn rail-queue ${inQueue ? 'queued' : ''}"
                 data-action="toggle-queue"
                 data-video-id="${vid}"
                 data-in-queue="${inQueue ? '1' : '0'}"
                 title="${inQueue ? 'In queue — click to remove' : 'Add to queue'}">
           ${inQueue ? '✓ Queued' : '+ Queue'}
         </button>`;

  return `
    <div class="video-tile ${inQuickQueue ? 'quick-queue-selected' : ''} ${!group && inQueue ? 'is-queued' : ''}"
         data-action="open-player"
         data-video-id="${vid}"
         ${group === 'shallow' ? `data-queue-id="${vid}"` : ''}
         ${group ? `draggable="true" data-drag-context="queue" data-group="${group}"` : ''}
         data-title="${escAttr(video.title)}"
         tabindex="0"
         title="${escAttr(video.title)}">
      <div class="tile-thumb-wrap">
        <img class="tile-thumb" src="${escAttr(video.thumbnail_url || '')}" alt=""
             onerror="this.style.display='none'">
        ${video.duration ? `<span class="tile-dur">${esc(video.duration)}</span>` : ''}
        ${qpos ? `<span class="tile-qpos ${qpos.deep ? 'deep' : ''}"
                        title="${qpos.deep ? 'Deep queue' : 'Queue position ' + qpos.n}"
                  >${qpos.deep ? '⤓' : qpos.n}</span>` : ''}
        ${qnum ? `<span class="tile-qpos" title="Queue position ${qnum.n}">${qnum.n}</span>` : ''}
        ${inQuickQueue ? `<span class="tile-qqueue-check">✓</span>` : ''}
        <span class="tile-scrim"></span>
        <span class="tile-play">▶</span>
        <div class="tile-rail">
          ${firstRailBtn}
          <button class="rail-btn rail-done"
                  data-action="${group ? 'queue-done' : 'video-read'}"
                  data-video-id="${vid}"
                  title="${group ? 'Mark watched and drop from the queue' : 'Mark as read'}">✓ Done</button>
          ${opts.subscribable ? `<button class="rail-btn rail-sub"
                  data-action="subscribe-from-queue"
                  data-channel-id="${escAttr(channel.channel_id)}"
                  title="Subscribe to ${escAttr(channel.name)}">+ Sub</button>` : ''}
          <button class="rail-btn rail-more"
                  data-action="more-actions"
                  data-video-id="${vid}"
                  title="More — send to TV, Signal, share (or right-click)">⋯</button>
        </div>
      </div>
      <div class="tile-info">
        <div class="tile-title">${esc(video.title)}</div>
        ${showChannel && folderId != null
          ? `<button class="tile-meta tile-meta-btn ${isFiltered ? 'on' : ''}"
                     data-action="filter-folder-channel"
                     data-folder-id="${escAttr(String(folderId))}"
                     data-channel-id="${escAttr(channel.channel_id)}"
                     title="${isFiltered ? 'Show the whole folder again' : 'Show only ' + channel.name}">
               <span class="tile-chan">${esc(channel.name)}</span>
               <span class="tile-age">${timeAgo(video.published_at)}</span>
             </button>`
          : `<div class="tile-meta">
               ${showChannel ? `<span class="tile-chan">${esc(channel.name)}</span>` : ''}
               <span class="tile-age">${timeAgo(video.published_at)}</span>
             </div>`}
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
    duration:      video.duration,
  });

  const vid     = escAttr(video.video_id);
  const inQueue = video.in_queue;
  const isRead  = video.is_read;
  const inQuickQueue = state.quickQueueVideos.includes(video.video_id);

  return `
    <div class="video-row ${isRead ? 'read' : ''} ${inQuickQueue ? 'quick-queue-selected' : ''}">
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
      <button class="v-more-btn"
              data-action="more-actions"
              data-video-id="${vid}"
              title="More — send to TV, Signal, share (or right-click)">⋯</button>
    </div>`;
}


// ── Queue ────────────────────────────────────────────────────────────────────

function shallowQueue() { return state.queue.filter(q => !q.is_deep); }
function deepQueue()    { return state.queue.filter(q =>  q.is_deep); }

// Where a video sits in the watch order, so a card can show it without the
// queue pane being open. Returns null when the video isn't queued at all.
function queuePositionOf(videoId) {
  const i = shallowQueue().findIndex(q => q.video_id === videoId);
  if (i !== -1) return { n: i + 1, deep: false };
  return deepQueue().some(q => q.video_id === videoId) ? { n: 0, deep: true } : null;
}

// A queue row carries its own channel name rather than belonging to a channel
// card, so hand renderVideoTile a stand-in. Videos added by URL have no
// channel at all, which the tile already renders as a bare age line.
//
// A queued video can come from a channel you don't follow — that's the one
// place in the app that offers to subscribe, so the tile grows a fourth rail
// button for it rather than losing the option.
function renderQueueTile(item, group, subscribedIds) {
  return renderVideoTile(
    item,
    { channel_id: item.channel_id || '', name: item.channel_name || '' },
    !!item.channel_name,
    null,
    {
      queue: group,
      subscribable: !!item.channel_id && !subscribedIds.has(item.channel_id),
    },
  );
}

// First card in the feed whenever anything is queued — nothing to show and it
// stays out of the way entirely.
function renderQueueCard() {
  const items = shallowQueue();
  if (!items.length) return '';
  const open = state.queueCardOpen;
  const subscribedIds = new Set(allChannels().map(c => c.channel_id));
  return `
    <div class="folder-card queue-card has-new" id="queue-card">
      <div class="folder-header" id="queue-card-header" data-action="toggle-queue-card">
        <span class="folder-icon queue-card-icon">▶</span>
        <span class="folder-name">Queue</span>
        <div class="folder-right">
          <span class="badge-new">${items.length} queued</span>
          <button class="ch-btn watch-folder" data-action="watch-queue"
                  title="Watch through the queue">▶</button>
          ${state.signalConfigured ? `<button class="ch-btn" data-action="signal-queue"
                  title="Send the queue to Signal Notes to Self">✉</button>` : ''}
          <button class="ch-btn delete" data-action="clear-queue"
                  title="Empty the queue (the deep queue is untouched)">✕</button>
          <span class="ch-btn ch-caret ${open ? 'open' : ''}">▼</span>
        </div>
      </div>
      ${open ? `<div class="video-strip">${
        items.map(it => renderQueueTile(it, 'shallow', subscribedIds)).join('')
      }</div>` : ''}
    </div>`;
}

// Always last, always collapsed to start with. Parked videos should cost one
// row of the page until you go looking for them.
function renderDeepCard() {
  const items = deepQueue();
  if (!items.length) return '';
  const open = state.deepOpen;
  const subscribedIds = new Set(allChannels().map(c => c.channel_id));
  return `
    <div class="folder-card deep-card" id="deep-queue-card">
      <div class="folder-header" id="deep-queue-card-header" data-action="toggle-deep">
        <span class="folder-icon queue-card-icon">⤓</span>
        <span class="folder-name">Deep Queue</span>
        <div class="folder-right">
          <span class="badge-quiet">${items.length} parked</span>
          <button class="ch-btn delete" data-action="clear-deep-queue"
                  title="Empty the deep queue">✕</button>
          <span class="ch-btn ch-caret ${open ? 'open' : ''}">▼</span>
        </div>
      </div>
      ${open ? `<div class="video-strip">${
        items.map(it => renderQueueTile(it, 'deep', subscribedIds)).join('')
      }</div>` : ''}
    </div>`;
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
    const src = `${window.YT_EMBED_HOST}/embed/${player.videoId}?autoplay=1&rel=0&enablejsapi=1&origin=${origin}`;
    if (frame.src !== src) {
      frame.src = src;
      frame.addEventListener('load', () => setupYTPlayer(), { once: true });
    }
  }
  $('btn-player-theater').textContent = player.mode === 'theater' ? '⬜ Normal' : '⬜ Theater';
  $('btn-player-watched').classList.toggle('hidden', !player.queueVideoId);
}


// ── Master render entry point ────────────────────────────────────────────────

// Drop channel filters that have nothing left to show — watching out a
// filtered channel would otherwise leave an empty folder sitting behind a chip
// the user has to spot and clear by hand. Every read-state change routes
// through render(), so this is the one place that catches all of them.
function pruneFolderFilters() {
  for (const [folderId, channelId] of state.folderChannelFilter) {
    const folder = findFolder(folderId);
    const ch = folder && (folder.channels || []).find(c => c.channel_id === channelId);
    if (!ch || countUnread(ch) === 0) state.folderChannelFilter.delete(folderId);
  }
}

function render() {
  pruneFolderFilters();
  renderFeed();      // the queue and deep-queue cards render with the feed
  renderPlayer();
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
