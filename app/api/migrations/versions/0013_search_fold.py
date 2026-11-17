"""Accent-insensitive fold function for the library search (PRO-05).

Revision ID: 0013_search_fold
Revises: 0012_activity_target_index
Create Date: 2026-11-17

Hand-written SQL in migrations/sql/0013_search_fold{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0013_search_fold"
down_revision = "0012_activity_target_index"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0013_search_fold.sql")


def downgrade() -> None:
    _run("0013_search_fold_down.sql")
