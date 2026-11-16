"""Index activity_log by target user for the own activity feed (PRF-09).

Revision ID: 0012_activity_target_index
Revises: 0011_wipe_legacy_auth
Create Date: 2026-11-16

Hand-written SQL in migrations/sql/0012_activity_target_index{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0012_activity_target_index"
down_revision = "0011_wipe_legacy_auth"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0012_activity_target_index.sql")


def downgrade() -> None:
    _run("0012_activity_target_index_down.sql")
