"""UI language saved on the account (PRF-06).

Revision ID: 0009_profile_locale
Revises: 0008_default_folder
Create Date: 2026-11-12

Hand-written SQL in migrations/sql/0009_profile_locale{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0009_profile_locale"
down_revision = "0008_default_folder"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0009_profile_locale.sql")


def downgrade() -> None:
    _run("0009_profile_locale_down.sql")
