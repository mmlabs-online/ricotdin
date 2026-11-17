"""Speaker names per meeting (PRO-04).

Revision ID: 0014_speaker_names
Revises: 0013_search_fold
Create Date: 2026-11-17

Hand-written SQL in migrations/sql/0014_speaker_names{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0014_speaker_names"
down_revision = "0013_search_fold"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0014_speaker_names.sql")


def downgrade() -> None:
    _run("0014_speaker_names_down.sql")
