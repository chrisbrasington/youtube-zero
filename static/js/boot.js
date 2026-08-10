'use strict';

/*
 * Application boot. Loaded LAST so every function referenced here is
 * already defined by the time the IIFE invokes them.
 *
 * Branches: if the URL matches a /watch* route, hand off to the watch
 * overlay's standalone bootstrap. Otherwise, do the standard feed boot
 * sequence — settings/signal/tv reconciliation, EventSource subscribe,
 * visibility-resume hook.
 *
 * /<videoId> is not a branch: it's the feed with a video already open, so it
 * runs the same sequence and then opens the overlay on top. ?share=<videoId>
 * (the phone APK's YouTube-link hand-off) is the same idea — the route boots
 * normally and the action card opens over it.
 */

(async () => {
  loadAutoRefreshPrefs();
  syncAutoRefresh();

  if (location.pathname.replace(/\/+$/, '') === '/history') {
    await historyBoot();
    return;
  }

  if (location.pathname.replace(/\/+$/, '') === '/admin') {
    await adminBoot();
    return;
  }

  // A YouTube link opened into the phone APK arrives as ?share=<videoId>. Read it
  // before any route branches — the route decides what to boot, this only decides
  // what to put on top of it once it's up.
  const shared = consumeShareParam();

  const route = watchRouteFor(location.pathname);
  if (route) {
    if (route.mode === 'tv') { await tvEnter(); return; }
    if (route.mode === 'phone') {
      await tvEnter('phone');
      // After tvEnter, so the queue is loaded: it's what tells the card whether
      // this video is already queued (Add vs Remove).
      if (shared) await openSheetForVideoId(shared);
      return;
    }
    if (route.mode === 'cast-receiver') { castReceiverEnter(); return; }
    await watchBootUrl(route);
    return;
  }

  updateQuota();
  await loadAll();            // build UI with state from localStorage
  await loadSettings();       // reconcile DB → re-render only if value changed
  await loadSignalSettings(); // check Signal config, show/hide send buttons
  await loadTvSettings();
  render();                   // re-render so TV buttons appear once configured
  castRefreshScreens();       // discover any watching screens, reveal cast controls
  connectEventSource();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > 60_000) {
      loadAll();
    }
  });

  // A bare /<videoId> — someone reopened a link to something that was playing.
  // The feed is already up behind it; the queue load above decides whether the
  // video still has a queue to play inside of.
  const videoId = videoIdFromPath(location.pathname);
  if (videoId) await watchBootVideo(videoId);

  // Same share hand-off on the plain feed route — the phone flavor points at
  // /phone today, but this is also how ?share= is testable in a browser.
  if (shared) await openSheetForVideoId(shared);
})();
