"""Database URL helpers for the runtime engines (ARC-04). Pure."""

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_LIBPQ_ONLY = {"sslmode", "channel_binding", "sslrootcert", "options"}


def asyncpg_engine_args(
    url: str, *, statement_timeout_ms: int, lock_timeout_ms: int, application_name: str
) -> tuple[str, dict[str, Any]]:
    """SQLAlchemy asyncpg URL and ``connect_args`` for a libpq-style URL (as Neon prints it).

    asyncpg does not understand ``sslmode``/``channel_binding``: SSL moves to ``connect_args``.
    Timeouts are set per connection (CLAUDE.md §0.1 R7); the prepared-statement cache is off so
    the same settings work behind a transaction-mode pooler.
    """
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    sslmode = dict(query).get("sslmode")
    kept = [(k, v) for k, v in query if k not in _LIBPQ_ONLY]
    scheme = "postgresql+asyncpg"
    out = urlunsplit((scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))
    args: dict[str, Any] = {
        "statement_cache_size": 0,
        "server_settings": {
            "statement_timeout": str(statement_timeout_ms),
            "lock_timeout": str(lock_timeout_ms),
            "application_name": application_name,
        },
    }
    if sslmode and sslmode != "disable":
        args = {"ssl": "require", **args}
    return out, args
