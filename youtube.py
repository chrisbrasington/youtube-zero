"""YouTube Data API v3 wrappers + video persistence for youtube-zero.

Every call here records quota units against `queries.add_quota`. The module
is async because the underlying httpx calls are; nothing here owns I/O state.

`save_videos` is the persistence side-effect: it stores fetched metadata and
auto-marks Shorts / muted-channel videos as read so they never appear in the
feed.
"""
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException

from const import HTTP_TIMEOUT_SHORT, YT_API, YT_CHUNK_SIZE
from db import db
from helpers import is_short, parse_duration
from queries import add_quota


async def yt_get_channel(lookup_type: str, value: str, api_key: str) -> dict:
    """Look up a channel by id or handle. Returns a dict ready for the channels table."""
    params = {"part": "snippet,contentDetails", "key": api_key}
    params["id" if lookup_type == "id" else "forHandle"] = value
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SHORT) as client:
        r = await client.get(f"{YT_API}/channels", params=params)
    if r.status_code != 200:
        detail = r.json().get("error", {}).get("message", r.text)
        raise HTTPException(502, f"YouTube API: {detail}")
    add_quota(1)
    items = r.json().get("items", [])
    if not items:
        raise HTTPException(404, f"Channel not found: {value}")
    item = items[0]
    thumbnails = item["snippet"].get("thumbnails", {})
    thumb = (thumbnails.get("medium") or thumbnails.get("default") or {}).get("url", "")
    return {
        "channel_id": item["id"],
        "name": item["snippet"]["title"],
        "thumbnail_url": thumb,
        "handle": item["snippet"].get("customUrl", "").lstrip("@"),
        "uploads_playlist_id": item["contentDetails"]["relatedPlaylists"]["uploads"],
    }


async def yt_fetch_videos(playlist_id: str, api_key: str, max_results: int = 10) -> list[dict]:
    """Fetch the latest videos from a channel's uploads playlist.

    Uses cached duration/is_live when available to avoid an extra videos.list
    call. Only re-queries metadata for new videos and ones still live/upcoming.
    """
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SHORT) as client:
        r = await client.get(f"{YT_API}/playlistItems", params={
            "part": "snippet",
            "playlistId": playlist_id,
            "maxResults": max_results,
            "key": api_key,
        })
    if r.status_code != 200:
        detail = r.json().get("error", {}).get("message", r.text)
        raise HTTPException(502, f"YouTube API: {detail}")
    add_quota(1)  # playlistItems.list

    videos: list[dict] = []
    video_ids: list[str] = []
    for item in r.json().get("items", []):
        sn = item["snippet"]
        vid = sn.get("resourceId", {}).get("videoId", "")
        if not vid:
            continue
        video_ids.append(vid)
        thumbnails = sn.get("thumbnails", {})
        picked = thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default") or {}
        videos.append({
            "video_id": vid,
            "channel_id": sn.get("channelId", ""),
            "title": sn.get("title", ""),
            "thumbnail_url": picked.get("url", ""),
            "published_at": sn.get("publishedAt", ""),
            "duration": "",
            "is_live": "none",
            "thumb_w": picked.get("width") or 0,
            "thumb_h": picked.get("height") or 0,
        })

    if video_ids:
        await _hydrate_video_metadata(videos, video_ids, api_key)

    return videos


async def _hydrate_video_metadata(videos: list[dict], video_ids: list[str], api_key: str) -> None:
    """Populate duration + is_live on `videos`, using cached rows when possible."""
    meta_map: dict[str, dict] = {}
    with db() as c:
        placeholders = ",".join("?" * len(video_ids))
        cached = c.execute(
            f"SELECT video_id, duration, is_live FROM videos WHERE video_id IN ({placeholders})",
            video_ids,
        ).fetchall()
        for row in cached:
            if row["duration"] and (row["is_live"] or "none") == "none":
                meta_map[row["video_id"]] = {
                    "duration": row["duration"],
                    "is_live": "none",
                }

    needed = [v for v in video_ids if v not in meta_map]
    if needed:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SHORT) as client:
            r2 = await client.get(f"{YT_API}/videos", params={
                "part": "contentDetails,snippet",
                "id": ",".join(needed),
                "key": api_key,
            })
        add_quota(1)  # videos.list (durations + snippet)
        for d in r2.json().get("items", []):
            meta_map[d["id"]] = {
                "duration": parse_duration(d["contentDetails"]["duration"]),
                "is_live": d.get("snippet", {}).get("liveBroadcastContent", "none"),
            }

    for v in videos:
        m = meta_map.get(v["video_id"], {})
        v["duration"] = m.get("duration", "")
        v["is_live"] = m.get("is_live", "none")


def save_videos(channel_id: str, videos: list[dict]) -> None:
    """Upsert videos for a channel; auto-mark Shorts/muted as read."""
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        ch_row = c.execute(
            "SELECT allow_shorts, muted FROM channels WHERE channel_id=?", (channel_id,)
        ).fetchone()
        allow_shorts = bool(ch_row["allow_shorts"]) if ch_row else False
        muted = bool(ch_row["muted"]) if ch_row else False
        for v in videos:
            v = dict(v)
            v["channel_id"] = channel_id
            c.execute(
                """INSERT OR REPLACE INTO videos
                   (video_id, channel_id, title, thumbnail_url, published_at,
                    duration, is_live, thumb_w, thumb_h)
                   VALUES (:video_id, :channel_id, :title, :thumbnail_url,
                           :published_at, :duration, :is_live, :thumb_w, :thumb_h)""",
                v,
            )
            if muted or (not allow_shorts and is_short(v)):
                c.execute(
                    """INSERT INTO video_status (video_id, channel_id, status)
                       VALUES (?, ?, 'read')
                       ON CONFLICT(video_id) DO NOTHING""",
                    (v["video_id"], channel_id),
                )
        c.execute(
            "UPDATE channels SET last_refreshed=? WHERE channel_id=?",
            (now, channel_id),
        )
        c.commit()
