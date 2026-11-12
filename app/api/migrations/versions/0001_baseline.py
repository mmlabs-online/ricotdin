"""v2 baseline: v1 schema ported from Supabase + own auth tables (ARC-02).

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-25

The SQL is generated (scripts/gen_baseline.py) and committed as migrations/sql/0001_baseline.sql.
It is executed on the raw psycopg connection so it runs as a script (no bind-parameter parsing).
"""

import os
from pathlib import Path

from alembic import op

from app.db.safety import check_destructive_allowed

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None

SQL = Path(__file__).resolve().parents[1] / "sql" / "0001_baseline.sql"


def _run(script: str) -> None:
    dbapi = op.get_bind().connection.dbapi_connection
    if dbapi is None:
        raise RuntimeError("no DBAPI connection")
    dbapi.execute(script)


def upgrade() -> None:
    _run(SQL.read_text(encoding="utf-8"))


def downgrade() -> None:
    # Drops every v2 object (and the extensions installed in public). Roles are cluster-wide
    # and shared with other databases, so they are kept. Refused outside scratch databases
    # unless RICOTDIN_ALLOW_DESTRUCTIVE_DOWNGRADE=1 (app/db/safety.py).
    dbname = op.get_bind().exec_driver_sql("SELECT current_database()").scalar_one()
    check_destructive_allowed(str(dbname), os.environ)
    _run(
        "DROP SCHEMA public CASCADE;\n"
        "CREATE SCHEMA public AUTHORIZATION pg_database_owner;\n"
        "GRANT USAGE ON SCHEMA public TO PUBLIC;\n"
    )
