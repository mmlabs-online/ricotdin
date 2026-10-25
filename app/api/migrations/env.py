"""Alembic environment (ARC-02). Online mode only; the URL comes from DATABASE_URL.

The version table lives in its own `alembic` schema so the baseline downgrade can drop and
recreate `public` without losing Alembic's bookkeeping.
"""

import os

from alembic import context
from sqlalchemy import create_engine, pool, text

VERSION_SCHEMA = "alembic"


def _url() -> str:
    url = context.config.get_main_option("sqlalchemy.url") or os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    # psycopg 3 driver for SQLAlchemy.
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url


def run_migrations_online() -> None:
    engine = create_engine(_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {VERSION_SCHEMA}"))
        connection.commit()
        context.configure(
            connection=connection,
            version_table_schema=VERSION_SCHEMA,
            transaction_per_migration=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    raise RuntimeError("offline mode is not supported; run against a database")
run_migrations_online()
