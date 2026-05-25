'use strict';

/*
 * Drag-and-drop for the feed (folders + channels reorder, channel-into-
 * folder move) and for the watch queue (reorder, shallow ↔ deep move).
 *
 * Classic script. Two parallel code paths:
 *   - Native HTML5 drag-and-drop (mouse / desktop): dragstart/dragend/
 *     dragover/drop on document
 *   - Pointer-based long-press touch drag (mobile): pointerdown holds
 *     for 350ms then activates, pointermove updates target, pointerup/
 *     cancel commits or aborts.
 *
 * The drag source globals (dragSrcId, dragSrcType, dragSrcFolderId)
 * live in state.js; queueDragSrcId and touchDrag are local here.
 */

function anyCard(el) {
  return el.closest('.channel-card') || el.closest('.folder-card');
}

let queueDragSrcId = null;
let touchDrag = null;


// ── Touch (long-press) drag for queue items ──────────────────────────────────

document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  const qItem = e.target.closest('.q-item[draggable]');
  if (!qItem) return;
  if (e.target.closest('button, a, [data-action]')) return;
  const startX = e.clientX, startY = e.clientY;
  touchDrag = {
    srcId: qItem.dataset.videoId,
    srcEl: qItem,
    pointerId: e.pointerId,
    active: false,
    target: null,
    deep: null,
    timer: setTimeout(() => {
      if (!touchDrag) return;
      touchDrag.active = true;
      queueDragSrcId = touchDrag.srcId;
      qItem.classList.add('dragging');
      try { qItem.setPointerCapture?.(touchDrag.pointerId); } catch {}
    }, 350),
    startX, startY,
  };
});

document.addEventListener('pointermove', e => {
  if (!touchDrag || e.pointerId !== touchDrag.pointerId) return;
  if (!touchDrag.active) {
    if (Math.hypot(e.clientX - touchDrag.startX, e.clientY - touchDrag.startY) > 10) {
      clearTimeout(touchDrag.timer);
      touchDrag = null;
    }
    return;
  }
  e.preventDefault();
  document.querySelectorAll('.q-item, .deep-section').forEach(q =>
    q.classList.remove('drag-over', 'drag-into')
  );
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) { touchDrag.target = null; touchDrag.deep = null; return; }
  const target = el.closest('.q-item');
  if (target && target.dataset.videoId !== touchDrag.srcId) {
    target.classList.add('drag-over');
    touchDrag.target = target;
    touchDrag.deep = null;
    return;
  }
  const deepHdr = el.closest('.deep-section');
  const src = state.queue.find(q => q.video_id === touchDrag.srcId);
  if (deepHdr && src && !src.is_deep) {
    deepHdr.classList.add('drag-into');
    touchDrag.target = null;
    touchDrag.deep = deepHdr;
    return;
  }
  touchDrag.target = null;
  touchDrag.deep = null;
}, { passive: false });

function endTouchDrag(commit) {
  if (!touchDrag) return;
  clearTimeout(touchDrag.timer);
  if (touchDrag.active && commit) {
    commitQueueDrop(touchDrag.srcId, touchDrag.target, touchDrag.deep);
  }
  document.querySelectorAll('.q-item, .deep-section').forEach(q =>
    q.classList.remove('drag-over', 'drag-into', 'dragging')
  );
  queueDragSrcId = null;
  touchDrag = null;
}
document.addEventListener('pointerup',     e => { if (touchDrag && e.pointerId === touchDrag.pointerId) endTouchDrag(true);  });
document.addEventListener('pointercancel', e => { if (touchDrag && e.pointerId === touchDrag.pointerId) endTouchDrag(false); });


// ── Native HTML5 drag for feed cards + queue items ───────────────────────────

document.addEventListener('dragstart', e => {
  // Queue item drag
  const qItem = e.target.closest('.q-item[draggable]');
  if (qItem) {
    queueDragSrcId = qItem.dataset.videoId;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => qItem.classList.add('dragging'), 0);
    return;
  }

  // Feed drag
  const card = anyCard(e.target);
  if (!card) return;
  if (card.dataset.folderId) {
    dragSrcId       = card.dataset.folderId;
    dragSrcType     = 'folder';
    dragSrcFolderId = null;
  } else {
    dragSrcId       = card.dataset.channelId;
    dragSrcType     = 'channel';
    const ch        = findChannel(dragSrcId);
    dragSrcFolderId = ch?.folder_id ?? null;
  }
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => card.classList.add('dragging'), 0);
});

document.addEventListener('dragend', () => {
  document.querySelectorAll('.channel-card, .folder-card, .q-item').forEach(c =>
    c.classList.remove('dragging', 'drag-over', 'drag-into')
  );
  dragSrcId = dragSrcType = dragSrcFolderId = null;
  queueDragSrcId = null;
});

