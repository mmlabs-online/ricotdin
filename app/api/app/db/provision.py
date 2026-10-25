"""Database login roles for the runtime (ARC-04, CLAUDE.md §0.1 R1/R7). Needs the owner URL.

Each runtime group gets its own LOGIN role: NOINHERIT (no privileges until ``SET ROLE <group>``),
member of exactly that group, with statement/lock timeouts and a connection limit. Passwords
are generated here and only written to the caller's env file — never printed or logged.
Migrations never contain passwords, which is why this is a script and not a revision.
"""

import secrets
from dataclasses import dataclass
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg
from psycopg import sql

GROUP_LOGINS = {
    "ricotdin_app": ("ricotdin_api_login", "DATABASE_URL_APP", 20),
    "ricotdin_service": ("ricotdin_service_login", "DATABASE_URL_SERVICE", 10),
    "ricotdin_worker": ("ricotdin_worker_login", "DATABASE_URL_WORKER", 5),
}


@dataclass(frozen=True)
class Login:
    group: str
    name: str
    password: str

    def url(self, owner_url: str) -> str:
        """``owner_url`` with this login's credentials (same host, database and query)."""
        parts = urlsplit(owner_url)
        host = parts.netloc.rsplit("@", 1)[-1]
        netloc = f"{quote(self.name, safe='')}:{quote(self.password, safe='')}@{host}"
        return urlunsplit(parts._replace(netloc=netloc))


def ensure_login(
    owner_url: str,
    group: str,
    name: str,
    *,
    connection_limit: int,
    statement_timeout_ms: int = 15_000,
    lock_timeout_ms: int = 5_000,
) -> Login:
    """Create or rotate ``name`` as a NOINHERIT login in ``group`` only. Returns its password."""
    password = secrets.token_urlsafe(32)
    ident = sql.Identifier(name)
    with psycopg.connect(owner_url, autocommit=True) as conn:
        exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,)).fetchone()
        verb = "ALTER" if exists else "CREATE"
        conn.execute(
            sql.SQL(
                verb + " ROLE {} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS "
                "CONNECTION LIMIT {} PASSWORD {}"
            ).format(ident, sql.Literal(connection_limit), sql.Literal(password))
        )
        # Exactly one runtime group.
        for other in GROUP_LOGINS:
            if other != group:
                conn.execute(sql.SQL("REVOKE {} FROM {}").format(sql.Identifier(other), ident))
        conn.execute(sql.SQL("GRANT {} TO {}").format(sql.Identifier(group), ident))
        conn.execute(
            sql.SQL("ALTER ROLE {} SET statement_timeout = {}").format(
                ident, sql.Literal(f"{statement_timeout_ms}ms")
            )
        )
        conn.execute(
            sql.SQL("ALTER ROLE {} SET lock_timeout = {}").format(
                ident, sql.Literal(f"{lock_timeout_ms}ms")
            )
        )
    return Login(group, name, password)


def drop_login(owner_url: str, name: str) -> None:
    with psycopg.connect(owner_url, autocommit=True) as conn:
        conn.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(name)))
