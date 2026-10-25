"""ARC-04: the runtime database layer against a real database (CLAUDE.md §0.1 R1–R8).

Temporary login roles (``ricotdin_test_*``, dropped afterwards and by ``drop_stale``) are created
with ``ensure_login`` exactly like the provisioning script and used through ``Database``.
"""

import secrets
import uuid
from collections.abc import Awaitable, Callable, Iterator
from typing import Any

import anyio
import psycopg
import pytest
from psycopg import sql
from pydantic import SecretStr
from sqlalchemy import text

from app.core.errors import ServiceUnavailable
from app.core.settings import Settings
from app.db.context import RequestIdentity
from app.db.provision import Login, drop_login, ensure_login
from app.db.scratch import admin_url, scratch_database
from app.db.session import Database, StartupRefused
from tests.conftest import alembic_upgrade, requires_db

pytestmark = requires_db

USER = uuid.uuid4()


@pytest.fixture(scope="module")
def env() -> Iterator[dict[str, Any]]:
    suffix = secrets.token_hex(3)
    owner = admin_url()
    with scratch_database("sess") as url:
        alembic_upgrade(url)
        logins = {
            "app": ensure_login(
                owner, "ricotdin_app", f"ricotdin_test_api_{suffix}", connection_limit=5
            ),
            "service": ensure_login(
                owner, "ricotdin_service", f"ricotdin_test_svc_{suffix}", connection_limit=5
            ),
        }
        try:
            yield {"db": url, "suffix": suffix, **logins}
        finally:
            for login in logins.values():
                drop_login(owner, login.name)


def _url(env: dict[str, Any], key: str) -> str:
    login: Login = env[key]
    return login.url(env["db"])


def _settings(
    app: str | None = None, service: str | None = None, pool: tuple[int, int] = (5, 0)
) -> Settings:
    s = Settings()
    s.database_url_app = SecretStr(app) if app else None
    s.database_url_service = SecretStr(service) if service else None
    s.database_url_worker = None
    s.db_pool_app = pool
    return s


def _run[T](settings: Settings, body: Callable[[Database], Awaitable[T]]) -> T:
    async def go() -> T:
        db = await Database.start(settings)
        try:
            return await body(db)
        finally:
            await db.close()

    return anyio.run(go)


async def _noop(db: Database) -> None:
    return None


def _owner_exec(statement: sql.Composed | sql.SQL) -> None:
    with psycopg.connect(admin_url(), autocommit=True) as conn:
        conn.execute(statement)


def test_app_transaction_runs_as_app_role_with_the_identity(env: dict[str, Any]) -> None:
    async def body(db: Database) -> tuple[Any, ...]:
        async with db.app_transaction(RequestIdentity(USER, "user")) as conn:
            q = "SELECT current_user, app_user_id()::text, app_user_role(), current_setting('statement_timeout')"
            return tuple((await conn.execute(text(q))).one())

    assert _run(_settings(_url(env, "app")), body) == ("ricotdin_app", str(USER), "user", "15s")


def test_same_pooled_connection_keeps_no_context_after_a_request(env: dict[str, Any]) -> None:
    async def body(db: Database) -> tuple[int, int, Any, Any]:
        async with db.app_transaction(RequestIdentity(USER, "admin")) as conn:
            pid1 = (await conn.execute(text("SELECT pg_backend_pid()"))).scalar_one()
        async with db.raw_connection("ricotdin_app") as conn:
            row = (
                await conn.execute(text("SELECT pg_backend_pid(), app_user_id(), current_user"))
            ).one()
        return pid1, row[0], row[1], row[2]

    pid1, pid2, user, role = _run(_settings(_url(env, "app"), pool=(1, 0)), body)
    assert pid1 == pid2  # really the same connection
    assert user is None and role.startswith("ricotdin_test_api_")


def test_session_level_role_and_settings_are_reset_on_return(env: dict[str, Any]) -> None:
    async def body(db: Database) -> tuple[Any, Any, Any]:
        async with db.raw_connection("ricotdin_app") as conn:
            await conn.execute(text("SET ROLE ricotdin_app"))
            await conn.execute(
                text("SELECT set_config('app.user_id', :u, false)"), {"u": str(USER)}
            )
            await conn.commit()
        async with db.raw_connection("ricotdin_app") as conn:
            return tuple(
                (
                    await conn.execute(
                        text(
                            "SELECT current_user, app_user_id(), current_setting('app.role', true)"
                        )
                    )
                ).one()
            )

    role, user, app_role = _run(_settings(_url(env, "app"), pool=(1, 0)), body)
    assert role.startswith("ricotdin_test_api_")
    assert user is None and not app_role


