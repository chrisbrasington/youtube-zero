'use strict';

/*
 * Watch history page (/history).
 *
 * Classic script. Lists watched queue items (queue.watched_at IS NOT NULL),
 * newest first, with a loose case-insensitive search over title + channel and
 * 50-at-a-time pagination. Clicking a row opens the shared mobile action sheet
 * (openActionSheet from sheet.js) so play-here / TV / screen / copy all work.
 *
 * Depends on globals: $ (dom.js), api (api.js), state (state.js), esc/escAttr/
 * timeAgo (dom.js), openActionSheet (sheet.js), loadSettings/loadSignalSettings/
 * loadTvSettings (features.js), castRefreshScreens (cast.js).
 */

const HISTORY_PAGE_SIZE = 50;

let historyOffset = 0;
let historyQuery = '';
let historyTotal = 0;
let historyItems = [];
let historyDomBound = false;
let historySearchTimer = null;


async function historyBoot() {
  document.body.classList.add('route-history');
  $('history-layout').classList.remove('hidden');
  await loadSettings();
  await loadSignalSettings();   // reveals Signal button in the sheet when configured
  await loadTvSettings();       // reveals TV button in the sheet when configured
  castRefreshScreens();         // reveals "Play on Screen" if a screen is watching
  historyBindDom();
  historyLoad();
}


async function historyLoad() {
  const params = new URLSearchParams({
    search: historyQuery,
    limit: String(HISTORY_PAGE_SIZE),
    offset: String(historyOffset),
  });
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
  el.innerHTML = historyItems.map(it => `
    <div class="q-item" data-history-play data-video-id="${escAttr(it.video_id)}">
      <div class="q-thumb-wrap">
        <img class="q-thumb" src="${escAttr(it.thumbnail_url)}" alt=""
             onerror="this.src='data:image/svg+xml,<svg/>'">
        ${it.duration ? `<span class="q-dur">${esc(it.duration)}</span>` : ''}
      </div>
      <div class="q-info">
        <div class="q-title">${esc(it.title)}</div>
        <div class="q-channel">${esc(it.channel_name)}</div>
        <div class="q-channel history-watched">${esc(timeAgo(it.watched_at))}</div>
      </div>
    </div>`).join('');
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
    if (!it) return;
    openActionSheet({
      videoId: it.video_id,
      title: it.title || '',
      channelName: it.channel_name || '',
      thumbnailUrl: it.thumbnail_url || '',
      isRead: false,
      inQueue: false,
    });
  });
}
