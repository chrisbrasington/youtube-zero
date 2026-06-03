'use strict';

/*
 * Mobile touch gestures: pull-to-refresh, swipe-to-dismiss, action-sheet
 * left/right swipe to advance.
 *
 * Classic script, loaded after app.js. Each gesture is wired in its own
 * IIFE so its `startX/startY/etc.` state stays local instead of leaking
 * to module scope.
 */


// ── Pull-to-refresh (top of channels pane) ───────────────────────────────────

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


// ── Swipe-right on a video tile/row to mark read ─────────────────────────────

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


// ── Flick a queue item UP to send it to the nearest screen ───────────────────

(function setupQueueFlickUp() {
  const THRESHOLD = 80;   // px of upward travel to trigger
  let item = null, vid = null, startX = 0, startY = 0, dx = 0, dy = 0, axis = null;

  function pick(target) {
    // Start only from the thumbnail, leaving the rest of the row for scroll/drag.
    const wrap = target.closest('.q-thumb-wrap');
    if (!wrap) return null;
    const q = wrap.closest('.q-item');
    return q ? { el: q, vid: q.dataset.videoId } : null;
  }

  document.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    const m = pick(e.target);
    if (!m || !m.vid) return;
    item = m.el; vid = m.vid;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = dy = 0; axis = null;
    item.style.transition = '';
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!item) return;
    dx = e.touches[0].clientX - startX;
    dy = e.touches[0].clientY - startY;
    if (axis === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    }
    // Only commit (and block scroll) for an upward y-axis drag.
    if (axis === 'y' && dy < 0) {
      if (e.cancelable) e.preventDefault();
      const up = Math.min(-dy, 120);
      item.style.transform = `translateY(${-up}px)`;
      item.style.opacity = String(Math.max(0.4, 1 + dy / 300));
    }
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!item) return;
    const el = item, id = vid;
    const fire = (axis === 'y' && dy <= -THRESHOLD);
    el.style.transition = 'transform .18s, opacity .18s';
    el.style.transform = '';
    el.style.opacity = '';
    item = null; vid = null;
    if (fire && typeof flingToNearest === 'function') flingToNearest(id);
  }, { passive: true });
})();


// ── Action-sheet thumbnail swipe to advance previous/next ────────────────────

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
