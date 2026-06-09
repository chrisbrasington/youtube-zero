'use strict';

/*
 * Global keyboard shortcuts + YouTube IFrame API bootstrap.
 *
 * Classic script. Owns the YT player wrapper (`ytPlayer`) used by the
 * in-page overlay so we can control playback from keyboard without
 * losing focus to the iframe.
 *
 * Keys (active when no watch overlay is open):
 *   r        — play a random visible video
 *   Shift+R  — random across queue + visible feed
 *   q        — toggle queue pane
 *   Shift+Q  — open queue and play first item
 *   1..9     — play first video of Nth row
 *   Shift+1..9 — play Nth shallow queue item
 *   w        — start binge-watch from queue
 *   Escape   — close queue
 *
 * Inside player: Escape close, f fullscreen, t theater, y open in YT,
 * m mark read/unread, q/Q toggle queue, n/p next/prev, s Signal,
 * Enter→TV, 0-9 seek, space/k play-pause, j/l seek ±10, arrows seek ±5.
 */

// YouTube IFrame API — lets us control playback without iframe focus stealing keys
let ytPlayer = null;
let ytApiReady = false;
let ytLoadedId = null;
window.onYouTubeIframeAPIReady = () => { ytApiReady = true; };
(function loadYTApi() {
  if (document.querySelector('script[src*="youtube.com/iframe_api"]')) return;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
})();

function setupYTPlayer() {
  if (!window.YT || !window.YT.Player) {
    setTimeout(setupYTPlayer, 200);
    return;
  }
  if (ytPlayer) return;  // already bound to iframe
  ytPlayer = new YT.Player('player-frame', {});
}


