"""meetings.storage_provider accepts and defaults to gdrive (ARC-07 part 2).

Revision ID: 0004_meetings_gdrive
Revises: 0003_drive_storage
Create Date: 2026-11-02

Hand-written SQL in migrations/sql/0004_meetings_gdrive{,_down}.sql (not generated: it is v2-only).
"""

from pathlib import Path

from alembic import op

revision = "0004_meetings_gdrive"
down_revision = "0003_drive_storage"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0004_meetings_gdrive.sql")


def downgrade() -> None:
    _run("0004_meetings_gdrive_down.sql")
