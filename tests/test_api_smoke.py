"""Smoke tests for the FastAPI surface.

We don't trigger lifespan (no background tasks start) — httpx.ASGITransport
calls handlers directly. The goal is to verify that the app boots and core
read endpoints return sane shapes. Write endpoints are tested only for the
ones we'll definitely touch during refactor.
"""
import pytest
import httpx


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport,
                                 base_url="http://test") as c:
        yield c


async def test_settings_get_returns_dict(client, fresh_db):
    # NOTE: /api/settings has a duplicate @app.get decorator at main.py:1021
    # which shadows the real settings route — first registration wins, so this
    # endpoint actually returns quota data. Captured as-is here so the smoke
    # test reflects current behavior; flagged for Phase 2 cleanup.
    r = await client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, dict)


async def test_channels_list_returns_list(client, fresh_db):
    r = await client.get("/api/channels")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_feed_returns_shape(client, fresh_db):
    r = await client.get("/api/feed")
    assert r.status_code == 200
    body = r.json()
    assert "channels" in body
    assert isinstance(body["channels"], list)


async def test_queue_list_returns_list(client, fresh_db):
    r = await client.get("/api/queue")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_quota_get_returns_dict(client, fresh_db):
    r = await client.get("/api/quota")
    assert r.status_code == 200
    body = r.json()
    assert "used" in body or "today" in body or isinstance(body, dict)


async def test_signal_settings_get(client, fresh_db):
    r = await client.get("/api/settings/signal")
    assert r.status_code == 200
    assert isinstance(r.json(), dict)


async def test_tv_settings_get(client, fresh_db):
    r = await client.get("/api/settings/tv")
    assert r.status_code == 200
    assert isinstance(r.json(), dict)


async def test_set_and_read_api_key(client, fresh_db):
    r = await client.post("/api/settings/api-key",
                          json={"api_key": "smoke-key"})
    assert r.status_code == 200
    # Read back via DB since /api/settings GET is shadowed (see note above).
    main = fresh_db
    with main.db() as c:
        row = c.execute(
            "SELECT value FROM settings WHERE key = 'api_key'"
        ).fetchone()
    assert row["value"] == "smoke-key"


async def test_set_hide_shorts(client, fresh_db):
    r = await client.post("/api/settings/hide-shorts",
                          json={"hide_shorts": True})
    assert r.status_code == 200
    main = fresh_db
    with main.db() as c:
        row = c.execute(
            "SELECT value FROM settings WHERE key = 'hide_shorts'"
        ).fetchone()
    assert row["value"] == "1"


async def test_index_html_served(client, fresh_db):
    r = await client.get("/")
    assert r.status_code == 200
    assert "<html" in r.text.lower()
