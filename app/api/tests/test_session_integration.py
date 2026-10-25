"""ARC-04: the runtime database layer against a real database (CLAUDE.md §0.1 R1–R8).

Temporary login roles (random names) are created with ``ensure_login`` exactly like the
provisioning script, used through ``app.db.session.Database`` and dropped afterwards.
"""

import secrets
import uuid
from collections.abc import Iterator

import anyio
import pytest
from pydantic import SecretStr
from sqlalchemy import text

from app.core.settings import Settings
from app.db.context import RequestIdentity
from app.db.provision import Login, drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.db.session import Database, StartupRefused
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db

USER = uuid.uuid4()


@pytest.fixture(scope="module")
def env() -> Iterator[dict[str, Login | str]]:
    suffix = secrets.token_hex(3)
    owner = admin_url()
    with scratch_database("sess") as url:
        alembic_upgrade(url)
        logins = {
            "app": ensure_login(owner, "ricotdin_app", f"t_api_{suffix}", connection_limit=5),
            "service": ensure_login(
                owner, "ricotdin_service", f"t_svc_{suffix}", connection_limit=5
            ),
        }
        try:
            yield {"db": url, **logins}
        finally:
            for login in logins.values():
                drop_login(owner, login.name)


def _settings(app_url: str | None = None, service_url: str | None = None) -> Settings:
    s = Settings()
    s.database_url_app = SecretStr(app_url) if app_url else None
    s.database_url_service = SecretStr(service_url) if service_url else None
    s.database_url_worker = None
    return s


def _url(env: dict[str, Login | str], key: str) -> str:
    login = env[key]
    assert isinstance(login, Login)
    db = env["db"]
    assert isinstance(db, str)
    return login.url(db)


def test_app_transaction_runs_as_app_role_with_the_identity(env: dict[str, Login | str]) -> None:
    async def run() -> tuple[str, str, str, str]:
        db = await Database.start(_settings(_url(env, "app")))
        try:
            async with db.app_transaction(RequestIdentity(USER, "user")) as conn:
                row = (
                    await conn.execute(
                        text(
                            "SELECT current_user, app_user_id()::text, app_user_role(), "
                            "current_setting('statement_timeout')"
                        )
                    )
                ).one()
                return row[0], row[1], row[2], row[3]
        finally:
            await db.close()

    assert anyio.run(run) == ("ricotdin_app", str(USER), "user", "15s")


def test_context_does_not_survive_on_a_reused_connection(env: dict[str, Login | str]) -> None:
    # R6: one pooled connection, two transactions — the second sees no user and no role switch.
    async def run() -> tuple[str | None, str]:
        db = await Database.start(_settings(_url(env, "app")))
        try:
            async with db.app_transaction(RequestIdentity(USER, "admin")):
                pass
            engine = db.engines["ricotdin_app"]
            async with engine.connect() as conn:
                row = (await conn.execute(text("SELECT app_user_id()::text, current_user"))).one()
                return row[0], row[1]
        finally:
            await db.close()

    user, role = anyio.run(run)
    assert user is None
    assert role.startswith("t_api_")


def test_app_login_without_set_role_has_no_privileges(env: dict[str, Login | str]) -> None:
    # NOINHERIT: an injected statement before SET ROLE reaches nothing.
    async def run() -> None:
        db = await Database.start(_settings(_url(env, "app")))
        try:
            async with db.engines["ricotdin_app"].connect() as conn:
                await conn.execute(text("SELECT 1 FROM meetings"))
        finally:
            await db.close()

    with pytest.raises(Exception, match="permission denied"):
        anyio.run(run)


def test_service_transaction_runs_as_service(env: dict[str, Login | str]) -> None:
    async def run() -> str:
        db = await Database.start(_settings(service_url=_url(env, "service")))
        try:
            async with db.role_transaction("ricotdin_service") as conn:
                return str((await conn.execute(text("SELECT current_user"))).scalar_one())
        finally:
            await db.close()

    assert anyio.run(run) == "ricotdin_service"


def test_startup_refuses_the_owner_login(env: dict[str, Login | str]) -> None:
    db_url = env["db"]
    assert isinstance(db_url, str)

    async def run() -> None:
        await Database.start(_settings(db_url))

    with pytest.raises(StartupRefused, match="owns tables|not a member"):
        anyio.run(run)


def test_startup_refuses_a_login_in_two_groups(env: dict[str, Login | str]) -> None:
    import psycopg

    login = env["app"]
    assert isinstance(login, Login)
    with psycopg.connect(admin_url(), autocommit=True) as conn:
        conn.execute(f'GRANT ricotdin_service TO "{login.name}"')  # noqa: S608 - test-only name
    try:

        async def run() -> None:
            await Database.start(_settings(_url(env, "app")))

        with pytest.raises(StartupRefused, match="also a member of ricotdin_service"):
            anyio.run(run)
    finally:
        with psycopg.connect(admin_url(), autocommit=True) as conn:
            conn.execute(f'REVOKE ricotdin_service FROM "{login.name}"')  # noqa: S608
