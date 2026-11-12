"""Database URL helpers for the runtime engines (ARC-04). Pure."""

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_LIBPQ_ONLY = {"sslmode", "channel_binding", "options"}
_SSL_MODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}


def asyncpg_engine_args(
    url: str, *, statement_timeout_ms: int, lock_timeout_ms: int, application_name: str
) -> tuple[str, dict[str, Any]]:
    """SQLAlchemy asyncpg URL and ``connect_args`` for a libpq-style URL (``postgresql://…?sslmode=…``).

    asyncpg does not take ``sslmode``/``channel_binding`` in the URL: the SSL mode moves to
    ``connect_args`` unchanged (``verify-full`` stays ``verify-full``). ``sslrootcert`` is refused
    rather than silently dropped. Both prepared-statement caches (asyncpg's and SQLAlchemy's) are
    off so the URL also works behind a transaction-mode pooler. Timeouts are set per connection
    as well as per login role (CLAUDE.md §0.1 R7), in case a pooler drops startup parameters.
    """
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    params = dict(query)
    if "sslrootcert" in params:
        raise ValueError("sslrootcert is not supported in DATABASE_URL_* (use the system CA store)")
    sslmode = params.get("sslmode")
    if sslmode is not None and sslmode not in _SSL_MODES:
        raise ValueError(f"unknown sslmode {sslmode!r}")
    kept = [
        (k, v) for k, v in query if k not in _LIBPQ_ONLY and k != "prepared_statement_cache_size"
    ]
    kept.append(("prepared_statement_cache_size", "0"))
    out = urlunsplit(
        ("postgresql+asyncpg", parts.netloc, parts.path, urlencode(kept), parts.fragment)
    )
    args: dict[str, Any] = {
        "statement_cache_size": 0,
        "server_settings": {
            "statement_timeout": str(statement_timeout_ms),
            "lock_timeout": str(lock_timeout_ms),
            "application_name": application_name,
        },
    }
    if sslmode and sslmode != "disable":
        args = {"ssl": sslmode, **args}
    return out, args
