"""Runtime database access (ARC-04, CLAUDE.md §0.1 R1–R8).

One async engine per runtime role, each with its own login (R1). At startup every configured
login is checked (``identity_problems``) and the API refuses to start if it can reach more than
its group (R2). Work always happens inside a transaction that first switches to the group role;
API requests additionally set the RLS context transaction-locally with bind parameters (R3/R4).
On return to the pool every connection is rolled back and ``RESET ROLE; RESET ALL`` runs, so no
role or setting — transaction- or session-level — survives into the next checkout (R6).
Bound parameters are never rendered into error messages (password/token hashes, ARC-05).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import Request
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from app.core.errors import ServiceUnavailable
from app.core.logging import get_logger
from app.core.settings import Settings
from app.db.context import RequestIdentity, rls_context_statements
from app.db.identity import LoginFacts, identity_problems
from app.db.urls import asyncpg_engine_args

log = get_logger("db")

SERVICE_GROUPS = ("ricotdin_service", "ricotdin_worker")

# Everything the login can reach, transitively (pg_has_role follows membership chains and the
# PG16+ per-grant SET / INHERIT options).
_FACTS = text(
    """
    WITH me AS (SELECT * FROM pg_roles WHERE rolname = current_user),
    reach AS (
      SELECT g.rolname, g.rolsuper, g.rolbypassrls, g.rolcreaterole,
             pg_has_role(me.oid, g.oid, 'SET') AS can_set,
             pg_has_role(me.oid, g.oid, 'USAGE') AS inherits,
             EXISTS (SELECT 1 FROM pg_tables t
                     WHERE t.schemaname = 'public' AND t.tableowner = g.rolname) AS owns
      FROM pg_roles g, me WHERE g.oid <> me.oid
    )
    SELECT me.rolname, me.rolsuper, me.rolbypassrls, me.rolcreaterole,
           EXISTS (SELECT 1 FROM pg_tables t
                   WHERE t.schemaname = 'public' AND t.tableowner = me.rolname) AS owns_tables,
           ARRAY(SELECT rolname FROM reach WHERE can_set) AS settable,
           ARRAY(SELECT rolname FROM reach WHERE inherits) AS inherited,
           ARRAY(SELECT rolname FROM reach
                 WHERE can_set AND (rolsuper OR rolbypassrls OR rolcreaterole OR owns))
             AS privileged
    FROM me
    """
)


class StartupRefused(RuntimeError):
    """A database login failed the startup identity check."""


async def login_facts(conn: AsyncConnection, expected_group: str) -> LoginFacts:
    row = (await conn.execute(_FACTS)).one()
    return LoginFacts(
        login=row.rolname,
        expected_group=expected_group,
        settable_roles=set(row.settable),
        inherited_roles=set(row.inherited),
        privileged_roles=set(row.privileged),
        is_superuser=row.rolsuper,
        bypasses_rls=row.rolbypassrls,
        can_create_roles=row.rolcreaterole,
        owns_public_tables=row.owns_tables,
    )


def _reset_on_return(dbapi_connection: Any, connection_record: Any, reset_state: Any) -> None:
    """Runs after the pool's rollback: clear session-level role and settings too.

    The asyncpg adapter opens an implicit transaction for these statements and SET/RESET are
    transactional in Postgres, so it must be committed or the reset is undone by the rollback.
    """
    try:
        cursor = dbapi_connection.cursor()
        cursor.execute("RESET ROLE")
        cursor.execute("RESET ALL")
        cursor.close()
        dbapi_connection.commit()
    except Exception:  # noqa: BLE001 - a connection we cannot reset is not reused
        connection_record.invalidate()


def _engine_for(settings: Settings, group: str, url: str) -> AsyncEngine:
    async_url, args = asyncpg_engine_args(
        url,
        statement_timeout_ms=settings.db_statement_timeout_ms,
        lock_timeout_ms=settings.db_lock_timeout_ms,
        application_name=f"ricotdin-{group.removeprefix('ricotdin_')}",
    )
    pool_size, overflow = {
        "ricotdin_app": settings.db_pool_app,
        "ricotdin_service": settings.db_pool_service,
        "ricotdin_worker": settings.db_pool_worker,
    }[group]
    engine = create_async_engine(
        async_url,
        connect_args=args,
        pool_size=pool_size,
        max_overflow=overflow,
        pool_pre_ping=True,
        pool_recycle=300,  # Neon suspends idle compute
        hide_parameters=True,
    )
    event.listen(engine.sync_engine, "reset", _reset_on_return)
    return engine


@dataclass
class Database:
    _engines: dict[str, AsyncEngine] = field(default_factory=dict)  # group role -> engine

    @classmethod
    async def start(cls, settings: Settings) -> "Database":
        db = cls()
        urls = {
            "ricotdin_app": settings.database_url_app,
            "ricotdin_service": settings.database_url_service,
            "ricotdin_worker": settings.database_url_worker,
        }
        try:
            for group, secret in urls.items():
                if secret is None:
                    continue
                engine = _engine_for(settings, group, secret.get_secret_value())
                db._engines[group] = engine  # disposed by close() on any failure below
                async with engine.connect() as conn:
                    problems = identity_problems(await login_facts(conn, group))
                if problems:
                    raise StartupRefused(f"database login for {group}: " + "; ".join(problems))
        except BaseException:
            await db.close()
            raise
        if not db._engines:
            log.warning("no DATABASE_URL_* configured: database routes are unavailable")
        return db

    @property
    def groups(self) -> set[str]:
        return set(self._engines)

    async def close(self) -> None:
        for engine in self._engines.values():
            await engine.dispose()
        self._engines.clear()

    def _engine(self, group: str) -> AsyncEngine:
        engine = self._engines.get(group)
        if engine is None:
            raise ServiceUnavailable(detail=f"{group} database login is not configured")
        return engine

    @asynccontextmanager
    async def app_transaction(self, identity: RequestIdentity) -> AsyncIterator[AsyncConnection]:
        """A transaction as ricotdin_app with the RLS context of the verified identity.

        Do not call ``commit()`` inside: a new transaction would start without role or context.
        """
        async with self._engine("ricotdin_app").begin() as conn:
            for sql, params in rls_context_statements(identity):
                await conn.execute(text(sql), params)
            yield conn

    @asynccontextmanager
    async def role_transaction(self, group: str) -> AsyncIterator[AsyncConnection]:
        """A transaction as ricotdin_service or ricotdin_worker (no user context)."""
        if group not in SERVICE_GROUPS:
            raise ValueError(f"not a service group: {group}")
        async with self._engine(group).begin() as conn:
            await conn.execute(text(f"SET LOCAL ROLE {group}"))
            yield conn

    @asynccontextmanager
    async def raw_connection(self, group: str) -> AsyncIterator[AsyncConnection]:
        """A pooled connection as the bare login (tests/diagnostics only: no privileges)."""
        async with self._engine(group).connect() as conn:
            yield conn


def get_database(request: Request) -> Database:
    """FastAPI dependency: the Database started in the lifespan. ARC-05 adds the identity
    dependency; routes then use ``db.app_transaction(identity)`` per request."""
    db: Database = request.app.state.db
    return db
