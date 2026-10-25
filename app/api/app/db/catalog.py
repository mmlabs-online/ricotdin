"""Pure catalog comparison for the v1 (Supabase) ↔ v2 (plain Postgres) schema parity test (ARC-02).

A catalog is ``{section: {key: canonical_value}}``, e.g.
``{"columns": {"meetings.title": "text|NO|"}}``. Collecting it from a live database is the
integration test's job; this module only compares and normalises, with no I/O.
"""

import re
from dataclasses import dataclass
from fnmatch import fnmatchcase
from typing import Literal

Kind = Literal["changed", "extra", "missing"]
Catalog = dict[str, dict[str, str]]


@dataclass(frozen=True)
class Difference:
    kind: Kind
    section: str
    key: str
    ref: str | None
    new: str | None


@dataclass(frozen=True)
class Allowed:
    """An intended v1 → v2 difference. ``key`` is an fnmatch pattern; ``reason`` documents why."""

    kind: Kind
    section: str
    key: str
    reason: str

    def matches(self, d: Difference) -> bool:
        return d.kind == self.kind and d.section == self.section and fnmatchcase(d.key, self.key)


def diff_catalogs(
    ref: Catalog, new: Catalog, allowed: list[Allowed] | None = None
) -> list[Difference]:
    """Differences between a reference (v1) and a new (v2) catalog, minus the allowed ones.

    Sorted by kind, section, key so failures read the same on every run.
    """
    rules = allowed or []
    found: list[Difference] = []
    for section in sorted(ref.keys() | new.keys()):
        a, b = ref.get(section, {}), new.get(section, {})
        for key in sorted(a.keys() | b.keys()):
            if key not in b:
                found.append(Difference("missing", section, key, a[key], None))
            elif key not in a:
                found.append(Difference("extra", section, key, None, b[key]))
            elif a[key] != b[key]:
                found.append(Difference("changed", section, key, a[key], b[key]))
    kept = [d for d in found if not any(r.matches(d) for r in rules)]
    return sorted(kept, key=lambda d: (d.kind, d.section, d.key))


# Supabase auth helpers → the v2 RLS context helpers (ARC-02). Order matters: the parenthesised
# form Postgres prints in pg_policies is rewritten before the bare form.
_REWRITES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\(auth\.jwt\(\)\s*->>\s*'user_role'(?:::text)?\)"), "app_user_role()"),
    (re.compile(r"auth\.jwt\(\)\s*->>\s*'user_role'(?:::text)?"), "app_user_role()"),
    (re.compile(r"auth\.uid\(\)"), "app_user_id()"),
    # Postgres may or may not print the schema; compare unqualified.
    (re.compile(r"\bpublic\."), ""),
]
_WS = re.compile(r"\s+")


def normalize_sql(text: str) -> str:
    """Canonical form of a SQL fragment for comparison.

    v1 Supabase auth calls are mapped to the v2 helpers and whitespace is collapsed.
    """
    out = text
    for pattern, repl in _REWRITES:
        out = pattern.sub(repl, out)
    return _WS.sub(" ", out).strip()
