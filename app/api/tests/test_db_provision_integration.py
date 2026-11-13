"""ARC-20: runtime logins on the shared self-hosted Postgres (deployment repo, postgres/).

There the owner is not a superuser (CREATEROLE only) and every database privilege is revoked from
PUBLIC (postgres/sql/app-db.sql). ``ensure_login`` must create AND rotate logins as that owner and
grant CONNECT on the owner's database itself.
"""

import secrets
from collections.abc import Iterator

import psycopg
import pytest
from psycopg import sql

from app.db.provision import Login, drop_login, ensure_login
from app.db.scratch import scratch_database
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db


@pytest.fixture
def owner_url() -> Iterator[str]:
    """A scratch database with no PUBLIC privileges and a CREATEROLE-only owner login."""
    suffix = secrets.token_hex(3)
    owner = f"ricotdin_test_own_{suffix}"
    password = secrets.token_hex(16)
    with scratch_database("provision") as url:
        alembic_upgrade(url)
        with psycopg.connect(url, autocommit=True) as conn:
            db = sql.Identifier(conn.execute("SELECT current_database()").fetchone()[0])  # type: ignore[index]
            ident = sql.Identifier(owner)
            conn.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(db))
            conn.execute(
                sql.SQL("CREATE ROLE {} LOGIN CREATEROLE PASSWORD {}").format(
                    ident, sql.Literal(password)
                )
            )
            conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(db, ident))
            conn.execute(sql.SQL("ALTER DATABASE {} OWNER TO {}").format(db, ident))
            for group in ("ricotdin_app", "ricotdin_service", "ricotdin_worker"):
                conn.execute(
                    sql.SQL("GRANT {} TO {} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE").format(
                        sql.Identifier(group), ident
                    )
                )
        try:
            yield Login("", owner, password).url(url)
        finally:
            with psycopg.connect(url, autocommit=True) as conn:
                conn.execute(sql.SQL("ALTER DATABASE {} OWNER TO CURRENT_USER").format(db))
                conn.execute(sql.SQL("REVOKE CONNECT ON DATABASE {} FROM {}").format(db, ident))
                conn.execute(sql.SQL("DROP ROLE {}").format(ident))


def _whoami(url: str) -> object:
    with psycopg.connect(url) as conn:
        return conn.execute("SELECT current_user").fetchone()


def test_non_superuser_owner_creates_and_rotates_a_login_that_can_connect(owner_url: str) -> None:
    name = f"ricotdin_test_wrk_{secrets.token_hex(3)}"
    login = ensure_login(owner_url, "ricotdin_worker", name, connection_limit=2)
    try:
        assert _whoami(login.url(owner_url)) == (name,)
        rotated = ensure_login(owner_url, "ricotdin_worker", name, connection_limit=2)
        assert rotated.password != login.password
        assert _whoami(rotated.url(owner_url)) == (name,)
        with pytest.raises(psycopg.OperationalError):
            _whoami(login.url(owner_url))  # the old password no longer works
    finally:
        drop_login(owner_url, name)
