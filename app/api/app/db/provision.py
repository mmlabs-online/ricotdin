"""Database login roles for the runtime (ARC-04, CLAUDE.md §0.1 R1/R7). Needs the owner URL.

Each runtime group gets its own LOGIN role: NOINHERIT and granted its group ``WITH INHERIT
FALSE, SET TRUE`` (PG16+ per-grant option — no privileges until ``SET ROLE <group>``), member of
exactly that group, with statement / lock / idle-in-transaction timeouts and a connection
limit. Passwords are generated here, written only to the caller's env file and never printed.
Neon only accepts plaintext passwords in CREATE/ALTER ROLE (a pre-hashed SCRAM verifier is
rejected by its control plane), so the DDL carries the password: never enable statement logging
for these commands and rotate (re-run) if server logs may have captured one.
Migrations never contain passwords, which is why this is a script and not a revision.
"""

import os
import re
import secrets
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
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
    password: str = field(repr=False)

    def url(self, owner_url: str) -> str:
        """``owner_url`` with this login's credentials (same host, database and query)."""
        parts = urlsplit(owner_url)
        host = parts.netloc.rsplit("@", 1)[-1]
        netloc = f"{quote(self.name, safe='')}:{quote(self.password, safe='')}@{host}"
        return urlunsplit(parts._replace(netloc=netloc))


def set_env_line(lines: list[str], key: str, value: str) -> list[str]:
    """Replace every assignment of ``key`` (``KEY=``, ``export KEY=``, ``KEY =``) with one line."""
    pattern = re.compile(rf"^\s*(export\s+)?{re.escape(key)}\s*=")
    return [line for line in lines if not pattern.match(line)] + [f"{key}={value}"]


def write_env_atomic(path: Path, lines: list[str]) -> None:
    """Write via a 0600 temp file in the same directory, then rename over ``path``."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", text=True)
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines) + "\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def ensure_login(
    owner_url: str,
    group: str,
    name: str,
    *,
    connection_limit: int,
    statement_timeout_ms: int = 15_000,
    lock_timeout_ms: int = 5_000,
    idle_in_transaction_timeout_ms: int = 60_000,
) -> Login:
    """Create or rotate ``name`` as a login in ``group`` only. Old sessions are terminated."""
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
        for other in GROUP_LOGINS:
            if other != group:
                conn.execute(sql.SQL("REVOKE {} FROM {}").format(sql.Identifier(other), ident))
        # Explicit per-grant options: re-granting updates an existing membership's options.
        conn.execute(
            sql.SQL("GRANT {} TO {} WITH INHERIT FALSE, SET TRUE").format(
                sql.Identifier(group), ident
            )
        )
        for setting, value in (
            ("statement_timeout", f"{statement_timeout_ms}ms"),
            ("lock_timeout", f"{lock_timeout_ms}ms"),
            ("idle_in_transaction_session_timeout", f"{idle_in_transaction_timeout_ms}ms"),
        ):
            conn.execute(
                sql.SQL("ALTER ROLE {} SET {} = {}").format(
                    ident, sql.Identifier(setting), sql.Literal(value)
                )
            )
        if exists:  # rotation: sessions that logged in with the old password are cut off
            try:
                conn.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = %s",
                    (name,),
                )
            except psycopg.errors.InsufficientPrivilege:
                pass  # needs pg_signal_backend; the new password still applies to new sessions
    return Login(group, name, password)


def drop_login(owner_url: str, name: str) -> None:
    with psycopg.connect(owner_url, autocommit=True) as conn:
        conn.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(name)))
