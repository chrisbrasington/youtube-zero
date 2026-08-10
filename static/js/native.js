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

  // Explicit play/pause for the MediaSession transport callbacks.
  //
  // These used to all route to nativeTogglePlay, which meant a *pause* command
  // from the system would flip us to playing whenever the page and the session
  // disagreed about the current state — an oscillation you could hear.
  function setPlaying(want) {
    try {
      if (typeof watchIsPlaying !== 'function' || typeof watchTogglePlay !== 'function') return;
      if (watchIsPlaying() !== want) watchTogglePlay();
    } catch (e) {}
  }
  window.nativePlay  = function () { setPlaying(true); };
  window.nativePause = function () { setPlaying(false); };

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

  // Called from MainActivity.onStop — the app is backgrounded or the screen is
  // locked. The YouTube iframe is suspended within ~70ms of this (measured, see
  // PROSPECTS.md), so hand the session to the <audio> element, which isn't.
  //
  // Not persisted: this is our decision, not the user's. Writing it to the
  // stored preference meant one pocketed phone left every later session in
  // audio mode.
  window.nativeOnBackground = function () {
    try {
      if (typeof state === 'undefined' || !state.watch?.active) {
        console.log('BGDBG onBackground: no active watch'); return;
      }
      console.log('BGDBG onBackground server=' + !!state.watch.server
        + ' audio=' + inAudioMode() + ' audioAuto=' + !!state.watch.audioAuto);
      if (inAudioMode()) return;
      // Both transports end up in the same place: hand over to <audio>, which
      // Chromium lets run in the background. Trying to keep a <video> alive
      // here was measured and abandoned: Chromium re-pauses a backgrounded
      // <video> every ~6s indefinitely, so a keep-alive is a permanent fight.
      if (typeof watchSetAudioMode === 'function') {
        watchSetAudioMode(true, { persist: false, auto: true });
      }
    } catch (e) {}
  };

  // Called from MainActivity.onStart. Undo *our* switch only — if the user
  // chose audio mode themselves, leave it alone.
  window.nativeOnForeground = function () {
    try {
      if (typeof state === 'undefined' || !state.watch?.active) return;
      console.log('BGDBG onForeground audioAuto=' + !!state.watch.audioAuto);
      if (!state.watch.audioAuto) return;
      if (typeof watchSetAudioMode === 'function') {
        watchSetAudioMode(false, { persist: false });
      }
    } catch (e) {}
  };
  // Called from MainActivity.onNewIntent — a YouTube link was opened or shared
  // into the already-running app. Open the action card over whatever is on
  // screen; reloading the page for it would stop playback.
  //
  // Existence is the feature test: MainActivity checks `typeof nativeOpenVideo`
  // and falls back to loading ?share=<id> when an older web deploy lacks it.
  window.nativeOpenVideo = function (videoId) {
    try {
      if (typeof closeActionSheet === 'function' && sheetCtx) closeActionSheet();
      openSheetForVideoId(videoId);
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
  function mediaSnapshot() {
    const a = document.getElementById('watch-audio');
    const v = document.getElementById('watch-video');
    const el = (a && a.currentSrc) ? a : (v && v.currentSrc) ? v : null;
    if (!el) return null;
    let title = '', artist = '', videoId = '';
    try {
      videoId = state.watch.currentVideoId || '';
      const item = (state.watch.list || []).find(v => v.video_id === videoId);
      if (item) { title = item.title || ''; artist = item.channel_name || ''; }
    } catch (e) {}
    return { playing: !el.paused, active: true, title: title, artist: artist, videoId: videoId };
  }

  function onSameOriginElement() {
    try { return inAudioMode() || !!state.watch?.server; } catch (e) { return false; }
  }

  let last = '';
  setInterval(function () {
    let playing, active, title = '', artist = '', videoId = '', st = -1;

    const snap = onSameOriginElement() ? mediaSnapshot() : null;
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
