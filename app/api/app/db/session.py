"""Runtime database access (ARC-04, CLAUDE.md §0.1 R1–R8).

One async engine per runtime role, each with its own login (R1). At startup every configured
login is checked (``identity_problems``) and the API refuses to start if one has more power than
its job (R2). Work always happens inside a transaction that first switches to the group role;
API requests additionally set the RLS context transaction-locally with bind parameters (R3/R4).
A transaction ends with commit/rollback, so nothing survives on a pooled connection (R6).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from app.core.logging import get_logger
from app.core.settings import Settings
from app.db.context import RequestIdentity, rls_context_statements
from app.db.identity import RUNTIME_GROUPS, LoginFacts, identity_problems
from app.db.urls import asyncpg_engine_args

log = get_logger("db")

_FACTS = text(
    """
    SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolinherit,
           ARRAY(SELECT g.rolname FROM pg_auth_members m
                 JOIN pg_roles g ON g.oid = m.roleid
                 WHERE m.member = r.oid AND (m.set_option OR m.inherit_option)
                   AND g.rolname = ANY(:groups)) AS member_of,
           EXISTS (SELECT 1 FROM pg_tables t
                   WHERE t.schemaname = 'public' AND t.tableowner = r.rolname) AS owns_tables
    FROM pg_roles r WHERE r.rolname = current_user
    """
)


class StartupRefused(RuntimeError):
    """A database login failed the startup identity check."""


async def login_facts(conn: AsyncConnection, expected_group: str) -> LoginFacts:
    row = (await conn.execute(_FACTS, {"groups": list(RUNTIME_GROUPS)})).one()
    return LoginFacts(
        login=row.rolname,
        expected_group=expected_group,
        member_of=set(row.member_of),
        is_superuser=row.rolsuper,
        bypasses_rls=row.rolbypassrls,
        inherits=row.rolinherit,
        owns_public_tables=row.owns_tables,
    )


@dataclass
class Database:
    engines: dict[str, AsyncEngine] = field(default_factory=dict)  # group role -> engine

    @classmethod
    async def start(cls, settings: Settings) -> "Database":
        db = cls()
        urls = {
            "ricotdin_app": settings.database_url_app,
            "ricotdin_service": settings.database_url_service,
            "ricotdin_worker": settings.database_url_worker,
        }
        for group, secret in urls.items():
            if secret is None:
                continue
            url, args = asyncpg_engine_args(
                secret.get_secret_value(),
                statement_timeout_ms=settings.db_statement_timeout_ms,
                lock_timeout_ms=settings.db_lock_timeout_ms,
                application_name=f"ricotdin-{group.removeprefix('ricotdin_')}",
            )
            engine = create_async_engine(url, connect_args=args, pool_pre_ping=True)
            async with engine.connect() as conn:
                problems = identity_problems(await login_facts(conn, group))
            if problems:
                await engine.dispose()
                await db.close()
                raise StartupRefused(f"database login for {group}: " + "; ".join(problems))
            db.engines[group] = engine
        if not db.engines:
            log.warning("no DATABASE_URL_* configured: database routes are unavailable")
        return db

    async def close(self) -> None:
        for engine in self.engines.values():
            await engine.dispose()
        self.engines.clear()

    def _engine(self, group: str) -> AsyncEngine:
        engine = self.engines.get(group)
        if engine is None:
            raise RuntimeError(f"{group} database login is not configured")
        return engine

    @asynccontextmanager
    async def app_transaction(self, identity: RequestIdentity) -> AsyncIterator[AsyncConnection]:
        """A transaction as ricotdin_app with the RLS context of the verified identity."""
        async with self._engine("ricotdin_app").begin() as conn:
            for sql, params in rls_context_statements(identity):
                await conn.execute(text(sql), params)
            yield conn

    @asynccontextmanager
    async def role_transaction(self, group: str) -> AsyncIterator[AsyncConnection]:
        """A transaction as ricotdin_service or ricotdin_worker (no user context)."""
        if group not in ("ricotdin_service", "ricotdin_worker"):
            raise ValueError(f"not a service group: {group}")
        async with self._engine(group).begin() as conn:
            await conn.execute(text(f"SET LOCAL ROLE {group}"))
            yield conn
