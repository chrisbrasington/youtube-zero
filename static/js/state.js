'use strict';

/*
 * Frontend application state + read-only accessors.
 *
 * Classic script. Defines `state`, `player`, `videoMeta`, and the
 * `dragSrc*` globals plus pure read-helpers (allChannels, findChannel,
 * findFolder, channelViewMode, folderViewMode, countUnread,
 * folderUnreadCount, isShort).
 *
 * Mutations happen directly on `state.*` from action handlers in app.js.
 * A proper StateManager with subscriptions is a future refactor.
 */

const state = {
  feed:             { folders: [], channels: [] },
  queue:            [],
  queueOpen:        localStorage.getItem('queueOpen') === '1',
  deepOpen:         localStorage.getItem('deepOpen') === '1',
  sortMode:         'manual',
  hideShorts:       localStorage.getItem('hideShorts') === '1',  // sync read, no async needed
  wrapStrip:        (localStorage.getItem('wrapStrip') ?? '1') === '1',
  forceMobile:      localStorage.getItem('forceMobile') === '1',
  manualExpand:     new Set(),
  folderExpand:     new Set(),
  signalConfigured: false,
  tvConfigured:     false,
  multiSelect:      new Set(),   // mobile long-press selection, in tap order
  multiSelectActive: false,
};

const player = {
  videoId:      null,
  title:        '',
  mode:         'normal',
  queueVideoId: null,
};

const videoMeta = new Map();

// Drag/drop sources — set on dragstart, read in dragover/drop handlers.
let dragSrcId       = null;
let dragSrcType     = null;   // 'folder' | 'channel'
let dragSrcFolderId = null;   // current folder_id of the dragged channel


// ── Video classification ─────────────────────────────────────────────────────

function isShort(video, channel) {
  if (!state.hideShorts) return false;
  if (channel && channel.allow_shorts) return false;
  if (video.is_live && video.is_live !== 'none') return false;
  if (!video.duration) return false;
  const parts = video.duration.split(':').map(Number);
  const secs = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + (parts[1] || 0);
  return secs > 0 && secs < SHORTS_MAX_SECONDS;
}


// ── Read-only feed accessors ─────────────────────────────────────────────────

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


// ── View-mode rules (compact / expanded / collapsed) ─────────────────────────

function channelViewMode(channel) {
  const id = channel.channel_id;
  if (state.manualExpand.has(id)) return 'expanded';
  return (channel.videos || []).some(v => !v.is_read && !isShort(v, channel)) ? 'compact' : 'collapsed';
}


function folderViewMode(folder) {
  const id = folder.id;
  if (state.folderExpand.has(id)) return 'expanded';
  const hasUnread = (folder.channels || []).some(ch =>
    (ch.videos || []).some(v => !v.is_read && !isShort(v, ch))
  );
  return hasUnread ? 'compact' : 'collapsed';
}


// ── Unread counts ────────────────────────────────────────────────────────────

function countUnread(channel) {
  return (channel.videos || []).filter(v => !v.is_read && !isShort(v, channel)).length;
}


function folderUnreadCount(folder) {
  return (folder.channels || []).reduce((n, ch) => n + countUnread(ch), 0);
}
