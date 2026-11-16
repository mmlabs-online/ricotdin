"""Wipe ricotdin's own credentials: password hashes, refresh and email tokens (AUT-06).

Revision ID: 0011_wipe_legacy_auth
Revises: 0010_mmlabs_identity
Create Date: 2026-11-16

Hand-written SQL in migrations/sql/0011_wipe_legacy_auth{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0011_wipe_legacy_auth"
down_revision = "0010_mmlabs_identity"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0011_wipe_legacy_auth.sql")


def downgrade() -> None:
    _run("0011_wipe_legacy_auth_down.sql")
