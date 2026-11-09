"""Version history of meeting summary + notes (PRO-06).

Revision ID: 0007_note_versions
Revises: 0006_worker_schedulers
Create Date: 2026-11-09

Hand-written SQL in migrations/sql/0007_note_versions{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0007_note_versions"
down_revision = "0006_worker_schedulers"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0007_note_versions.sql")


def downgrade() -> None:
    _run("0007_note_versions_down.sql")
