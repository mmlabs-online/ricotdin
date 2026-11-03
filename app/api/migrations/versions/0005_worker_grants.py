"""Explicit table allow-list for ricotdin_worker + one active job per meeting (ARC-08).

Revision ID: 0005_worker_grants
Revises: 0004_meetings_gdrive
Create Date: 2026-11-02

Hand-written SQL in migrations/sql/0005_worker_grants{,_down}.sql (not generated: it is v2-only).
"""

from pathlib import Path

from alembic import op

revision = "0005_worker_grants"
down_revision = "0004_meetings_gdrive"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0005_worker_grants.sql")


def downgrade() -> None:
    _run("0005_worker_grants_down.sql")
