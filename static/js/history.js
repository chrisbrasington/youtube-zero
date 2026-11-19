'use strict';

/*
 * Watch history page (/history).
 *
 * Classic script. Two tabs:
 *   - Watched: watch_history rows, newest first, with a loose case-insensitive search over title + channel and
 * 50-at-a-time pagination.
 *   - Nukes: every past "mark all read" with the full list of videos it swept
 *     (from /api/nukes). Groups expand lazily.
 * Every row, in either tab, has a "+ Queue" button. Clicking a row elsewhere
 * opens the shared mobile action sheet (openActionSheet from sheet.js).
 *
 * Depends on globals: $ (dom.js), api (api.js), state (state.js), esc/escAttr/
 * timeAgo (dom.js), openActionSheet (sheet.js), loadSettings/loadSignalSettings/
 * loadTvSettings (features.js), castRefreshScreens (cast.js).
 */

const HISTORY_PAGE_SIZE = 50;

let historyOffset = 0;
let historyQuery = '';
let historyFolderId = '';
let historyTotal = 0;
let historyItems = [];
let historyDomBound = false;
let historySearchTimer = null;
let historyTab = 'watched';
let nukeList = [];
const nukeDetails = new Map();   // nuke id -> {videos: [...]}
const nukeOpen = new Set();


async function historyBoot() {
  document.body.classList.add('route-history');
  $('history-layout').classList.remove('hidden');
  await loadSettings();
  await loadSignalSettings();   // reveals Signal button in the sheet when configured
  await loadTvSettings();       // reveals TV button in the sheet when configured
  castRefreshScreens();         // reveals "Play on Screen" if a screen is watching
  await historyLoadFolders();
  historyBindDom();
  historyLoad();
}


async function historyLoadFolders() {
  let folders = [];
  try { folders = await api.get('/api/folders'); } catch { return; }
  const sel = $('history-folder');
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = String(f.id);
    opt.textContent = `${f.icon || '📁'} ${f.name}`;
    sel.appendChild(opt);
  }
}


async function historyLoad() {
  const params = new URLSearchParams({
    search: historyQuery,
    limit: String(HISTORY_PAGE_SIZE),
    offset: String(historyOffset),
  });
  if (historyFolderId) params.set('folder_id', historyFolderId);
  try {
    const data = await api.get(`/api/history?${params}`);
    historyItems = data.items || [];
    historyTotal = data.total || 0;
  } catch (e) {
    historyItems = [];
    historyTotal = 0;
    $('history-list').innerHTML = `<div class="queue-empty">Failed to load: ${esc(e.message)}</div>`;
    historyRenderPager();
    return;
  }
  historyRender();
  historyRenderPager();
}


function historyRender() {
  const el = $('history-list');
  if (!historyItems.length) {
    el.innerHTML = `<div class="queue-empty">${historyQuery ? 'No matches' : 'Nothing watched yet'}</div>`;
    return;
  }
  el.innerHTML = historyItems.map(it => historyRowHtml(it, timeAgo(it.watched_at))).join('');
}


/** One video row — shared by the Watched list and every nuke group. */
function historyRowHtml(it, subline) {
  const queued = !!it.in_queue;
  return `
    <div class="q-item" data-history-play data-video-id="${escAttr(it.video_id)}">
      <div class="q-thumb-wrap">
        <img class="q-thumb" src="${escAttr(it.thumbnail_url || '')}" alt=""
             onerror="this.src='data:image/svg+xml,<svg/>'">
        ${it.duration ? `<span class="q-dur">${esc(it.duration)}</span>` : ''}
      </div>
      <div class="q-info">
        <div class="q-title">${esc(it.title || '')}</div>
        <div class="q-channel">${esc(it.channel_name || '')}</div>
        ${subline ? `<div class="q-channel history-watched">${esc(subline)}</div>` : ''}
      </div>
      <div class="history-actions">
        <button class="btn-ghost${queued ? ' queued' : ''}" data-hist-act="queue"
                title="Add to queue" ${queued ? 'disabled' : ''}>${queued ? '✓ Queued' : '＋ Queue'}</button>
        <button class="btn-ghost" data-hist-act="play-here"   title="Play here">▶ Play here</button>
        <button class="btn-ghost" data-hist-act="play-window" title="Open on YouTube in a new tab">↗ New window</button>
        <button class="btn-ghost" data-hist-act="copy"        title="Copy YouTube link">📋 Copy</button>
      </div>
    </div>`;
}


