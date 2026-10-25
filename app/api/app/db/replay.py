"""Replay the v1 (Supabase) schema on plain Postgres (ARC-02).

Applies ``tests/fixtures/supabase_shim.sql``, then ``legacy/schema.sql`` and every
``legacy/migrations/NNN_*.sql`` in numeric order — the same order the owner applied them in the
Supabase SQL editor (CLAUDE.md §9a).
"""

import re
from pathlib import Path

import psycopg

API_ROOT = Path(__file__).resolve().parents[2]  # app/api
REPO_ROOT = API_ROOT.parents[1]
LEGACY = REPO_ROOT / "legacy"
SHIM = API_ROOT / "tests" / "fixtures" / "supabase_shim.sql"
_MIGRATION = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")


def v1_sql_files() -> list[Path]:
    migrations = sorted(
        (p for p in (LEGACY / "migrations").iterdir() if _MIGRATION.match(p.name)),
        key=lambda p: int(p.name[:3]),
    )
    return [LEGACY / "schema.sql", *migrations]


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