document.addEventListener('keydown', e => {
  if (state.watch?.active) return;
  if (e.target.matches('input,textarea')) return;
  const mod = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;

  // Global: random play
  if (!mod && !uiPlayerActive() && e.key === 'r') {
    randomPlay();
    return;
  }

  // Global: Shift+R → random across queue + visible feed
  if (!uiPlayerActive() && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'R') {
    const queueItems = state.queue.map(q => ({
      video_id: q.video_id, title: q.title, queue_id: q.video_id, source: 'queue',
    }));
    // Reuse visiblePlayList logic for feed without queue precedence
    const feedItems = (function() {
      const out = [];
      const items = topLevelItems();
      function pushChannel(ch) {
        for (const v of (ch.videos || [])) {
          if (v.is_read) continue;
          if (isShort(v, ch)) continue;
          out.push({ video_id: v.video_id, title: v.title, source: 'feed' });
        }
      }
      for (const it of items) {
        if (it.type === 'folder') {
          const mode = folderViewMode(it.item);
          if (mode === 'compact') {
            const vids = folderMixedStrip(it.item).filter(v => !isShort(v, v._channel));
            for (const v of vids) out.push({ video_id: v.video_id, title: v.title, source: 'feed' });
          } else if (mode === 'expanded') {
            for (const ch of (it.item.channels || [])) pushChannel(ch);
          }
        } else {
          pushChannel(it.item);
        }
      }
      return out;
    })();
    const combined = queueItems.concat(feedItems);
    if (!combined.length) {
      status('Nothing to play', 'err');
      setTimeout(() => status(''), 2000);
      return;
    }
    const pick = combined[Math.floor(Math.random() * combined.length)];
    if (pick.source === 'queue' && !state.queueOpen) openQueuePane();
    openPlayer(pick.video_id, pick.title, pick.queue_id || null);
    return;
  }

  // Global: Escape closes queue when no player open
  if (!mod && !uiPlayerActive() && e.key === 'Escape' && state.queueOpen) {
    closeQueuePane();
    return;
  }

  // Global: shift+Q → open queue + play first shallow item
  if (!uiPlayerActive() && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Q') {
    const shallow = shallowQueue();
    if (!shallow.length) {
      status('Queue empty', 'err');
      setTimeout(() => status(''), 2000);
      return;
    }
    if (!state.queueOpen) openQueuePane();
    const first = shallow[0];
    openPlayer(first.video_id, first.title, first.video_id);
    return;
  }

  // Global: w → start watching queue in-page
  if (!mod && !uiPlayerActive() && e.key === 'w') {
    watchStartQueue();
    return;
  }

  // Global: q → toggle queue visibility
  if (!mod && !uiPlayerActive() && e.key === 'q') {
    toggleQueuePane();
    return;
  }

  // Global: Shift+1..9 → play Nth shallow queue item
  if (!uiPlayerActive() && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const n = parseInt(e.code.slice(5), 10);
    const shallow = shallowQueue();
    if (!shallow.length) {
      status('Queue empty', 'err');
      setTimeout(() => status(''), 2000);
      return;
    }
    if (n > shallow.length) {
      status(`Queue has ${shallow.length} item(s)`, 'err');
      setTimeout(() => status(''), 2500);
      return;
    }
    if (!state.queueOpen) openQueuePane();
    const item = shallow[n - 1];
    openPlayer(item.video_id, item.title, item.video_id);
    return;
  }

  // Global: 1-9 → first video of Nth row
  if (!mod && !uiPlayerActive() && /^[1-9]$/.test(e.key)) {
    const n = parseInt(e.key, 10);
    const rows = topLevelItems();
    function firstVideo(it) {
      if (it.type === 'folder') {
        const mode = folderViewMode(it.item);
        if (mode === 'compact') {
          const vids = folderMixedStrip(it.item).filter(v => !isShort(v, v._channel));
          if (!vids.length) return null;
          return { video_id: vids[0].video_id, title: vids[0].title };
        }
        for (const ch of (it.item.channels || [])) {
          const v = (ch.videos || []).find(x => !x.is_read && !isShort(x, ch));
          if (v) return { video_id: v.video_id, title: v.title };
        }
        return null;
      }
      const ch = it.item;
      const v = (ch.videos || []).find(x => !x.is_read && !isShort(x, ch));
      return v ? { video_id: v.video_id, title: v.title } : null;
    }
    if (n > rows.length) {
      status(`Only ${rows.length} row(s)`, 'err');
      setTimeout(() => status(''), 2500);
      return;
    }
    const pick = firstVideo(rows[n - 1]);
    if (!pick) {
      status(`Row ${n} has no playable video`, 'err');
      setTimeout(() => status(''), 2500);
      return;
    }
    openPlayer(pick.video_id, pick.title);
    return;
  }

  if (!player.videoId) return;

  if (e.key === 'Escape') { closePlayer(); return; }
  if (e.key === 'f') { $('player-frame').requestFullscreen?.(); return; }
  if (e.key === 't' || e.key === 'T') {
    player.mode = player.mode === 'theater' ? 'normal' : 'theater';
    renderPlayer();
    return;
  }
  if (e.key === 'y') {
    window.open(`https://www.youtube.com/watch?v=${player.videoId}`, '_blank', 'noopener,noreferrer');
    closePlayer();
    return;
  }
  if (e.key === 'm') {
    let currentlyRead = false;
    for (const ch of allChannels()) {
      const v = (ch.videos || []).find(x => x.video_id === player.videoId);
      if (v) { currentlyRead = !!v.is_read; break; }
    }
    toggleVideoRead(player.videoId, currentlyRead);
    return;
  }
  if (e.key === 'q' || e.key === 'Q') {
    let inQ = false;
    for (const ch of allChannels()) {
      const v = (ch.videos || []).find(x => x.video_id === player.videoId);
      if (v) { inQ = !!v.in_queue; break; }
    }
    const meta = videoMeta.get(player.videoId);
    if (meta) toggleQueue(meta, inQ);
    return;
  }
  if (e.key === 'n') { playNext(1);  return; }
  if (e.key === 'p') { playNext(-1); return; }
  if (e.key === 's' && state.signalConfigured) {
    const meta = videoMeta.get(player.videoId);
    if (meta) signalSendVideo(meta.video_id, meta.title, meta.channel_name, meta.thumbnail_url);
    closePlayer();
    return;
  }
  if (e.key === 'Enter' && state.tvConfigured) {
    tvSend(player.videoId);
    closePlayer();
    return;
  }
  // Forward playback keys to YT iframe player
  if (!ytPlayer) return;
  try {
    if (/^[0-9]$/.test(e.key)) {
      const pct = parseInt(e.key, 10) / 10;
      const dur = ytPlayer.getDuration?.();
      if (dur) ytPlayer.seekTo(dur * pct, true);
      e.preventDefault();
      return;
    }
    if (e.key === ' ' || e.key === 'k') {
      const st = ytPlayer.getPlayerState?.();
      if (st === 1) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
      e.preventDefault();
      return;
    }
    if (e.key === 'j') { ytPlayer.seekTo((ytPlayer.getCurrentTime?.() || 0) - 10, true); e.preventDefault(); return; }
    if (e.key === 'l') { ytPlayer.seekTo((ytPlayer.getCurrentTime?.() || 0) + 10, true); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft')  { ytPlayer.seekTo((ytPlayer.getCurrentTime?.() || 0) - 5, true); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { ytPlayer.seekTo((ytPlayer.getCurrentTime?.() || 0) + 5, true); e.preventDefault(); return; }
  } catch {}
});
