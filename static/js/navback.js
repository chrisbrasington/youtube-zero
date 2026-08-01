'use strict';

/*
 * Mobile back-gesture guard.
 *
 * Classic script. On phones the browser back swipe would otherwise leave
 * the feed while a dismissable layer is open. We keep a single sentinel
 * history entry present whenever the in-page watch overlay is showing; a
 * back gesture pops that entry and we close the overlay instead of
 * navigating away.
 *
 * The queue used to be a second layer here, back when it was a slide-over
 * pane. It's a card in the feed now, so there's nothing to dismiss — back
 * from the feed should just go back.
 *
 * Standalone /watch* routes (inPage === false) and /tv are intentionally
 * NOT guarded — there a back gesture should navigate as usual.
 */

let backGuardArmed = false;
let backGuardConsuming = false;   // true while we pop our own sentinel programmatically


function backGuardLayer() {
  if (state.watch && state.watch.active && state.watch.inPage) return 'watch';
  return null;
}


// Push or pop our sentinel so exactly one is present iff a layer is open.
// Call after any change to the in-page overlay.
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
  if (!backGuardLayer()) {
    // Nothing of ours is open. One case still needs handling: going forward
    // back into a /<videoId> entry after backing out of it. Reopen the video —
    // otherwise the feed sits there under a video URL, looking broken.
    const vid = videoIdFromPath(location.pathname);
    if (vid && !state.watch) watchBootVideo(vid);
    return;                        // otherwise not ours — let the navigation stand
  }
  backGuardArmed = false;          // the gesture already popped our sentinel
  watchExit();
});
