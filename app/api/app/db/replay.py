"""Replay the v1 (Supabase) schema on plain Postgres (ARC-02).

Applies ``tests/fixtures/supabase_shim.sql``, then ``tests/fixtures/v1/schema/schema.sql`` and every
``tests/fixtures/v1/schema/migrations/NNN_*.sql`` in numeric order — the same order the owner
applied them in the Supabase SQL editor. That SQL is a frozen copy of v1's ``schema.sql`` and
``migrations/`` (001–038), kept when ``legacy/`` was deleted (ARC-16): the migration integration
test, the schema parity test and ``scripts.gen_baseline`` still need a v1 database.
"""

import re
from pathlib import Path

import psycopg

API_ROOT = Path(__file__).resolve().parents[2]  # app/api
V1_SCHEMA = API_ROOT / "tests" / "fixtures" / "v1" / "schema"
SHIM = API_ROOT / "tests" / "fixtures" / "supabase_shim.sql"
_MIGRATION = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")


def v1_sql_files() -> list[Path]:
    migrations = sorted(
        (p for p in (V1_SCHEMA / "migrations").iterdir() if _MIGRATION.match(p.name)),
        key=lambda p: int(p.name[:3]),
    )
    return [V1_SCHEMA / "schema.sql", *migrations]


def replay_v1(url: str) -> list[str]:
    """Apply shim + v1 schema + migrations to the (empty) database at ``url``.

    Returns the file names applied. Stops at the first failing file with its name in the error.
    """
    applied: list[str] = []
    with psycopg.connect(url, autocommit=True) as conn:
        for path in [SHIM, *v1_sql_files()]:
            try:
                conn.execute(path.read_text(encoding="utf-8"))
            except psycopg.Error as exc:
                raise RuntimeError(f"replay failed in {path.name}: {exc}") from exc
            applied.append(path.name)
    return applied
