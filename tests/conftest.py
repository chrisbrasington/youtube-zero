"""Shared pytest fixtures.

DB_PATH must be set before `main` is imported, since main calls init_db() at
module load time. We use a session-scoped tmp file and stub the network-
touching globals (Signal/TV/YouTube API URLs) to non-routable defaults so
nothing leaks out during tests.
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest


_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["DB_PATH"] = _TMP_DB.name
os.environ.setdefault("SIGNAL_API_URL", "http://127.0.0.1:1")
os.environ.setdefault("ADB_API_URL", "http://127.0.0.1:1")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture(scope="session")
def app():
    import main
    return main.app


@pytest.fixture(scope="session")
def main_module():
    import main
    return main


@pytest.fixture
def fresh_db(main_module):
    """Wipe all tables between tests that need isolation."""
    with main_module.db() as c:
        for table in ("settings", "channels", "folders", "videos",
                      "queue", "video_status", "quota_log"):
            c.execute(f"DELETE FROM {table}")
        c.commit()
    yield main_module


def pytest_sessionfinish(session, exitstatus):
    try:
        os.unlink(_TMP_DB.name)
    except OSError:
        pass
