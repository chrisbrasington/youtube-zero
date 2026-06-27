'use strict';

/*
 * Application boot. Loaded LAST so every function referenced here is
 * already defined by the time the IIFE invokes them.
 *
 * Branches: if the URL matches a /watch* route, hand off to the watch
 * overlay's standalone bootstrap. Otherwise, do the standard feed boot
 * sequence — settings/signal/tv reconciliation, EventSource subscribe,
 * visibility-resume hook.
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

  const route = watchRouteFor(location.pathname);
  if (route) {
    if (route.mode === 'tv') { await tvEnter(); return; }
    if (route.mode === 'phone') { await tvEnter('phone'); return; }
    if (route.mode === 'cast-receiver') { castReceiverEnter(); return; }
    await watchBootUrl(route);
    return;
  }

  updateQuota();
  if (state.queueOpen) { $('queue-pane').classList.remove('hidden'); reconcileBackGuard(); }
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
})();
