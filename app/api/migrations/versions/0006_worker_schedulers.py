"""Worker schedulers: scheduler_runs leases, wallet reconcile, retention purge audit (ARC-08e).

Revision ID: 0006_worker_schedulers
Revises: 0005_worker_grants
Create Date: 2026-11-03

Hand-written SQL in migrations/sql/0006_worker_schedulers{,_down}.sql (v2-only, not generated).
"""

from pathlib import Path

from alembic import op

revision = "0006_worker_schedulers"
down_revision = "0005_worker_grants"
branch_labels = None
depends_on = None

SQL_DIR = Path(__file__).resolve().parents[1] / "sql"


def _run(name: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def upgrade() -> None:
    _run("0006_worker_schedulers.sql")


def downgrade() -> None:
    _run("0006_worker_schedulers_down.sql")