document.addEventListener('dragover', e => {
  // Queue reorder / cross-group move
  if (queueDragSrcId) {
    document.querySelectorAll('.q-item, .deep-section').forEach(q =>
      q.classList.remove('drag-over', 'drag-into')
    );
    const target = e.target.closest('.q-item');
    if (target && target.dataset.videoId !== queueDragSrcId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      target.classList.add('drag-over');
      return;
    }
    // Drop on deep header (collapsed) → move into deep
    const deepHdr = e.target.closest('.deep-section');
    const srcItem = state.queue.find(q => q.video_id === queueDragSrcId);
    if (deepHdr && srcItem && !srcItem.is_deep) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      deepHdr.classList.add('drag-into');
    }
    return;
  }

  if (!dragSrcId) return;

  document.querySelectorAll('.drag-over, .drag-into').forEach(c =>
    c.classList.remove('drag-over', 'drag-into')
  );

  if (dragSrcType === 'channel') {
    const folderCard = e.target.closest('.folder-card');
    if (folderCard) {
      const targetFolderId = parseInt(folderCard.dataset.folderId, 10);
      if (targetFolderId !== dragSrcFolderId) {
        // Different folder → drop-into highlight
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        folderCard.classList.add('drag-into');
        return;
      }
      // Same folder → fall through to channel reorder below
    }
    const channelCard = e.target.closest('.channel-card');
    if (channelCard && channelCard.dataset.channelId !== dragSrcId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      channelCard.classList.add('drag-over');
    }
    return;
  }

  if (dragSrcType === 'folder') {
    // Folder reorder: hover over any top-level item
    const topCard = e.target.closest('.channel-card:not(.nested)') || e.target.closest('.folder-card');
    if (topCard) {
      const targetId = topCard.dataset.channelId || topCard.dataset.folderId;
      if (targetId !== dragSrcId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        topCard.classList.add('drag-over');
      }
    }
  }
});

function commitQueueDrop(srcId, target, deepHdr) {
  const src = state.queue.find(q => q.video_id === srcId);
  if (!src) return;

  if (deepHdr && !target && !src.is_deep) {
    setQueueDeep(srcId, true);
    return;
  }

  if (!target || target.dataset.videoId === srcId) return;

  const targetGroup = target.dataset.group;
  const srcGroup    = src.is_deep ? 'deep' : 'shallow';

  if (targetGroup !== srcGroup) {
    src.is_deep = targetGroup === 'deep' ? 1 : 0;
  }

  const si = state.queue.findIndex(q => q.video_id === srcId);
  const di = state.queue.findIndex(q => q.video_id === target.dataset.videoId);
  if (si === -1 || di === -1) return;
  const [m] = state.queue.splice(si, 1);
  state.queue.splice(di, 0, m);
  state.queue.forEach((q, i) => { q.sort_order = i; });
  renderQueue();
  renderQueueBadge();

  if (targetGroup !== srcGroup) {
    api.post(`/api/queue/${srcId}/deep`, { is_deep: targetGroup === 'deep' })
      .then(() => api.post('/api/queue/reorder', { ids: state.queue.map(q => q.video_id) }))
      .catch(() => {});
  } else {
    api.post('/api/queue/reorder', { ids: state.queue.map(q => q.video_id) }).catch(() => {});
  }
}

document.addEventListener('drop', e => {
  if (queueDragSrcId) {
    const srcId = queueDragSrcId;
    const deepHdr = e.target.closest('.deep-section');
    const target  = e.target.closest('.q-item');
    if (target || deepHdr) e.preventDefault();
    commitQueueDrop(srcId, target, deepHdr);
    return;
  }

  if (!dragSrcId) return;

  if (dragSrcType === 'channel') {
    const folderCard = e.target.closest('.folder-card');
    if (folderCard) {
      const targetFolderId = parseInt(folderCard.dataset.folderId, 10);
      if (targetFolderId !== dragSrcFolderId) {
        e.preventDefault();
        setFolder(dragSrcId, String(targetFolderId));
        return;
      }
      // Same folder — fall through to channel reorder
    }
    const channelCard = e.target.closest('.channel-card');
    if (channelCard && channelCard.dataset.channelId !== dragSrcId) {
      e.preventDefault();
      reorderChannels(dragSrcId, channelCard.dataset.channelId);
    }
    return;
  }

  if (dragSrcType === 'folder') {
    const topCard = e.target.closest('.channel-card:not(.nested)') || e.target.closest('.folder-card');
    if (!topCard) return;
    const targetId = topCard.dataset.channelId || topCard.dataset.folderId;
    if (targetId === dragSrcId) return;
    e.preventDefault();

    const items = topLevelItems();
    const srcIdx = items.findIndex(({ type, item }) =>
      (type === 'folder' ? String(item.id) : item.channel_id) === dragSrcId
    );
    const dstIdx = items.findIndex(({ type, item }) =>
      (type === 'folder' ? String(item.id) : item.channel_id) === targetId
    );
    if (srcIdx === -1 || dstIdx === -1) return;
    applyFeedItemOrder(items, srcIdx, dstIdx);
    render();
    persistFeedOrder();
  }
});

function reorderChannels(srcId, dstId) {
  const srcInFolder = state.feed.folders.find(f => f.channels.some(c => c.channel_id === srcId));
  const dstInFolder = state.feed.folders.find(f => f.channels.some(c => c.channel_id === dstId));

  let list;
  if (srcInFolder && dstInFolder && srcInFolder.id === dstInFolder.id) {
    list = srcInFolder.channels;
  } else if (!srcInFolder && !dstInFolder) {
    list = state.feed.channels;
  } else {
    return;
  }

  const si = list.findIndex(c => c.channel_id === srcId);
  const di = list.findIndex(c => c.channel_id === dstId);
  if (si === -1 || di === -1) return;
  const [m] = list.splice(si, 1);
  list.splice(di, 0, m);
  list.forEach((ch, i) => { ch.sort_order = i; });
  render();
  api.post('/api/channels/reorder', { ids: list.map(c => c.channel_id) }).catch(() => {});
}

function applyFeedItemOrder(items, srcIdx, dstIdx) {
  const [moved] = items.splice(srcIdx, 1);
  items.splice(dstIdx, 0, moved);
  // Update sort_order so topLevelItems() re-sort preserves the new positions
  items.forEach((entry, i) => { entry.item.sort_order = i; });
  state.feed.folders  = items.filter(i => i.type === 'folder').map(i => i.item);
  state.feed.channels = items.filter(i => i.type === 'channel').map(i => i.item);
}
