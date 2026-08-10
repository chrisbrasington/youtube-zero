'use strict';

/*
 * Mobile action sheet + mobile-UI detection helpers.
 *
 * Classic script. Owns `sheetCtx` (currently visible sheet's context),
 * the open/close/advance flow, and the matchMedia-driven body class
 * toggles that switch the app between desktop and mobile layouts.
 */

let sheetCtx = null;  // {videoId, title, channelName, thumbnailUrl, isRead, inQueue}


function buildSheetCtx(videoId) {
  const meta = videoMeta.get(videoId) || {};
  let isRead = false, inQueue = false;
  for (const ch of allChannels()) {
    const v = (ch.videos || []).find(x => x.video_id === videoId);
    if (v) { isRead = !!v.is_read; inQueue = !!v.in_queue; break; }
  }
  // A video added by URL isn't in any subscribed channel's list, so the feed
  // says nothing about it — the queue itself is the authority on queued state.
  if (!inQueue) inQueue = (state.queue || []).some(q => q.video_id === videoId);
  return {
    videoId,
    title: meta.title || '',
    channelName: meta.channel_name || '',
    thumbnailUrl: meta.thumbnail_url || '',
    isRead, inQueue,
  };
}


function folderVideoSiblings(videoId) {
  const meta = videoMeta.get(videoId);
  if (!meta) return [videoId];
  const chId = meta.channel_id;
  const folder = state.feed.folders.find(f => (f.channels || []).some(c => c.channel_id === chId));
  const channels = folder ? (folder.channels || []) : state.feed.channels.filter(c => c.channel_id === chId);
  const all = channels.flatMap(ch => (ch.videos || []).map(v => ({ v, ch })));
  all.sort((a, b) => (b.v.published_at || '').localeCompare(a.v.published_at || ''));
  const visible = all.filter(({ v, ch }) => !isShort(v, ch) && !v.is_read).map(({ v }) => v.video_id);
  if (visible.includes(videoId)) return visible;
  const allIds = all.filter(({ v, ch }) => !isShort(v, ch)).map(({ v }) => v.video_id);
  if (!allIds.includes(videoId)) allIds.unshift(videoId);
  return allIds;
}


function advanceSheet(dir) {
  if (!sheetCtx) return;
  const siblings = folderVideoSiblings(sheetCtx.videoId);
  if (siblings.length <= 1) return;
  const i = siblings.indexOf(sheetCtx.videoId);
  const next = siblings[((i < 0 ? 0 : i) + dir + siblings.length) % siblings.length];
  openActionSheet(buildSheetCtx(next));
}


function openActionSheet(ctx) {
  sheetCtx = ctx;
  const thumb = $('action-sheet-thumb');
  if (thumb) {
    if (ctx.videoId || ctx.thumbnailUrl) {
      const chain = ctx.videoId
        ? [`https://i.ytimg.com/vi/${ctx.videoId}/maxresdefault.jpg`,
           `https://i.ytimg.com/vi/${ctx.videoId}/sddefault.jpg`,
           `https://i.ytimg.com/vi/${ctx.videoId}/hqdefault.jpg`]
        : [];
      if (ctx.thumbnailUrl) chain.push(ctx.thumbnailUrl);
      let i = 0;
      const tryNext = () => {
        i++;
        if (i < chain.length) thumb.src = chain[i];
        else { thumb.onerror = null; thumb.onload = null; }
      };
      thumb.onerror = tryNext;
      thumb.onload = () => {
        if (i < chain.length - 1 && thumb.naturalWidth > 0 && thumb.naturalWidth < THUMBNAIL_MIN_WIDTH) tryNext();
      };
      thumb.src = chain[0];
      thumb.style.display = '';
    } else {
      thumb.onerror = null;
      thumb.onload = null;
      thumb.removeAttribute('src');
      thumb.style.display = 'none';
    }
  }
  $('action-sheet-title').textContent = ctx.title;
  const btnQ = document.querySelector('[data-action="sheet-queue"]');
  btnQ.textContent = ctx.inQueue ? '✕ Remove from Queue' : '+ Add to Queue';
  const btnM = document.querySelector('[data-action="sheet-mark"]');
  btnM.textContent = ctx.isRead ? '↺ Mark Unread' : '✓ Mark as Read';
  const btnS = document.querySelector('[data-action="sheet-signal"]');
  btnS.style.display = state.signalConfigured ? '' : 'none';
  const btnT = document.querySelector('[data-action="sheet-play-tv"]');
  btnT.style.display = state.tvConfigured ? '' : 'none';
  const castOk = (typeof castAvailable === 'function' && castAvailable());
  const btnScr = document.querySelector('[data-action="sheet-play-screen"]');
  if (btnScr) btnScr.style.display = castOk ? '' : 'none';
  const btnNear = document.querySelector('[data-action="sheet-play-nearest"]');
  if (btnNear) btnNear.style.display = (castOk && typeof ble !== 'undefined' && ble.canScan()) ? '' : 'none';
  const btnC = document.querySelector('[data-action="sheet-copy"]');
  if (btnC) btnC.style.display = ctx.videoId ? '' : 'none';
  $('action-sheet').classList.remove('hidden');
}


function closeActionSheet() {
  $('action-sheet').classList.add('hidden');
  sheetCtx = null;
}


// ── Open the card for a bare video id ────────────────────────────────────────
//
// The id may name something the feed has never heard of (a link someone sent),
// so look the title up first — buildSheetCtx only reads videoMeta and the queue.
// A failed lookup (no API key, offline, private video) is not fatal: the card
// still opens and every action on it works from the id alone.

async function openSheetForVideoId(videoId) {
  if (!videoId) return;
  const known = videoMeta.get(videoId);
  if (!known || !known.title) {
    status('Looking up video…', 'loading');
    try { videoMeta.set(videoId, await api.get(`/api/video-info/${videoId}`)); } catch {}
    status('');
  }
  openActionSheet(buildSheetCtx(videoId));
}


// ── Android share target ─────────────────────────────────────────────────────
//
// The APK opens <page>?share=<videoId> when it's handed a YouTube link (see
// MainActivity.videoIdFromIntent). Read once and strip it from the URL: the
// WebView reloads on error and on process restart, and a card that reappears
// every time the page comes back would be its own bug.

function consumeShareParam() {
  let p;
  try { p = new URLSearchParams(location.search); } catch { return null; }
  const videoId = p.get('share');
  if (!videoId) return null;
  p.delete('share');
  const qs = p.toString();
  try {
    history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : ''));
  } catch {}
  return VIDEO_ID_RE.test(videoId) ? videoId : null;
}


// ── Mobile detection / body-class toggles ────────────────────────────────────

function isMobile() {
  if (state.forceMobile) return true;
  return window.innerWidth <= MOBILE_MAX_WIDTH;
}


function syncMobileUI() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const landscape = matchMedia('(orientation: landscape)').matches;
  const isShort = state.forceMobile || matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`).matches;
  const narrow = isShort && !(coarse && landscape && !state.forceMobile);
  const mobile = state.forceMobile || matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches;
  document.body.classList.toggle('narrow-ui', narrow);
  document.body.classList.toggle('mobile-ui', mobile);
}


function uiPlayerActive() { return !!(player.videoId || state.watch?.active); }
