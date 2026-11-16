"""users.mmlabs_sub + optional password_hash (AUT-05).

Revision ID: 0010_mmlabs_identity
Revises: 0009_profile_locale
Create Date: 2026-11-16

Hand-written SQL in migrations/sql/0010_mmlabs_identity{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0010_mmlabs_identity"
down_revision = "0009_profile_locale"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0010_mmlabs_identity.sql")


def downgrade() -> None:
    _run("0010_mmlabs_identity_down.sql")