function historyRenderPager() {
  const start = historyTotal ? historyOffset + 1 : 0;
  const end = Math.min(historyOffset + HISTORY_PAGE_SIZE, historyTotal);
  $('history-range').textContent = historyTotal ? `${start}–${end} of ${historyTotal}` : '';
  $('btn-history-prev').disabled = historyOffset <= 0;
  $('btn-history-next').disabled = historyOffset + HISTORY_PAGE_SIZE >= historyTotal;
}


function historyBindDom() {
  if (historyDomBound) return;
  historyDomBound = true;

  $('btn-history-back').addEventListener('click', () => { location.href = '/'; });

  $('history-search').addEventListener('input', e => {
    clearTimeout(historySearchTimer);
    const v = e.target.value;
    historySearchTimer = setTimeout(() => {
      historyQuery = v.trim();
      historyOffset = 0;
      historyLoad();
    }, 250);
  });

  $('history-folder').addEventListener('change', e => {
    historyFolderId = e.target.value;
    historyOffset = 0;
    historyLoad();
  });

  $('btn-history-prev').addEventListener('click', () => {
    if (historyOffset <= 0) return;
    historyOffset = Math.max(0, historyOffset - HISTORY_PAGE_SIZE);
    historyLoad();
  });

  $('btn-history-next').addEventListener('click', () => {
    if (historyOffset + HISTORY_PAGE_SIZE >= historyTotal) return;
    historyOffset += HISTORY_PAGE_SIZE;
    historyLoad();
  });

  $('history-list').addEventListener('click', e => {
    const row = e.target.closest('[data-history-play]');
    if (!row) return;
    const it = historyItems.find(x => x.video_id === row.dataset.videoId);
    if (it) historyRowClick(e, row, it);
  });

  $('nuke-list').addEventListener('click', e => {
    const head = e.target.closest('[data-nuke-toggle]');
    if (head) { nukeToggle(Number(head.dataset.nukeToggle)); return; }
    const row = e.target.closest('[data-history-play]');
    if (!row) return;
    const group = row.closest('[data-nuke-id]');
    const detail = group && nukeDetails.get(Number(group.dataset.nukeId));
    const it = detail && detail.videos.find(x => x.video_id === row.dataset.videoId);
    if (it) historyRowClick(e, row, it);
  });

  document.querySelectorAll('[data-history-tab]').forEach(btn => {
    btn.addEventListener('click', () => historySetTab(btn.dataset.historyTab));
  });
}


function historyRowClick(e, row, it) {
  // Per-row quick actions take priority over the card → action-sheet click.
  const act = e.target.closest('[data-hist-act]');
  if (act) {
    const url = `https://www.youtube.com/watch?v=${it.video_id}`;
    if (act.dataset.histAct === 'queue')       historyQueue(it, act);
    if (act.dataset.histAct === 'play-here')   openPlayer(it.video_id, it.title || '');
    if (act.dataset.histAct === 'play-window') window.open(url, '_blank', 'noopener,noreferrer');
    if (act.dataset.histAct === 'copy')        historyCopy(url);
    return;
  }

  openActionSheet({
    videoId: it.video_id,
    title: it.title || '',
    channelName: it.channel_name || '',
    thumbnailUrl: it.thumbnail_url || '',
    isRead: false,
    inQueue: !!it.in_queue,
  });
}


