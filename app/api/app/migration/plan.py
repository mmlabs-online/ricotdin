"""Load order and SQL for the migration (ARC-03). Pure.

Identifiers and type names come from the target catalog; they are still validated, because
they are spliced into SQL text (values always travel as parameters).
"""

import re
from collections.abc import Iterable, Sequence

from app.migration.transform import MigrationBlocked

_IDENT = re.compile(r"[a-z_][a-z0-9_]*")
_TYPE = re.compile(r"[a-z][a-z0-9_ ]*(?:\(\d+(?:,\d+)?\))?(?:\[\])*")


def _q(name: str) -> str:
    if not _IDENT.fullmatch(name):
        raise MigrationBlocked(f"unexpected identifier {name!r}")
    return f'"{name}"'


def _type(name: str) -> str:
    if not _TYPE.fullmatch(name):
        raise MigrationBlocked(f"unexpected column type {name!r}")
    return name


def load_order(tables: set[str], fks: Iterable[tuple[str, str]]) -> list[str]:
    """Tables with every referenced (parent) table first; ties alphabetical."""
    parents: dict[str, set[str]] = {t: set() for t in tables}
    for child, parent in fks:
        if child in tables and parent in tables and child != parent:
            parents[child].add(parent)
    order: list[str] = []
    done: set[str] = set()
    while len(order) < len(tables):
        ready = sorted(t for t in tables if t not in done and parents[t] <= done)
        if not ready:
            raise MigrationBlocked(f"foreign-key cycle among {sorted(set(tables) - done)}")
        order.extend(ready)
        done.update(ready)
    return order


def select_sql(table: str, columns: Sequence[str]) -> str:
    cols = ", ".join(f"{_q(c)}::text" for c in columns)
    return f"SELECT {cols} FROM public.{_q(table)}"  # noqa: S608 - identifiers validated


def upsert_sql(table: str, columns: Sequence[str], types: Sequence[str], pk: Sequence[str]) -> str:
    """INSERT … ON CONFLICT (pk) DO UPDATE every other column (idempotent re-runs).

    ``meetings.storage_provider``: a row whose audio was already copied to R2 (same
    ``audio_path``) stays ``r2`` when v1 still says ``supabase``.
    """
    if len(columns) != len(types):
        raise ValueError("columns and types differ in length")
    cols = ", ".join(_q(c) for c in columns)
    values = ", ".join(f"%s::text::{_type(t)}" for t in types)
    sets = []
    for c in columns:
        if c in pk:
            continue
        if table == "meetings" and c == "storage_provider":
            sets.append(
                f"{_q(c)} = CASE WHEN t.{_q(c)} = 'r2' AND "
                f't."audio_path" IS NOT DISTINCT FROM EXCLUDED."audio_path" THEN \'r2\' '
                f"ELSE EXCLUDED.{_q(c)} END"
            )
        else:
            sets.append(f"{_q(c)} = EXCLUDED.{_q(c)}")
    conflict = ", ".join(_q(c) for c in pk)
    action = f"DO UPDATE SET {', '.join(sets)}" if sets else "DO NOTHING"
    return (
        f"INSERT INTO public.{_q(table)} AS t ({cols}) VALUES ({values}) "  # noqa: S608
        f"ON CONFLICT ({conflict}) {action}"
    )


def normalize_type(name: str) -> str:
    """``extensions.vector(768)`` (Supabase keeps pgvector in ``extensions``) == ``vector(768)``."""
    return re.sub(r"^[a-z_][a-z0-9_]*\.", "", name.strip())


def column_drift(table: str, source: dict[str, str], target: dict[str, str]) -> list[str]:
    """Differences between the column → type maps of one table on both sides."""
    out = [f"{table}.{c}: missing in source" for c in sorted(set(target) - set(source))]
    out += [f"{table}.{c}: missing in target" for c in sorted(set(source) - set(target))]
    out += [
        f"{table}.{c}: {source[c]} in source, {target[c]} in target"
        for c in sorted(set(source) & set(target))
        if normalize_type(source[c]) != normalize_type(target[c])
    ]
    return out
