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
  hideShorts:       localStorage.getItem('hideShorts') === '1',  // sync read, no async needed
  wrapStrip:        (localStorage.getItem('wrapStrip') ?? '1') === '1',
  forceMobile:      localStorage.getItem('forceMobile') === '1',
  // Browse is the default. Manage reveals add/rename/delete/mute/reorder —
  // a client preference, so localStorage owns it (no server round-trip).
  manageMode:       localStorage.getItem('manageMode') === '1',
  manualExpand:     new Set(),
  // Explicit per-folder view choice, overriding the unread-based default.
  // 'collapsed' (title row only) | 'compact' (video strip) | 'expanded' (per channel)
  folderView:       new Map(),
  // folderId -> channel_id: narrows a folder's mixed strip to one channel.
  folderChannelFilter: new Map(),
  signalConfigured: false,
  tvConfigured:     false,
  quickQueueMode:   false,
  quickQueueVideos: [],
};

const player = {
  videoId:      null,
  title:        '',
  mode:         'normal',
  queueVideoId: null,
};

const videoMeta = new Map();


// ── Server video: server offers it, client may decline ───────────────────────
//
// window.SERVER_VIDEO says whether the box is willing to remux. That stays a
// server-wide setting — it's a property of the box. But a client can opt out:
// the TV APK wants the YouTube embed every time, since the TV isn't going to
// background the player and the embed gives it captions.
//
// ?server_video=0 records the refusal in localStorage so it survives every
// later load (the APK's URL carries it; a browser can set it once by hand).
// ?server_video=auto clears the override and goes back to following the server.
//
// The override is one-way on purpose: a client can't turn server video *on*
// when the server has it off, because the endpoints aren't there to call.
(function captureServerVideoParam() {
  const p = new URLSearchParams(location.search).get('server_video');
  if (p === null) return;
  if (p === 'auto') localStorage.removeItem('serverVideo');
  else localStorage.setItem('serverVideo', (p === '0' || p === 'false') ? '0' : '1');
})();

function serverVideoOn() {
  return !!window.SERVER_VIDEO && localStorage.getItem('serverVideo') !== '0';
}

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
  const chosen = state.folderView.get(folder.id);
  if (chosen) return chosen;
  // On a phone one folder's video strip is most of the screen, so folders
  // start as one-line rows — tap the one you actually want.
  //
  // Only a real TV is excluded: its D-pad grid navigates video tiles, so
  // collapsing would leave nothing to move through. The /phone flavor also
  // carries route-tv (it reuses that UI) but is a touchscreen, so it collapses
  // like any other phone.
  // route-phone is trusted directly rather than leaning on isMobile(): that
  // reads window.innerWidth, and the app's WebView runs a desktop UA with a
  // wide viewport, so the width is not something to bet this on.
  const isPhoneApp = document.body.classList.contains('route-phone');
  const isTvScreen = document.body.classList.contains('route-tv') && !isPhoneApp;
  if ((isMobile() || isPhoneApp) && !isTvScreen) return 'collapsed';
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
