"""Per-model key health results (ADM-12).

Revision ID: 0016_key_health_models
Revises: 0015_deleted_accounts
Create Date: 2026-11-19

Hand-written SQL in migrations/sql/0016_key_health_models{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0016_key_health_models"
down_revision = "0015_deleted_accounts"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0016_key_health_models.sql")


def downgrade() -> None:
    _run("0016_key_health_models_down.sql")
