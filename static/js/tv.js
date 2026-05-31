'use strict';

/*
 * TV mode (/tv).
 *
 * Classic script. One page that is three things at once:
 *   1. the browse feed (same render as /), locked to browse-and-play only and
 *      to unwatched content (lockdown is CSS keyed on body.route-tv +
 *      renderFeed's filter; play is forced "here" in events.js/wire.js);
 *   2. a cast receiver — registers as a screen ("Living Room TV") so a phone at
 *      / can "Play on Screen" and take it over (reuses cast.js wholesale);
 *   3. fully D-pad navigable — the APK forwards remote keys to castKey()
 *      (cast.js), which delegates here when no player overlay is open.
 *
 * This module owns only the /tv entry point and the browse-feed focus grid.
 * It launches playback through the existing entry points (randomPlay,
 * watchStart*, openPlayer) rather than duplicating any of that logic — a
 * focused element is activated by simply dispatching its native click.
 *
 * Globals used (resolved at call time): state, $, render, loadAll,
 * loadSettings, connectEventSource, shallowQueue, castGetScreenId,
 * castGetScreenName, castConnectReceiver, castPollStatus, castStatusTimer,
 * castScreenId, castIsTv (cast.js).
 */


// ── Boot ─────────────────────────────────────────────────────────────────────

async function tvEnter() {
  document.body.classList.add('route-tv');

  // Act as a screen, exactly like the /watch receiver does.
  castScreenId = castGetScreenId();
  castConnectReceiver();
  castStatusTimer = setInterval(castPollStatus, 1000);

  // Mount the browse UI (mirrors the main-feed boot; configurable extras like
  // Signal/TV-send stay off — their buttons are hidden in TV mode anyway).
  if (state.queueOpen) $('queue-pane').classList.remove('hidden');
  await loadAll();
  await loadSettings();
  render();
  connectEventSource();
  castRefreshScreens();   // discover already-playing screens → resume/pull/transfer bar

  const nameEl = $('tv-ready-name');
  if (nameEl) nameEl.textContent = castGetScreenName();

  tvNav.init();
}


// ── Browse-feed focus grid ─────────────────────────────────────────────────────
//
// A row/column cursor over the live feed DOM, rebuilt on each move so it always
// matches what's rendered. Rows: a controls row, then one row per video strip
// (folder ▶ first, then its tiles), then the queue items.

const tvNav = {
  row: 0,
  col: 0,

  // Ordered rows of focusable elements, derived from the current DOM. The
  // vertical flow reads like the page: a folder's "play everything" header,
  // then that folder's video rows, then the next folder, etc.
  rows() {
    const rows = [];

    const controls = [$('btn-random'), $('btn-queue')];
    if (state.queueOpen && shallowQueue().length) controls.push($('btn-watch-queue'));
    rows.push(controls.filter(Boolean));

    document.querySelectorAll('#channels-list .folder-card, #channels-list .channel-card')
      .forEach(card => {
        // A folder gets its own row (the whole header highlights; OK plays it
        // all). Channels have no play-all, so they're only their video rows.
        const header = card.querySelector('.folder-header');
        if (header && card.querySelector('[data-action="watch-folder"]')) rows.push([header]);
        const strip = card.querySelector('.video-strip');
        if (strip) this.tileRows(strip).forEach(r => rows.push(r));
      });

    if (state.queueOpen) {
      document.querySelectorAll('[data-action="play-from-queue"]')
        .forEach(item => rows.push([item]));
    }

    return rows.filter(r => r.length);
  },

  // Split a strip's tiles into the visual rows they wrap into, so Up/Down steps
  // line by line. A horizontally-scrolling strip yields a single row.
  tileRows(strip) {
    const tiles = [...strip.querySelectorAll('[data-action="open-player"]')];
    const rows = [];
    let top = null, cur = null;
    for (const t of tiles) {
      const y = Math.round(t.getBoundingClientRect().top);
      if (cur === null || Math.abs(y - top) > 4) { cur = []; rows.push(cur); top = y; }
      cur.push(t);
    }
    return rows;
  },

  init() {
    this.row = 0;
    this.col = 0;
    this.render();
  },

  move(dir) {
    const rows = this.rows();
    if (!rows.length) return;
    this.row = Math.min(Math.max(this.row, 0), rows.length - 1);
    if (dir === 'up')    this.row = Math.max(0, this.row - 1);
    if (dir === 'down')  this.row = Math.min(rows.length - 1, this.row + 1);
    if (dir === 'left')  this.col = Math.max(0, this.col - 1);
    if (dir === 'right') this.col = this.col + 1;
    this.col = Math.min(this.col, rows[this.row].length - 1);
    this.render(rows);
  },

  // Activate the focused element by dispatching its real click — every target
  // (random, queue toggle, watch-queue, folder ▶, video tile, queue item) is
  // already wired, and on /tv those handlers play here.
  select() {
    const el = this.current();
    if (!el) return;
    if (el.classList.contains('folder-header')) {            // folder row → play it all
      el.closest('.folder-card')?.querySelector('[data-action="watch-folder"]')?.click();
      return;
    }
    el.click();
  },

  current(rows) {
    rows = rows || this.rows();
    const row = rows[this.row];
    return row ? row[this.col] : null;
  },

  render(rows) {
    rows = rows || this.rows();
    document.querySelectorAll('.dpad-focus').forEach(el => el.classList.remove('dpad-focus'));
    const el = this.current(rows);
    if (!el) return;
    el.classList.add('dpad-focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },

  // Re-apply the ring after the feed re-renders (called from renderFeed).
  refocus() {
    if (!castIsTv() || state.watch?.active) return;
    this.render();
  },
};


// Called by castKey() (cast.js) for D-pad input while browsing /tv.
function tvBrowseKey(name) {
  if (name === 'ok') return tvNav.select();
  tvNav.move(name);
}

// Hook for renderFeed() — keep the function-with-typeof-guard pattern used by
// watchRenderQueue()/castNavReRender().
function tvRefocus() {
  tvNav.refocus();
}
