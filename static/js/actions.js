'use strict';

/*
 * All non-rendering action handlers — channel CRUD, folder CRUD,
 * per-video read state, queue ops, refresh helpers, sort persistence.
 *
 * Classic script, loaded after app.js so render() / renderQueue() /
 * renderQueueBadge() / topLevelItems() are in scope. Every function
 * here either mutates state.* and calls render(), or fires off an
 * api.{get,post,del} promise; failures route to status().
 *
 * setRefreshProgress + refreshAll also live here because they
 * naturally co-locate with the "Refresh All" header button and the
 * SSE refresh stream consumer; the auto-refresh timer in refresh.js
 * and the pull-to-refresh gesture in gestures.js both call them.
 */


// ── Channels ─────────────────────────────────────────────────────────────────

async function addChannel() {
  const raw = $('channel-input').value;
  const lines = raw.split(/[\n\r,]+/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) { await addChannels(lines); return; }
  const input = lines[0] || '';
  if (!input) return;

  $('btn-add-channel').disabled = true;
  status('Adding…', 'loading');
  try {
    const ch = await api.post('/api/channels', { input });
    $('channel-input').value = '';
    if (ch.video_found) {
      renderQueue();
      status(`Video found: ${ch.title}`, 'ok');
    } else {
      state.feed.channels.push(ch);
      render();
      status(`Added ${ch.name}`, 'ok');
    }
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  } finally {
    $('btn-add-channel').disabled = false;
  }
}

