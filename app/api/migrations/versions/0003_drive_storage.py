"""Google Drive storage: drive_config + storage_objects (ARC-17).

Revision ID: 0003_drive_storage
Revises: 0002_runtime_roles
Create Date: 2026-10-30

Hand-written SQL in migrations/sql/0003_drive_storage{,_down}.sql (not generated: it is v2-only).
"""

from pathlib import Path

from alembic import op

revision = "0003_drive_storage"
down_revision = "0002_runtime_roles"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0003_drive_storage.sql")


def downgrade() -> None:
    _run("0003_drive_storage_down.sql")
