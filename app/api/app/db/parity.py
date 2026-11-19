"""A comparable snapshot of the v2 schema (``introspect.Schema`` → ``catalog.Catalog``).

The migration tests compare two snapshots (e.g. before and after a downgrade + upgrade round
trip); any difference is a bug. (The v1 ↔ v2 parity rules went with the v1 schema, ARC-16.)
"""

import json
import re

from app.db.introspect import Schema

Catalog = dict[str, dict[str, str]]  # {section: {key: canonical value}}

_PUBLIC = re.compile(r"\bpublic\.")  # Postgres may or may not print the schema
_WS = re.compile(r"\s+")


def normalize_sql(text: str) -> str:
    """Canonical form of a SQL fragment for comparison: unqualified, whitespace collapsed."""
    return _WS.sub(" ", _PUBLIC.sub("", text)).strip()


def _seed_value(rows_json: str) -> str:
    """Seed rows without timestamps (``*_at`` differ between two replays)."""
    rows = json.loads(rows_json)
    cleaned = [{k: v for k, v in r.items() if not k.endswith("_at")} for r in rows]
    return json.dumps(sorted(cleaned, key=lambda r: json.dumps(r, sort_keys=True)), sort_keys=True)


def to_catalog(schema: Schema) -> Catalog:
    def n(text: str | None) -> str:
        return "" if text is None else normalize_sql(text)

    s = schema
    cat: Catalog = {
        "extensions": {e: "" for e in s.extensions},
        "enums": {name: ",".join(labels) for name, labels in s.enums.items()},
        "tables": {t: "" for t in s.tables},
        "columns": {
            f"{t}.{c.name}": f"{c.type}|{c.not_null}|{n(c.default)}|{c.identity}|{n(c.generated)}"
            for t, cols in s.tables.items()
            for c in cols
        },
        "constraints": {f"{t}.{name}": f"{kind}|{n(d)}" for t, name, kind, d in s.constraints},
        "indexes": {f"{t}.{name}": n(d) for t, name, d in s.indexes},
        "triggers": {f"{t}.{name}": n(d) for t, name, d in s.triggers},
        "rls": {t: f"{enabled}|{forced}" for t, (enabled, forced) in s.rls.items()},
        "comments": {f"{t}{'.' + c if c else ''}": text for t, c, text in s.comments},
        "seeds": {t: _seed_value(rows) for t, rows in s.seeds.items()},
        "functions": {},
        "function_acl": {},
        "policies": {},
        "table_grants": {},
    }

    for f in s.functions:
        cat["functions"][f.signature] = f"{f.security_definer}|{f.volatility}|{n(f.definition)}"
        if f.grantees is None:
            cat["function_acl"][f.signature] = "<default>"
        else:
            cat["function_acl"][f.signature] = ",".join(sorted(set(f.grantees)))

    for p in s.policies:
        roles = sorted(set(p.roles))
        cat["policies"][f"{p.table}.{p.name}"] = (
            f"{p.permissive}|{p.cmd}|{','.join(roles)}|{n(p.qual)}|{n(p.with_check)}"
        )

    for t, grants in s.table_grants.items():
        for grantee, privilege, column in grants:
            cat["table_grants"][f"{t}|{grantee}|{privilege}|{column or ''}"] = "y"
    return cat
