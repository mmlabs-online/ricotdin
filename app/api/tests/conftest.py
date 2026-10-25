"""Shared fixtures. Integration tests (``*_integration.py``) need DATABASE_URL and are skipped
without it (CLAUDE.md §0): locally ``uv run --env-file .env pytest``, in CI a pgvector service."""

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

API_ROOT = Path(__file__).resolve().parents[1]

requires_db = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set (integration test)"
)


def alembic_upgrade(url: str, target: str = "head") -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, target)


def alembic_downgrade(url: str, target: str = "base") -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(API_ROOT / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.downgrade(cfg, target)


def pytest_sessionstart(session: pytest.Session) -> None:
    """Drop leftovers of interrupted runs once, before any scratch database of this session exists.

    Never inside fixtures or generate(): that would drop databases this session still uses.
    """
    if os.environ.get("DATABASE_URL"):
        from app.db.scratch import drop_stale

        drop_stale()


@pytest.fixture(scope="session")
def v2_db() -> Iterator[str]:
    """A scratch database migrated to head, shared by the read-only integration tests."""
    from app.db.scratch import scratch_database

    with scratch_database("v2") as url:
        alembic_upgrade(url)
        yield url


@pytest.fixture(scope="session")
def v1_replay_db() -> Iterator[str]:
    from app.db.replay import replay_v1
    from app.db.scratch import scratch_database

    with scratch_database("v1") as url:
        replay_v1(url)
        yield url
