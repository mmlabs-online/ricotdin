"""Disposable databases for the schema generator and integration tests (ARC-02).

``DATABASE_URL`` points at a database the caller may CREATE/DROP databases from (the Neon
``dev`` branch, or the CI service container). Each scratch database gets a unique
``ricotdin_test_*`` name and is dropped afterwards; leftovers from interrupted runs are dropped
by ``drop_stale``.
"""

import os
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg import sql

PREFIX = "ricotdin_test_"


def admin_url() -> str:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not set (see app/api/README.md)")
    return url


def url_for(dbname: str, base: str | None = None) -> str:
    """``base`` with its database swapped for ``dbname``, still a URL (SQLAlchemy needs one)."""
    parts = urlsplit(base or admin_url())
    return urlunsplit(parts._replace(path=f"/{dbname}"))


def drop_stale(base: str | None = None) -> list[str]:
    """Drop every leftover ``ricotdin_test_*`` database. Returns the names dropped."""
    with psycopg.connect(base or admin_url(), autocommit=True) as conn:
        names = [
            r[0]
            for r in conn.execute(
                "SELECT datname FROM pg_database WHERE starts_with(datname, %s)", (PREFIX,)
            )
        ]
        for name in names:
            conn.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
            )
        # Temporary login roles of interrupted test runs (cluster-wide, own no objects).
        roles = [
            r[0]
            for r in conn.execute(
                "SELECT rolname FROM pg_roles WHERE starts_with(rolname, %s)", (PREFIX,)
            )
        ]
        for role in roles:
            conn.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))
    return names + roles


@contextmanager
def scratch_database(label: str) -> Iterator[str]:
    """Create an empty database, yield its connection URL, drop it on exit."""
    name = f"{PREFIX}{label}_{secrets.token_hex(4)}"
    base = admin_url()
    with psycopg.connect(base, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        yield url_for(name, base)
    finally:
        with psycopg.connect(base, autocommit=True) as conn:
            conn.execute(
                sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name))
            )
