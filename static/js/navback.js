'use strict';

/*
 * Mobile back-gesture guard + queue-pane open/close helpers.
 *
 * Classic script. On phones the browser back swipe would otherwise leave
 * the feed while a dismissable layer is open. We keep a single sentinel
 * history entry present whenever the in-page watch overlay or the queue
 * pane is showing; a back gesture pops that entry and we close the
 * topmost layer instead of navigating away.
 *
 * Layers, innermost-first: the in-page watch overlay (state.watch.active
 * && inPage) sits above the queue pane (state.queueOpen). Back dismisses
 * the innermost first, re-arming for the next one if any remain.
 *
 * Standalone /watch* routes (inPage === false) and /tv are intentionally
 * NOT guarded — there a back gesture should navigate as usual.
 */

let backGuardArmed = false;
let backGuardConsuming = false;   // true while we pop our own sentinel programmatically


function backGuardLayer() {
  if (state.watch && state.watch.active && state.watch.inPage) return 'watch';
  if (state.queueOpen) return 'queue';
  return null;
}


// Push or pop our sentinel so exactly one is present iff a layer is open.
// Call after any change to queueOpen / the in-page overlay.
function reconcileBackGuard() {
  const open = !!backGuardLayer();
  if (open && !backGuardArmed) {
    backGuardArmed = true;
    history.pushState({ yzBackGuard: true }, '');
  } else if (!open && backGuardArmed) {
    backGuardArmed = false;
    if (history.state && history.state.yzBackGuard) {
      backGuardConsuming = true;
      history.back();
    }
  }
}


window.addEventListener('popstate', () => {
  if (backGuardConsuming) { backGuardConsuming = false; return; }
  const layer = backGuardLayer();
  if (!layer) return;            // not ours — let the navigation stand
  backGuardArmed = false;        // the gesture already popped our sentinel
  if (layer === 'watch') watchExit();
  else closeQueuePane();         // each helper re-arms if another layer remains
});


// ── Queue pane open/close ────────────────────────────────────────────────────
// Single source of truth so every entry point keeps state, storage, the badge,
// and the back-guard in sync.

function openQueuePane() {
  state.queueOpen = true;
  localStorage.setItem('queueOpen', '1');
  $('queue-pane').classList.remove('hidden');
  renderQueueBadge();
  reconcileBackGuard();
}

function closeQueuePane() {
  state.queueOpen = false;
  localStorage.setItem('queueOpen', '0');
  $('queue-pane').classList.add('hidden');
  renderQueueBadge();
  reconcileBackGuard();
}

function toggleQueuePane() {
  if (state.queueOpen) closeQueuePane(); else openQueuePane();
}
