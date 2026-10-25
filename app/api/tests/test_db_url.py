"""ARC-04: libpq-style URLs (Neon) → SQLAlchemy asyncpg URL + connect args. Pure."""

from app.db.urls import asyncpg_engine_args


def test_neon_url_moves_ssl_to_connect_args_and_drops_libpq_only_params() -> None:
    url, args = asyncpg_engine_args(
        "postgresql://ricotdin_api_login:p%40ss@ep-x.ap-southeast-1.aws.neon.tech/neondb"
        "?sslmode=require&channel_binding=require",
        statement_timeout_ms=15000,
        lock_timeout_ms=5000,
        application_name="ricotdin-api",
    )
    assert url == (
        "postgresql+asyncpg://ricotdin_api_login:p%40ss@ep-x.ap-southeast-1.aws.neon.tech/neondb"
    )
    assert args == {
        "ssl": "require",
        "statement_cache_size": 0,  # safe behind PgBouncer transaction pooling
        "server_settings": {
            "statement_timeout": "15000",
            "lock_timeout": "5000",
            "application_name": "ricotdin-api",
        },
    }


def test_local_url_without_ssl_keeps_other_query_params() -> None:
    url, args = asyncpg_engine_args(
        "postgres://u@localhost:5432/db?foo=bar",
        statement_timeout_ms=1,
        lock_timeout_ms=2,
        application_name="x",
    )
    assert url == "postgresql+asyncpg://u@localhost:5432/db?foo=bar"
    assert "ssl" not in args


def test_disable_sslmode_means_no_ssl() -> None:
    _, args = asyncpg_engine_args(
        "postgresql://u@h/db?sslmode=disable",
        statement_timeout_ms=1,
        lock_timeout_ms=1,
        application_name="x",
    )
    assert "ssl" not in args
