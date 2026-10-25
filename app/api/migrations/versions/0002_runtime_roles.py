"""Split ricotdin_service (adds ricotdin_worker), append-only logs (ARC-04).

Revision ID: 0002_runtime_roles
Revises: 0001_baseline
Create Date: 2026-10-25

Hand-written SQL in migrations/sql/0002_runtime_roles{,_down}.sql (not generated: it is v2-only).
"""

from pathlib import Path

from alembic import op

revision = "0002_runtime_roles"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0002_runtime_roles.sql")


def downgrade() -> None:
    _run("0002_runtime_roles_down.sql")
