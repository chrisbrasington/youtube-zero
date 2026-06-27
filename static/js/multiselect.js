'use strict';

/*
 * Mobile long-press multi-select for video cards.
 *
 * Classic script. Long-pressing a .video-tile / .video-row on a touch
 * (mobile) device enters selection mode: subsequent taps toggle cards,
 * a fixed bottom bar shows the count plus Play / Cancel. Play adds every
 * selected video to the queue in tap order (the backend appends with an
 * increasing sort_order, so selection order is preserved); Cancel clears.
 *
 * Selection state lives in state.js (state.multiSelect Set, ordered by
 * insertion; state.multiSelectActive). Card clicks are intercepted in the
 * capture phase so the normal open-player / action-sheet handler in
 * events.js never fires while selecting.
 */

let msTouch = null;             // in-flight long-press {pointerId,id,timer,startX,startY}
let msSwallowNextClick = false; // eat the click that ends the activating long-press


function msResolve(el) {
  const card = el.closest('.video-tile, .video-row');
  if (!card) return null;
  const idEl = card.matches('[data-video-id]') ? card : card.querySelector('[data-video-id]');
  const id = idEl?.dataset.videoId;
  return id ? { card, id } : null;
}


// ── Enter / exit / toggle ────────────────────────────────────────────────────

function enterMultiSelect(firstId) {
  state.multiSelectActive = true;
  state.multiSelect.clear();
  if (firstId) state.multiSelect.add(firstId);
  msSwallowNextClick = true;
  document.body.classList.add('multiselect-on');
  msSyncCards();
  msRenderBar();
}

function exitMultiSelect() {
  state.multiSelectActive = false;
  state.multiSelect.clear();
  document.body.classList.remove('multiselect-on');
  msSyncCards();
  msRenderBar();
}

function msToggle(id) {
  if (!id) return;
  if (state.multiSelect.has(id)) state.multiSelect.delete(id);
  else state.multiSelect.add(id);
  if (state.multiSelect.size === 0) { exitMultiSelect(); return; }
  msSyncCards();
  msRenderBar();
}


// ── Visuals ──────────────────────────────────────────────────────────────────

function msSyncCards() {
  const order = [...state.multiSelect];
  document.querySelectorAll('.video-tile, .video-row').forEach(card => {
    const hit = msResolve(card);
    const idx = hit ? order.indexOf(hit.id) : -1;
    card.classList.toggle('ms-selected', idx >= 0);
    let badge = card.querySelector('.ms-badge');
    if (idx >= 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ms-badge';
        card.appendChild(badge);
      }
      badge.textContent = idx + 1;
    } else if (badge) {
      badge.remove();
    }
  });
}

function msBar() {
  let bar = document.getElementById('ms-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ms-bar';
    bar.innerHTML =
      '<span class="ms-count"></span>' +
      '<button class="ms-btn ms-cancel" data-action="ms-cancel">Cancel</button>' +
      '<button class="ms-btn ms-play" data-action="ms-play">▶ Play</button>';
    document.body.appendChild(bar);
    bar.addEventListener('click', e => {
      if (e.target.closest('[data-action="ms-cancel"]')) exitMultiSelect();
      else if (e.target.closest('[data-action="ms-play"]')) msPlay();
    });
  }
  return bar;
}

function msRenderBar() {
  const bar = msBar();
  if (!state.multiSelectActive) { bar.classList.remove('show'); return; }
  const n = state.multiSelect.size;
  bar.querySelector('.ms-count').textContent = `${n} selected`;
  bar.querySelector('.ms-play').disabled = n === 0;
  bar.classList.add('show');
}


// ── Play: queue all selected in tap order ────────────────────────────────────

async function msPlay() {
  const ids = [...state.multiSelect];
  exitMultiSelect();
  if (!ids.length) return;
  status(`Adding ${ids.length} to queue…`, 'loading');
  let added = 0;
  for (const id of ids) {
    const meta = videoMeta.get(id);
    if (!meta) continue;
    try { await api.post('/api/queue', meta); added++; } catch {}
  }
  state.queue = await api.get('/api/queue');
  ids.forEach(id => setInQueue(id, true));
  render();
  status(`Added ${added} to queue`, added ? 'ok' : 'err');
  setTimeout(() => status(''), 2500);
}


// ── Long-press detection (touch / mobile only) ───────────────────────────────

document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch' || !isMobile()) return;
  if (state.multiSelectActive) return;                    // taps handled via click
  if (e.target.closest('#ms-bar')) return;
  const hit = msResolve(e.target);
  if (!hit) return;
  msTouch = {
    pointerId: e.pointerId,
    id: hit.id,
    startX: e.clientX, startY: e.clientY,
    timer: setTimeout(() => {
      msTouch = null;
      enterMultiSelect(hit.id);
      if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
    }, 350),
  };
});

document.addEventListener('pointermove', e => {
  if (!msTouch || e.pointerId !== msTouch.pointerId) return;
  if (Math.hypot(e.clientX - msTouch.startX, e.clientY - msTouch.startY) > 10) {
    clearTimeout(msTouch.timer);
    msTouch = null;
  }
}, { passive: true });

function msCancelTouch(e) {
  if (msTouch && (!e || e.pointerId === msTouch.pointerId)) {
    clearTimeout(msTouch.timer);
    msTouch = null;
  }
}
document.addEventListener('pointerup', msCancelTouch);
document.addEventListener('pointercancel', msCancelTouch);

// Kill the browser's own long-press (context menu / "open image in new tab")
// on cards so it can't hijack or cancel our long-press. Touch only.
document.addEventListener('contextmenu', e => {
  if (e.target.closest('.video-tile, .video-row')) e.preventDefault();
});
document.addEventListener('dragstart', e => {
  if (e.target.closest('.video-tile, .video-row')) e.preventDefault();
});


// ── Intercept card taps while selecting (capture phase, before events.js) ─────

document.addEventListener('click', e => {
  if (!state.multiSelectActive) return;
  if (e.target.closest('#ms-bar')) return;                // bar buttons act normally
  if (!e.target.closest('.video-tile, .video-row')) return;
  e.stopPropagation();
  e.preventDefault();
  if (msSwallowNextClick) { msSwallowNextClick = false; return; }
  const hit = msResolve(e.target);
  if (hit) msToggle(hit.id);
}, true);