def test_an_error_inside_a_request_transaction_leaves_nothing_behind(env: dict[str, Any]) -> None:
    async def body(db: Database) -> Any:
        with pytest.raises(ZeroDivisionError):
            async with db.app_transaction(RequestIdentity(USER, "user")):
                _ = 1 / 0
        async with db.raw_connection("ricotdin_app") as conn:
            return (await conn.execute(text("SELECT app_user_id()"))).scalar_one()

    assert _run(_settings(_url(env, "app"), pool=(1, 0)), body) is None


def test_app_login_without_set_role_has_no_privileges(env: dict[str, Any]) -> None:
    async def body(db: Database) -> None:
        async with db.raw_connection("ricotdin_app") as conn:
            await conn.execute(text("SELECT 1 FROM meetings"))

    with pytest.raises(Exception, match="permission denied"):
        _run(_settings(_url(env, "app")), body)


def test_service_transaction_runs_as_service(env: dict[str, Any]) -> None:
    async def body(db: Database) -> Any:
        async with db.role_transaction("ricotdin_service") as conn:
            return (await conn.execute(text("SELECT current_user"))).scalar_one()

    assert _run(_settings(service=_url(env, "service")), body) == "ricotdin_service"


def test_unconfigured_group_is_a_typed_503(env: dict[str, Any]) -> None:
    async def body(db: Database) -> None:
        async with db.role_transaction("ricotdin_worker"):
            pass

    with pytest.raises(ServiceUnavailable):
        _run(_settings(service=_url(env, "service")), body)


def test_startup_refuses_the_owner_login(env: dict[str, Any]) -> None:
    with pytest.raises(StartupRefused, match="owns tables|cannot SET ROLE"):
        _run(_settings(env["db"]), _noop)


def test_startup_refuses_a_login_in_two_groups(env: dict[str, Any]) -> None:
    name = sql.Identifier(env["app"].name)
    _owner_exec(sql.SQL("GRANT ricotdin_service TO {} WITH INHERIT FALSE").format(name))
    try:
        with pytest.raises(StartupRefused, match="also SET ROLE to: ricotdin_service"):
            _run(_settings(_url(env, "app")), _noop)
    finally:
        _owner_exec(sql.SQL("REVOKE ricotdin_service FROM {}").format(name))


def test_startup_refuses_an_indirect_membership_chain(env: dict[str, Any]) -> None:
    mid = sql.Identifier(f"ricotdin_test_mid_{env['suffix']}")
    name = sql.Identifier(env["app"].name)
    _owner_exec(sql.SQL("CREATE ROLE {} NOLOGIN").format(mid))
    try:
        _owner_exec(sql.SQL("GRANT ricotdin_service TO {}").format(mid))
        _owner_exec(sql.SQL("GRANT {} TO {} WITH INHERIT FALSE").format(mid, name))
        with pytest.raises(StartupRefused, match="also SET ROLE to: .*ricotdin_service"):
            _run(_settings(_url(env, "app")), _noop)
    finally:
        _owner_exec(sql.SQL("DROP ROLE IF EXISTS {}").format(mid))


def test_startup_refuses_a_grant_with_inherit_true(env: dict[str, Any]) -> None:
    # PG16+: per-grant INHERIT survives the login's NOINHERIT; re-provisioning must fix it.
    name = sql.Identifier(env["app"].name)
    _owner_exec(sql.SQL("GRANT ricotdin_app TO {} WITH INHERIT TRUE").format(name))
    try:
        with pytest.raises(StartupRefused, match="inherits privileges of: ricotdin_app"):
            _run(_settings(_url(env, "app")), _noop)
    finally:
        _owner_exec(sql.SQL("GRANT ricotdin_app TO {} WITH INHERIT FALSE").format(name))


def test_startup_refuses_when_the_group_itself_inherits_another_role(env: dict[str, Any]) -> None:
    extra = sql.Identifier(f"ricotdin_test_extra_{env['suffix']}")
    _owner_exec(sql.SQL("CREATE ROLE {} NOLOGIN").format(extra))
    try:
        _owner_exec(sql.SQL("GRANT {} TO ricotdin_app WITH INHERIT TRUE").format(extra))
        with pytest.raises(StartupRefused, match=r"the group\) inherits privileges of"):
            _run(_settings(_url(env, "app")), _noop)
    finally:
        _owner_exec(sql.SQL("DROP ROLE IF EXISTS {}").format(extra))
