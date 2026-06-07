'use strict';

/*
 * Global click + change event delegation.
 *
 * Classic script. One delegated click handler routes [data-action="..."]
 * elements to the appropriate action function, plus a few class-based
 * special cases (folder header, channel header, player backdrop).
 *
 * All action functions live in app.js / features.js — resolved at call
 * time via shared script scope.
 */

document.addEventListener('click', e => {
  // Player backdrop
  if (e.target.closest('[data-action="close-player-backdrop"]') &&
      !e.target.closest('.player-box')) {
    closePlayer(); return;
  }

  // Folder: toggle
  const fHeader = e.target.closest('.folder-header');
  if (fHeader && !e.target.closest('.ch-btn') && !e.target.closest('.ch-check') &&
      !e.target.closest('.folder-icon-btn')) {
    toggleFolder(parseInt(fHeader.dataset.folderId, 10)); return;
  }

  // Icon picker: open
  const iconBtn = e.target.closest('[data-action="open-icon-picker"]');
  if (iconBtn) { e.stopPropagation(); showIconPicker(parseInt(iconBtn.dataset.folderId, 10), iconBtn); return; }

  // Icon picker: pick
  const pickBtn = e.target.closest('[data-action="pick-icon"]');
  if (pickBtn) { setFolderIcon(pickerFolderId, pickBtn.dataset.emoji); hideIconPicker(); return; }

  // Folder: mark all read
  const mfrBtn = e.target.closest('[data-action="mark-folder-read"]');
  if (mfrBtn) { e.stopPropagation(); markFolderRead(parseInt(mfrBtn.dataset.folderId, 10)); return; }

  // Folder: refresh
  const rfBtn = e.target.closest('[data-action="refresh-folder"]');
  if (rfBtn) { e.stopPropagation(); refreshFolder(parseInt(rfBtn.dataset.folderId, 10)); return; }

  // Folder: watch all visible videos (here, or cast to a screen if one is online)
  const wfBtn = e.target.closest('[data-action="watch-folder"]');
  if (wfBtn) {
    e.stopPropagation();
    const fid = parseInt(wfBtn.dataset.folderId, 10);
    const reverse = e.shiftKey;   // shift-click → oldest first
    castIsTv() ? watchStartFolder(fid, reverse) : castOrWatchFolder(fid, reverse);   // /tv always plays here
    return;
  }

  // Folder: rename
  const renameBtn = e.target.closest('[data-action="rename-folder"]');
  if (renameBtn) { e.stopPropagation(); renameFolder(parseInt(renameBtn.dataset.folderId, 10)); return; }

  // Folder: delete
  const delFolderBtn = e.target.closest('[data-action="delete-folder"]');
  if (delFolderBtn) { e.stopPropagation(); deleteFolder(parseInt(delFolderBtn.dataset.folderId, 10)); return; }

  // Channel: mark read
  const mrBtn = e.target.closest('[data-action="mark-read"]');
  if (mrBtn) { e.stopPropagation(); markChannelRead(mrBtn.dataset.channelId); return; }

  // Channel: mark unread
  const muBtn = e.target.closest('[data-action="mark-unread"]');
  if (muBtn) { e.stopPropagation(); markChannelUnread(muBtn.dataset.channelId); return; }

  // Channel: toggle allow-shorts
  const asBtn = e.target.closest('[data-action="toggle-allow-shorts"]');
  if (asBtn) {
    e.stopPropagation();
    toggleAllowShorts(asBtn.dataset.channelId, asBtn.checked);
    return;
  }

  // Channel: toggle mute
  const mtBtn = e.target.closest('[data-action="toggle-mute"]');
  if (mtBtn) {
    e.stopPropagation();
    toggleMute(mtBtn.dataset.channelId, mtBtn.dataset.muted !== '1');
    return;
  }

  // Channel: refresh
  const refBtn = e.target.closest('[data-action="refresh-channel"]');
  if (refBtn) { e.stopPropagation(); refreshChannel(refBtn.dataset.channelId); return; }

  // Channel: delete
  const delBtn = e.target.closest('[data-action="delete-channel"]');
  if (delBtn) { e.stopPropagation(); deleteChannel(delBtn.dataset.channelId); return; }

  // Channel: toggle expand
  const chHeader = e.target.closest('.channel-header');
  if (chHeader && !e.target.closest('.ch-btn') && !e.target.closest('.ch-check') &&
      !e.target.closest('.ch-folder-select')) {
    toggleChannel(chHeader.dataset.channelId); return;
  }

  // Signal send
  const sigBtn = e.target.closest('[data-action="signal-send"]');
  if (sigBtn) {
    e.stopPropagation();
    signalSendVideo(sigBtn.dataset.videoId, sigBtn.dataset.title, sigBtn.dataset.channelName, sigBtn.dataset.thumbnailUrl);
    return;
  }

  // TV send
  const tvBtn = e.target.closest('[data-action="tv-send"]');
  if (tvBtn) {
    e.stopPropagation();
    tvSend(tvBtn.dataset.videoId);
    return;
  }

  // Open player (tile or row thumb)
  const openEl = e.target.closest('[data-action="open-player"]');
  if (openEl && !e.target.closest('[data-action="toggle-queue"]') && !e.target.closest('[data-action="signal-send"]') && !e.target.closest('[data-action="tv-send"]') && !e.target.closest('[data-action="video-read"]') && !e.target.closest('[data-action="video-unread"]')) {
    if (e.ctrlKey || e.metaKey) {
      // Desktop shortcut to the "where to play" sheet (Play Here / TV / Screen / Clipboard…).
      const ctx = buildSheetCtx(openEl.dataset.videoId);
      if (!ctx.title) ctx.title = openEl.dataset.title || '';
      openActionSheet(ctx);
      return;
    }
    if (e.altKey && state.tvConfigured) {
      tvSend(openEl.dataset.videoId);
      return;
    }
    if (isMobile() && !openEl.closest('.q-item')) {
      const ctx = buildSheetCtx(openEl.dataset.videoId);
      if (!ctx.title) ctx.title = openEl.dataset.title || '';
      openActionSheet(ctx);
      return;
    }
    openPlayer(openEl.dataset.videoId, openEl.dataset.title); return;
  }

  // Action sheet handlers
  if (e.target.closest('[data-action="sheet-backdrop"]') === e.target) { closeActionSheet(); return; }
  if (e.target.closest('[data-action="sheet-cancel"]')) { closeActionSheet(); return; }
  if (e.target.closest('[data-action="sheet-play-here"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    openPlayer(c.videoId, c.title);
    return;
  }
  if (e.target.closest('[data-action="sheet-play-screen"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    castSingleVideo({
      video_id: c.videoId, title: c.title,
      channel_name: c.channelName, thumbnail_url: c.thumbnailUrl,
    });
    return;
  }
  if (e.target.closest('[data-action="sheet-play-nearest"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    if (typeof flingVideoToNearest === 'function') flingVideoToNearest({
      video_id: c.videoId, title: c.title,
      channel_name: c.channelName, thumbnail_url: c.thumbnailUrl,
    });
    return;
  }
  if (e.target.closest('[data-action="sheet-play-tv"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    tvSend(c.videoId);
    return;
  }
  if (e.target.closest('[data-action="sheet-queue"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    const meta = videoMeta.get(c.videoId) || { video_id: c.videoId, title: c.title, channel_name: c.channelName, thumbnail_url: c.thumbnailUrl, channel_id: '', published_at: '' };
    toggleQueue(meta, c.inQueue);
    return;
  }
  if (e.target.closest('[data-action="sheet-mark"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    toggleVideoRead(c.videoId, c.isRead);
    return;
  }
  if (e.target.closest('[data-action="sheet-signal"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    signalSendVideo(c.videoId, c.title, c.channelName, c.thumbnailUrl);
    return;
  }
  if (e.target.closest('[data-action="sheet-share"]') && sheetCtx) {
    const c = sheetCtx; closeActionSheet();
    const shareUrl = `https://www.youtube.com/watch?v=${c.videoId}`;
    if (navigator.share) {
      navigator.share({ title: c.title, url: shareUrl }).catch(() => {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(shareUrl);
        }
      });
    } else {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(shareUrl);
      } else {
        const ta = document.createElement('textarea');
        ta.value = shareUrl; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      }
    }
    return;
  }
  if (e.target.closest('[data-action="sheet-copy"]') && sheetCtx) {
    const c = sheetCtx;
    closeActionSheet();

    const url = `https://www.youtube.com/watch?v=${c.videoId}`;

    const doCopy = (text) => {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
      }

      // fallback (Android-safe)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    };

    doCopy(url);
    return;
  }
  // Per-video read/unread
  const vr = e.target.closest('[data-action="video-read"]');
  if (vr) { e.stopPropagation(); toggleVideoRead(vr.dataset.videoId, false); return; }
  const vu = e.target.closest('[data-action="video-unread"]');
  if (vu) { e.stopPropagation(); toggleVideoRead(vu.dataset.videoId, true); return; }

  // Queue toggle
  const qBtn = e.target.closest('[data-action="toggle-queue"]');
  if (qBtn) {
    e.stopPropagation();
    const meta   = videoMeta.get(qBtn.dataset.videoId);
    const inQ    = qBtn.dataset.inQueue === '1';
    if (meta) toggleQueue(meta, inQ);
    return;
  }

  // Play from queue
  const playBtn = e.target.closest('[data-action="play-from-queue"]');
  if (playBtn) {
    if (e.ctrlKey || e.metaKey) {
      const ctx = buildSheetCtx(playBtn.dataset.videoId);
      if (!ctx.title) ctx.title = playBtn.dataset.title || '';
      openActionSheet(ctx);
      return;
    }
    if (e.altKey && state.tvConfigured) {
      tvSend(playBtn.dataset.videoId);
      return;
    }
    openPlayer(playBtn.dataset.videoId, playBtn.dataset.title, playBtn.dataset.videoId); return;
  }

  // YouTube link (mark watched)
  const ytLink = e.target.closest('[data-action="watch-yt"]');
  if (ytLink) { watchOnYouTube(ytLink.dataset.videoId); return; }

  // Remove from queue
  const rmBtn = e.target.closest('[data-action="remove-queue"]');
  if (rmBtn) { removeFromQueue(rmBtn.dataset.videoId); return; }

  // Subscribe to channel from queue
  const subBtn = e.target.closest('[data-action="subscribe-from-queue"]');
  if (subBtn) { subscribeFromQueue(subBtn.dataset.channelId); return; }

  // Move into deep queue
  const deepBtn = e.target.closest('[data-action="queue-deep"]');
  if (deepBtn) { e.stopPropagation(); setQueueDeep(deepBtn.dataset.videoId, true); return; }

  // Move out of deep queue
  const undeepBtn = e.target.closest('[data-action="queue-undeep"]');
  if (undeepBtn) { e.stopPropagation(); setQueueDeep(undeepBtn.dataset.videoId, false); return; }

  // Toggle deep section expand/collapse
  const deepHdr = e.target.closest('[data-action="toggle-deep"]');
  if (deepHdr) {
    state.deepOpen = !state.deepOpen;
    localStorage.setItem('deepOpen', state.deepOpen ? '1' : '0');
    renderQueue();
    return;
  }
});


// Move-to-folder select (change event)
document.addEventListener('change', e => {
  const sel = e.target.closest('[data-action="set-folder"]');
  if (sel) {
    e.stopPropagation();
    setFolder(sel.dataset.channelId, sel.value || null);
  }
});