/** Send one video (from either tab) to the end of the main queue. */
async function historyQueue(it, btn) {
  if (it.in_queue) return;
  btn.disabled = true;
  try {
    await api.post('/api/queue', {
      video_id: it.video_id,
      channel_id: it.channel_id || '',
      channel_name: it.channel_name || '',
      title: it.title || '',
      thumbnail_url: it.thumbnail_url || '',
      published_at: it.published_at || '',
    });
    it.in_queue = true;
    // Same video can appear in several nukes / the watched list — mark them all.
    for (const d of nukeDetails.values()) {
      for (const v of d.videos) if (v.video_id === it.video_id) v.in_queue = true;
    }
    document.querySelectorAll(
      `[data-history-play][data-video-id="${CSS.escape(it.video_id)}"] [data-hist-act="queue"]`
    ).forEach(b => { b.disabled = true; b.classList.add('queued'); b.textContent = '✓ Queued'; });
  } catch (e) {
    btn.disabled = false;
    alert('Could not queue: ' + e.message);
  }
}


// ── Nukes tab ────────────────────────────────────────────────────────────────

function historySetTab(tab) {
  historyTab = tab;
  document.querySelectorAll('[data-history-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.historyTab === tab));
  $('history-watched-view').classList.toggle('hidden', tab !== 'watched');
  $('history-nukes-view').classList.toggle('hidden', tab !== 'nukes');
  if (tab === 'nukes') nukeLoad();
  else historyLoad();   // refresh queued state after queueing from a nuke
}


async function nukeLoad() {
  const el = $('nuke-list');
  try {
    const data = await api.get('/api/nukes?limit=200');
    nukeList = data.items || [];
  } catch (e) {
    el.innerHTML = `<div class="queue-empty">Failed to load: ${esc(e.message)}</div>`;
    return;
  }
  nukeDetails.clear();
  // Re-fetch any group left open so its queued flags are current.
  await Promise.all([...nukeOpen].map(id => nukeFetch(id)));
  nukeRender();
}


async function nukeFetch(id) {
  try { nukeDetails.set(id, await api.get(`/api/nukes/${id}`)); }
  catch { nukeOpen.delete(id); }
}


async function nukeToggle(id) {
  if (nukeOpen.has(id)) {
    nukeOpen.delete(id);
  } else {
    nukeOpen.add(id);
    if (!nukeDetails.has(id)) await nukeFetch(id);
  }
  nukeRender();
}


function nukeRender() {
  const el = $('nuke-list');
  if (!nukeList.length) {
    el.innerHTML = '<div class="queue-empty">No nukes recorded yet</div>';
    return;
  }
  el.innerHTML = nukeList.map(n => {
    const open = nukeOpen.has(n.id);
    const detail = nukeDetails.get(n.id);
    const when = new Date(n.nuked_at);
    const label = isNaN(when) ? n.nuked_at : when.toLocaleString();
    const body = !open ? '' : !detail ? '<div class="queue-empty">Loading…</div>'
      : !detail.videos.length ? '<div class="queue-empty">Nothing was unread</div>'
      : detail.videos.map(v => historyRowHtml(v, v.published_at ? `published ${timeAgo(v.published_at)}` : '')).join('');
    return `
      <div class="nuke-group${open ? ' open' : ''}" data-nuke-id="${n.id}">
        <button class="nuke-head" data-nuke-toggle="${n.id}">
          <span class="nuke-caret">▸</span>
          <span class="nuke-when">☢ ${esc(label)}</span>
          <span class="nuke-meta">${n.video_count} video${n.video_count === 1 ? '' : 's'} · ${esc(timeAgo(n.nuked_at))}${n.source ? ' · ' + esc(n.source) : ''}</span>
        </button>
        ${open ? `<div class="nuke-videos">${body}</div>` : ''}
      </div>`;
  }).join('');
}


function historyCopy(text) {
  copyText(text);   // dom.js — native bridge / focus-safe fallbacks
}
