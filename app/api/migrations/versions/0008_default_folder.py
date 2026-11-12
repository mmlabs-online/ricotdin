"""Default folder for new meetings (PRF-07).

Revision ID: 0008_default_folder
Revises: 0007_note_versions
Create Date: 2026-11-12

Hand-written SQL in migrations/sql/0008_default_folder{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0008_default_folder"
down_revision = "0007_note_versions"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0008_default_folder.sql")


def downgrade() -> None:
    _run("0008_default_folder_down.sql")
