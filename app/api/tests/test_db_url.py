"""ARC-04: libpq-style URLs (Neon) → SQLAlchemy asyncpg URL + connect args. Pure."""

import pytest

from app.db.urls import asyncpg_engine_args

KW = {"statement_timeout_ms": 15000, "lock_timeout_ms": 5000, "application_name": "ricotdin-api"}


def test_neon_url_moves_ssl_to_connect_args_and_disables_both_statement_caches() -> None:
    url, args = asyncpg_engine_args(
        "postgresql://ricotdin_api_login:p%40ss@ep-x.ap-southeast-1.aws.neon.tech/neondb"
        "?sslmode=require&channel_binding=require",
        **KW,  # type: ignore[arg-type]
    )
    # SQLAlchemy's own asyncpg prepared-statement cache is off via the URL query.
    assert url == (
        "postgresql+asyncpg://ricotdin_api_login:p%40ss@ep-x.ap-southeast-1.aws.neon.tech/neondb"
        "?prepared_statement_cache_size=0"
    )
    assert args == {
        "ssl": "require",
        "statement_cache_size": 0,
        "server_settings": {
            "statement_timeout": "15000",
            "lock_timeout": "5000",
            "application_name": "ricotdin-api",
        },
    }


@pytest.mark.parametrize("mode", ["verify-full", "verify-ca", "require", "prefer"])
def test_ssl_mode_is_passed_through_never_downgraded(mode: str) -> None:
    _, args = asyncpg_engine_args(f"postgresql://u@h/db?sslmode={mode}", **KW)  # type: ignore[arg-type]
    assert args["ssl"] == mode


def test_sslrootcert_is_refused_instead_of_silently_dropped() -> None:
    with pytest.raises(ValueError, match="sslrootcert"):
        asyncpg_engine_args("postgresql://u@h/db?sslmode=verify-full&sslrootcert=/ca.pem", **KW)  # type: ignore[arg-type]


def test_local_url_without_ssl_keeps_other_query_params() -> None:
    url, args = asyncpg_engine_args("postgres://u@localhost:5432/db?foo=bar", **KW)  # type: ignore[arg-type]
    assert url == "postgresql+asyncpg://u@localhost:5432/db?foo=bar&prepared_statement_cache_size=0"
    assert "ssl" not in args


def test_disable_sslmode_means_no_ssl() -> None:
    _, args = asyncpg_engine_args("postgresql://u@h/db?sslmode=disable", **KW)  # type: ignore[arg-type]
    assert "ssl" not in args
