'use strict';

/*
 * Native media bridge — ONLY active inside the Android WebView app, where
 * MainActivity injects `window.AndroidMedia`. In a normal browser (Chrome,
 * Brave) this whole module is a no-op: the browser already gives us background
 * playback and the OS media notification for free. A bare WebView does not, so
 * here we poll the active YouTube player and report its state to native, which
 * runs a foreground service + MediaSession so audio keeps playing when the
 * phone is locked/minimized and shows up in the system media controls.
 *
 * Classic script (shared scope) — references ytPlayer (keys.js) and
 * watchPlayer / watchAdvance / watchPrev (watch.js) by name. Loaded after them.
 */

(function () {
  if (!window.AndroidMedia) return;   // not the app → let the browser handle it

  function activePlayer() {
    const candidates = [
      (typeof watchPlayer !== 'undefined' ? watchPlayer : null),
      (typeof ytPlayer    !== 'undefined' ? ytPlayer    : null),
    ];
    for (const p of candidates) {
      try { if (p && typeof p.getPlayerState === 'function') return p; } catch (e) {}
    }
    return null;
  }

  // Invoked by native when the user taps the notification / lock-screen controls.
  window.nativeTogglePlay = function () {
    const p = activePlayer(); if (!p) return;
    try { (p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo()); } catch (e) {}
  };
  window.nativeNext = function () {
    try { if (typeof watchAdvance === 'function') watchAdvance({ fromEnd: false }); } catch (e) {}
  };
  window.nativePrev = function () {
    try { if (typeof watchPrev === 'function') watchPrev(); } catch (e) {}
  };

  // Poll the active player and push state changes to native. 1s is plenty for a
  // media notification and avoids having to hook every player's onStateChange.
  let last = '';
  setInterval(function () {
    const p = activePlayer();
    let st = -1, title = '', artist = '';
    if (p) {
      try {
        st = p.getPlayerState();
        const d = p.getVideoData ? p.getVideoData() : null;
        if (d) { title = d.title || ''; artist = d.author || ''; }
      } catch (e) {}
    }
    // YT states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    const playing = (st === 1 || st === 3);
    const active  = (st === 1 || st === 2 || st === 3);
    const sig = st + '|' + title;
    if (sig === last) return;
    last = sig;
    try {
      if (active) AndroidMedia.report(playing, title, artist);
      else        AndroidMedia.stopped();
    } catch (e) {}
  }, 1000);
})();
