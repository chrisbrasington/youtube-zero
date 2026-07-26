'use strict';

/*
 * Native media bridge — ONLY active inside the Android WebView app, where
 * MainActivity injects `window.AndroidMedia`. In a normal browser (Chrome,
 * Brave) this whole module is a no-op: the browser already gives us background
 * playback and the OS media notification for free. A bare WebView does not, so
 * here we poll the active YouTube player and report its state (playing, title,
 * author, video id) to native, which runs a foreground service + MediaSession so
 * audio keeps playing when the phone is locked/minimized and shows up in the
 * system media controls (with the video thumbnail as artwork).
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

  function inAudioMode() {
    try { return typeof watchIsAudio === 'function' && watchIsAudio(); } catch (e) { return false; }
  }

  // Invoked by native when the user taps the notification / lock-screen controls.
  window.nativeTogglePlay = function () {
    // watchTogglePlay drives whichever player is live; fall back to the raw YT
    // player for the pre-audio-mode paths that don't have a watch session.
    try {
      if (typeof watchTogglePlay === 'function' && typeof state !== 'undefined' && state.watch?.active) {
        watchTogglePlay();
        return;
      }
    } catch (e) {}
    const p = activePlayer(); if (!p) return;
    try { (p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo()); } catch (e) {}
  };

  // Called from MainActivity when the app is backgrounded. The YouTube iframe is
  // suspended within ~70ms of this (measured — see PROSPECTS.md), so hand the
  // session over to the <audio> element, which isn't. One-way on purpose:
  // switching back on every glance at the phone would stutter far more often
  // than it would help.
  window.nativeOnBackground = function () {
    try {
      if (typeof state === 'undefined' || !state.watch?.active) return;
      if (inAudioMode()) return;
      if (typeof watchSetAudioMode === 'function') watchSetAudioMode(true);
    } catch (e) {}
  };
  window.nativeNext = function () {
    try { if (typeof watchAdvance === 'function') watchAdvance({ fromEnd: false }); } catch (e) {}
  };
  window.nativePrev = function () {
    try { if (typeof watchPrev === 'function') watchPrev(); } catch (e) {}
  };

  // Poll the active player and push state changes to native. 1s is plenty for a
  // media notification and avoids having to hook every player's onStateChange.
  // In audio mode the metadata comes from our own list rather than the iframe —
  // there is no getVideoData() to ask.
  function audioSnapshot() {
    const a = document.getElementById('watch-audio');
    if (!a || !a.currentSrc) return null;
    let title = '', artist = '', videoId = '';
    try {
      videoId = state.watch.currentVideoId || '';
      const item = (state.watch.list || []).find(v => v.video_id === videoId);
      if (item) { title = item.title || ''; artist = item.channel_name || ''; }
    } catch (e) {}
    return { playing: !a.paused, active: true, title: title, artist: artist, videoId: videoId };
  }

  let last = '';
  setInterval(function () {
    let playing, active, title = '', artist = '', videoId = '', st = -1;

    const snap = inAudioMode() ? audioSnapshot() : null;
    if (snap) {
      ({ playing, active, title, artist, videoId } = snap);
      st = playing ? 1 : 2;
    } else {
      const p = activePlayer();
      if (p) {
        try {
          st = p.getPlayerState();
          const d = p.getVideoData ? p.getVideoData() : null;
          if (d) { title = d.title || ''; artist = d.author || ''; videoId = d.video_id || ''; }
        } catch (e) {}
      }
      // YT states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
      playing = (st === 1 || st === 3);
      active  = (st === 1 || st === 2 || st === 3);
    }
    const sig = st + '|' + title + '|' + videoId;
    if (sig === last) return;
    last = sig;
    try {
      if (active) AndroidMedia.report(playing, title, artist, videoId);
      else        AndroidMedia.stopped();
    } catch (e) {}
  }, 1000);
})();
