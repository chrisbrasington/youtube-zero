"""Nuke (mark-everything-read) must leave the queue + deep queue alone and
record a snapshot of what it swept for /history."""
import httpx
import pytest


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _seed(m):
    with m.db() as c:
        c.execute("INSERT INTO channels (channel_id, name, uploads_playlist_id) "
                  "VALUES ('UC1', 'Chan One', 'UU1')")
        for i in range(4):
            c.execute("INSERT INTO videos (video_id, channel_id, title, thumbnail_url, published_at, duration) "
                      "VALUES (?, 'UC1', ?, 't', ?, '10:00')", (f"v{i}", f"Video {i}", f"2026-11-0{i+1}T00:00:00Z"))
        # v0 in main queue, v1 in deep queue
        c.execute("INSERT INTO queue (video_id, channel_id, channel_name, title, sort_order, is_deep) "
                  "VALUES ('v0','UC1','Chan One','Video 0',0,0)")
        c.execute("INSERT INTO queue (video_id, channel_id, channel_name, title, sort_order, is_deep) "
                  "VALUES ('v1','UC1','Chan One','Video 1',0,1)")
        # v2 already read
        c.execute("INSERT INTO video_status (video_id, channel_id, status) VALUES ('v2','UC1','read')")
        c.commit()


async def test_nuke_keeps_queue_and_records_snapshot(client, fresh_db):
    _seed(fresh_db)
    r = await client.post("/api/clear-all")
    assert r.status_code == 200
    assert r.json()["count"] == 1  # only v3: v0/v1 queued, v2 already read

    q = {i["video_id"]: i["is_deep"] for i in (await client.get("/api/queue")).json()}
    assert q == {"v0": 0, "v1": 1}

    nukes = (await client.get("/api/nukes")).json()
    assert nukes["total"] == 1
    n = nukes["items"][0]
    assert n["video_count"] == 1 and n["source"] == "web"

    d = (await client.get(f"/api/nukes/{n['id']}")).json()
    assert [v["video_id"] for v in d["videos"]] == ["v3"]
    assert d["videos"][0]["channel_name"] == "Chan One"
    assert d["videos"][0]["in_queue"] is False


async def test_queue_from_nuke_history(client, fresh_db):
    _seed(fresh_db)
    await client.post("/api/clear-all")
    nid = (await client.get("/api/nukes")).json()["items"][0]["id"]
    v = (await client.get(f"/api/nukes/{nid}")).json()["videos"][0]
    r = await client.post("/api/queue", json={
        "video_id": v["video_id"], "channel_id": v["channel_id"],
        "channel_name": v["channel_name"], "title": v["title"],
        "thumbnail_url": v["thumbnail_url"], "published_at": v["published_at"],
    })
    assert r.status_code == 200
    d = (await client.get(f"/api/nukes/{nid}")).json()
    assert d["videos"][0]["in_queue"] is True


async def test_nuke_detail_404(client, fresh_db):
    assert (await client.get("/api/nukes/9999")).status_code == 404
