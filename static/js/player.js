'use strict';

/*
 * In-page player launch logic.
 *
 * Classic script. These functions decide WHAT to play (random pick,
 * next-in-list, the clicked video) and then hand off to watchEnter()
 * in watch.js, which owns the actual YT iframe.
 *
 * visiblePlayList walks the current feed/queue ordering so playNext
 * matches what the user sees.
 */


function visiblePlayList() {
  // Returns ordered array of {video_id, title, channel_name, queue_id?}
  // Deep queue items are intentionally excluded — they're parked, not playable.
  const shallow = shallowQueue();
  if (state.queueOpen && shallow.length) {
    return shallow.map(q => ({
      video_id: q.video_id,
      title: q.title,
      channel_name: q.channel_name,
      queue_id: q.video_id,
    }));
  }
  const out = [];
  const items = topLevelItems();
  function pushChannel(ch) {
    for (const v of (ch.videos || [])) {
      if (v.is_read) continue;
      if (isShort(v, ch)) continue;
      out.push({ video_id: v.video_id, title: v.title, channel_name: ch.name });
    }
  }
  for (const it of items) {
    if (it.type === 'folder') {
      const mode = folderViewMode(it.item);
      if (mode === 'compact') {
        // Mirror displayed mixed strip order — sorted by published_at desc
        const vids = folderMixedStrip(it.item).filter(v => !isShort(v, v._channel));
        for (const v of vids) {
          out.push({ video_id: v.video_id, title: v.title, channel_name: v._channel.name });
        }
      } else if (mode === 'expanded') {
        for (const ch of (it.item.channels || [])) pushChannel(ch);
      }
      // collapsed = nothing visible, skip
    } else {
      pushChannel(it.item);
    }
  }
  return out;
}


function randomPlay() {
  const list = visiblePlayList();
  if (!list.length) {
    status('Nothing to play', 'err');
    setTimeout(() => status(''), 2000);
    return;
  }
  const pick = list[Math.floor(Math.random() * list.length)];
  openPlayer(pick.video_id, pick.title, pick.queue_id || null);
}


function playNext(direction = 1) {
  const list = visiblePlayList();
  if (!list.length) return;
  let idx = list.findIndex(v => v.video_id === player.videoId);
  if (idx < 0) idx = 0;
  else idx = (idx + direction + list.length) % list.length;
  const pick = list[idx];
  openPlayer(pick.video_id, pick.title, pick.queue_id || null);
}


function openPlayer(videoId, title, queueVideoId = null) {
  const shallow = shallowQueue();
  if (queueVideoId && shallow.some(q => q.video_id === queueVideoId)) {
    watchEnter({
      mode: 'queue', inPage: true, mutedStart: false,
      list: shallow.map(q => ({
        video_id: q.video_id, title: q.title,
        channel_name: q.channel_name, thumbnail_url: q.thumbnail_url,
        duration: q.duration,
      })),
      startId: queueVideoId,
      mark: async (id) => {
        await api.post(`/api/queue/${id}/watched`);
        state.queue = state.queue.filter(q => q.video_id !== id);
        setInQueue(id, false);
      },
    });
    return;
  }
  const meta = videoMeta.get(videoId) || {};
  watchEnter({
    mode: 'single', inPage: true, mutedStart: false, singleShot: true,
    list: [{
      video_id: videoId,
      title: title || meta.title || '',
      channel_name: meta.channel_name || '',
      thumbnail_url: meta.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    }],
    mark: async (id) => {
      try { await api.post(`/api/videos/${id}/read`); } catch {}
      for (const ch of allChannels()) {
        const v = (ch.videos || []).find(x => x.video_id === id);
        if (v) v.is_read = true;
      }
    },
  });
}


function closePlayer() {
  player.videoId = player.title = player.queueVideoId = null;
  renderPlayer();
}


async function playerMarkWatched() {
  if (!player.queueVideoId) return;
  const vid = player.queueVideoId;
  closePlayer();
  try {
    await api.post(`/api/queue/${vid}/watched`);
    state.queue = state.queue.filter(q => q.video_id !== vid);
    setInQueue(vid, false);
    renderQueue();
    renderQueueBadge();
  } catch {}
}
