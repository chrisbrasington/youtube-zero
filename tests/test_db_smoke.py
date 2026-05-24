"""Smoke tests for the SQLite layer.

These tests verify that init_db produces the expected schema and that basic
CRUD round-trips work. They will catch the obvious break — a typo'd column
name, a renamed table, a botched migration — during the Phase 2 refactor.
"""


def test_schema_has_expected_tables(main_module):
    with main_module.db() as c:
        rows = c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    names = {r["name"] for r in rows}
    expected = {"settings", "channels", "folders", "videos",
                "queue", "video_status", "quota_log"}
    assert expected <= names


def test_settings_round_trip(fresh_db):
    main = fresh_db
    with main.db() as c:
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                  ("api_key", "test-key-123"))
        c.commit()
        row = c.execute(
            "SELECT value FROM settings WHERE key = ?", ("api_key",)
        ).fetchone()
    assert row["value"] == "test-key-123"


def test_queue_insert_and_read(fresh_db):
    main = fresh_db
    with main.db() as c:
        c.execute(
            "INSERT INTO queue (video_id, channel_id, channel_name, title, "
            "thumbnail_url, published_at, sort_order) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("vid1", "ch1", "Channel One", "Hello World",
             "http://example/x.jpg", "2026-01-01T00:00:00Z", 0),
        )
        c.commit()
        row = c.execute(
            "SELECT video_id, title FROM queue WHERE video_id = ?", ("vid1",)
        ).fetchone()
    assert row["video_id"] == "vid1"
    assert row["title"] == "Hello World"


def test_quota_log_round_trip(fresh_db):
    main = fresh_db
    main.add_quota(5)
    main.add_quota(3)
    today = main._quota_today()
    with main.db() as c:
        row = c.execute(
            "SELECT units FROM quota_log WHERE date = ?", (today,)
        ).fetchone()
    assert row["units"] >= 8


def test_is_short_threshold(main_module):
    short = {"duration": "2:30", "is_live": "none"}
    long_ = {"duration": "5:00", "is_live": "none"}
    assert main_module._is_short(short) is True
    assert main_module._is_short(long_) is False


def test_duration_seconds_parsing(main_module):
    assert main_module._duration_seconds("1:02:03") == 3723
    assert main_module._duration_seconds("0:45") == 45
    assert main_module._duration_seconds("") == 0


def test_parse_duration_iso_to_colon(main_module):
    assert main_module.parse_duration("PT1H2M3S") == "1:02:03"
    assert main_module.parse_duration("PT4M33S") == "4:33"
    assert main_module.parse_duration("PT45S") == "0:45"
    assert main_module.parse_duration("") == ""


def test_parse_yt_video_id(main_module):
    cases = [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtube.com/shorts/abc123XYZab", "abc123XYZab"),
    ]
    for url, want in cases:
        assert main_module._parse_yt_video_id(url) == want, url