async function subscribeFromQueue(channelId) {
  status('Adding…', 'loading');
  try {
    const ch = await api.post('/api/channels', { input: channelId });
    state.feed.channels.push(ch);
    render();
    renderQueue();
    status(`Added ${ch.name}`, 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function addChannels(inputs) {
  const valid = inputs.map(s => s.trim()).filter(Boolean);
  if (!valid.length) return;

  $('btn-add-channel').disabled = true;
  $('channel-input').value = '';
  let added = 0, failed = 0;

  for (let i = 0; i < valid.length; i++) {
    status(`Adding ${i + 1}/${valid.length}: ${valid[i]}…`, 'loading');
    try {
      const ch = await api.post('/api/channels', { input: valid[i] });
      if (ch.video_found) {
        renderQueue();
      } else {
        state.feed.channels.push(ch);
        render();
      }
      added++;
    } catch {
      failed++;
    }
  }

  status(`Added ${added}${failed ? `, ${failed} failed` : ''}`, added ? 'ok' : 'err');
  setTimeout(() => status(''), 4000);
  $('btn-add-channel').disabled = false;
}

async function deleteChannel(channelId) {
  const ch = findChannel(channelId);
  if (!ch || !confirm(`Remove "${ch.name}"?`)) return;
  try {
    await api.del(`/api/channels/${channelId}`);
    state.feed.channels = state.feed.channels.filter(c => c.channel_id !== channelId);
    state.feed.folders.forEach(f => {
      f.channels = f.channels.filter(c => c.channel_id !== channelId);
    });
    state.manualExpand.delete(channelId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function markChannelRead(channelId) {
  try {
    const res = await api.post(`/api/channels/${channelId}/mark-read`);
    const ch = findChannel(channelId);
    if (ch) {
      ch.read_before = res.read_before;
      ch.videos.forEach(v => { v.is_read = true; });
    }
    state.manualExpand.delete(channelId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function markChannelUnread(channelId) {
  try {
    await api.post(`/api/channels/${channelId}/mark-unread`);
    const ch = findChannel(channelId);
    if (ch) {
      ch.read_before = null;
      ch.videos.forEach(v => { v.is_read = false; });
    }
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function toggleAllowShorts(channelId, allow) {
  try {
    await api.post(`/api/channels/${channelId}/allow-shorts`, { allow });
    const ch = findChannel(channelId);
    if (ch) ch.allow_shorts = allow ? 1 : 0;
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function toggleMute(channelId, muted) {
  try {
    await api.post(`/api/channels/${channelId}/mute`, { muted });
    state.feed = await api.get('/api/feed');
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function refreshChannel(channelId) {
  status('Refreshing…', 'loading');
  try {
    await api.post(`/api/channels/${channelId}/refresh`);
    state.feed = await api.get('/api/feed');
    render();
    status('Refreshed', 'ok');
    setTimeout(() => status(''), 2000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}


// ── Refresh-all (header button + SSE stream) ─────────────────────────────────

function setRefreshProgress(pct) {
  const wrap = $('refresh-progress');
  const bar  = $('refresh-progress-bar');
  if (!wrap || !bar) return;
  if (pct <= 0) {
    bar.style.width = '0';
    wrap.classList.add('hidden');
  } else {
    wrap.classList.remove('hidden');
    bar.style.width = `${Math.round(pct * 100)}%`;
  }
}

function refreshAll() {
  const btn = $('btn-refresh-all');
  btn.disabled = true;
  $('refresh-spinner').classList.add('hidden');

  return new Promise(resolve => {
    const source = new EventSource('/api/refresh-all/stream');

    source.onmessage = async e => {
      const data = JSON.parse(e.data);
      if (data.done) {
        source.close();
        state.feed = await api.get('/api/feed');
        render();
        const ok  = data.results.filter(r => !r.error).length;
        const err = data.results.filter(r =>  r.error).length;
        status(`Refreshed ${ok} channel${ok !== 1 ? 's' : ''}${err ? `, ${err} failed` : ''}`, err ? 'err' : 'ok');
        setTimeout(() => status(''), 4000);
        updateQuota();
        btn.disabled = false;
        $('refresh-label').innerHTML = '↻<span class="btn-label"> Refresh All</span>';
        setRefreshProgress(0);
        resolve();
      } else {
        $('refresh-label').textContent = `↻ ${data.i}/${data.total} ${data.name}`;
        setRefreshProgress(data.i / data.total);
      }
    };

    source.onerror = () => {
      source.close();
      status('Refresh failed', 'err');
      btn.disabled = false;
      $('refresh-label').innerHTML = '↻<span class="btn-label"> Refresh All</span>';
      setRefreshProgress(0);
      resolve();
    };
  });
}

async function clearAll() {
  if (!confirm('☢ Nuclear clear: mark ALL channels as read?\n\nYour queue is unaffected.')) return;
  try {
    await api.post('/api/clear-all');
    state.feed = await api.get('/api/feed');
    state.manualExpand.clear();
    state.folderExpand.clear();
    render();
    status('All cleared', 'ok');
    setTimeout(() => status(''), 3000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}


// ── Channel expand / move-to-folder ──────────────────────────────────────────

function toggleChannel(channelId) {
  const ch = findChannel(channelId);
  if (!ch) return;
  if (channelViewMode(ch) === 'expanded') {
    state.manualExpand.delete(channelId);
  } else {
    state.manualExpand.add(channelId);
  }
  render();
}

async function setFolder(channelId, folderId) {
  const numericId = folderId ? parseInt(folderId, 10) : null;
  try {
    await api.post(`/api/channels/${channelId}/set-folder`, { folder_id: numericId });
    state.feed = await api.get('/api/feed');
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}


// ── Folders ──────────────────────────────────────────────────────────────────

async function createFolder() {
  const name = prompt('Folder name:')?.trim();
  if (!name) return;
  try {
    const folder = await api.post('/api/folders', { name });
    state.feed.folders.push(folder);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function deleteFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  const chanCount = folder.channels.length;
  const msg = chanCount
    ? `Delete folder "${folder.name}"? Its ${chanCount} channel${chanCount !== 1 ? 's' : ''} will move to root.`
    : `Delete folder "${folder.name}"?`;
  if (!confirm(msg)) return;
  try {
    await api.del(`/api/folders/${folderId}`);
    state.feed = await api.get('/api/feed');
    state.folderExpand.delete(folderId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function renameFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  const name = prompt('New folder name:', folder.name)?.trim();
  if (!name || name === folder.name) return;
  try {
    await api.post(`/api/folders/${folderId}/rename`, { name });
    folder.name = name;
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

function toggleFolder(folderId) {
  const folder = findFolder(folderId);
  if (!folder) return;
  if (folderViewMode(folder) === 'expanded') {
    state.folderExpand.delete(folderId);
  } else {
    state.folderExpand.add(folderId);
  }
  render();
}

async function markFolderRead(folderId) {
  try {
    const res = await api.post(`/api/folders/${folderId}/mark-read`);
    const folder = findFolder(folderId);
    if (folder) {
      folder.channels.forEach(ch => {
        ch.read_before = res.read_before;
        ch.videos.forEach(v => { v.is_read = true; });
      });
    }
    state.folderExpand.delete(folderId);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function refreshFolder(folderId) {
  status('Refreshing folder…', 'loading');
  try {
    await api.post(`/api/folders/${folderId}/refresh`);
    state.feed = await api.get('/api/feed');
    render();
    status('Folder refreshed', 'ok');
    setTimeout(() => status(''), 2000);
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}


// ── Per-video read state ─────────────────────────────────────────────────────

async function toggleVideoRead(videoId, currentlyRead) {
  const endpoint = currentlyRead ? 'unread' : 'read';
  try {
    await api.post(`/api/videos/${videoId}/${endpoint}`);
    allChannels().forEach(ch =>
      ch.videos.forEach(v => { if (v.video_id === videoId) v.is_read = !currentlyRead; })
    );
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}


// ── Queue ────────────────────────────────────────────────────────────────────

function setInQueue(videoId, val) {
  allChannels().forEach(ch =>
    ch.videos.forEach(v => { if (v.video_id === videoId) v.in_queue = val; })
  );
}

async function toggleQueue(meta, currentlyInQueue) {
  if (currentlyInQueue) {
    await removeFromQueue(meta.video_id);
  } else {
    await addToQueue(meta);
  }
}

async function addToQueue(meta) {
  try {
    await api.post('/api/queue', meta);
    state.queue = await api.get('/api/queue');
    setInQueue(meta.video_id, true);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function clearQueue(deep = false) {
  const target = state.queue.filter(q => !!q.is_deep === deep);
  if (target.length === 0) return;
  try {
    await api.del(`/api/queue${deep ? '?deep=1' : ''}`);
    const clearedIds = target.map(q => q.video_id);
    state.queue = state.queue.filter(q => !!q.is_deep !== deep);
    clearedIds.forEach(id => setInQueue(id, false));
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function removeFromQueue(videoId) {
  try {
    await api.del(`/api/queue/${videoId}`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    setInQueue(videoId, false);
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function setQueueDeep(videoId, isDeep) {
  try {
    await api.post(`/api/queue/${videoId}/deep`, { is_deep: !!isDeep });
    state.queue = await api.get('/api/queue');
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}

async function watchOnYouTube(videoId) {
  try {
    await api.post(`/api/queue/${videoId}/watched`);
    state.queue = state.queue.filter(q => q.video_id !== videoId);
    setInQueue(videoId, false);
    render();
  } catch {}
}


// ── Sort + persist feed order ────────────────────────────────────────────────

async function persistFeedOrder() {
  const items = topLevelItems().map(({ type, item }) => ({
    type,
    id: type === 'folder' ? String(item.id) : item.channel_id,
  }));
  try { await api.post('/api/feed/reorder', { items }); } catch {}
}
