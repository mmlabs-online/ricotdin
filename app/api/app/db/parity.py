"""v1 ↔ v2 schema parity (ARC-02): snapshot → comparable catalog, plus the intended differences.

The v1 side is the replayed Supabase schema; its SQL and role names are mapped to v2 first
(``v1_rewrite``), so any remaining difference is either listed in ``ALLOWED`` or a bug.
"""

import json
from collections.abc import Callable

from app.db.catalog import Allowed, Catalog, normalize_sql
from app.db.grants import restrict_app_grants
from app.db.introspect import Schema
from app.db.v1_rewrite import map_role, rewrite_v1_sql

# v1 functions with no v2 counterpart (Supabase-only).
SKIPPED_V1_FUNCTIONS = {"custom_access_token_hook"}
# v1 functions re-implemented by hand for v2 (migrations/src/overrides/<name>.sql).
OVERRIDDEN_FUNCTIONS = {"prevent_role_escalation"}

_V2_AUTH_TABLES = ("users", "refresh_tokens", "email_tokens")

ALLOWED: list[Allowed] = [
    *(
        Allowed("extra", section, pattern, "v2 own auth tables (replace Supabase auth)")
        for table in _V2_AUTH_TABLES
        for section, pattern in [
            ("tables", table),
            ("columns", f"{table}.*"),
            ("constraints", f"{table}.*"),
            ("indexes", f"{table}.*"),
            ("rls", table),
            ("policies", f"{table}.*"),
            ("table_grants", f"{table}|*"),
            ("comments", f"{table}*"),
            ("triggers", f"{table}.*"),
        ]
    ),
    Allowed("extra", "functions", "public.app_user_id()", "v2 RLS request context"),
    Allowed("extra", "functions", "public.app_user_role()", "v2 RLS request context"),
    Allowed("extra", "functions", "public.sync_profile_role()", "profiles.role mirrors users.role"),
    Allowed("extra", "function_acl", "public.app_user_id()", "v2 RLS request context"),
    Allowed("extra", "function_acl", "public.app_user_role()", "v2 RLS request context"),
    Allowed("extra", "function_acl", "public.sync_profile_role()", "trigger function, revoked"),
    Allowed(
        "changed",
        "functions",
        "public.prevent_role_escalation()",
        "reads the v2 request context instead of request.jwt.claims (override)",
    ),
    Allowed("extra", "policies", "*.service_all", "ricotdin_service access without BYPASSRLS"),
]


def _identity(x: str) -> str:
    return x


def _v2_role(role: str) -> str | None:
    return role


def _seed_value(rows_json: str) -> str:
    """Seed rows without timestamps (``*_at`` differ between two replays)."""
    rows = json.loads(rows_json)
    cleaned = [{k: v for k, v in r.items() if not k.endswith("_at")} for r in rows]
    return json.dumps(sorted(cleaned, key=lambda r: json.dumps(r, sort_keys=True)), sort_keys=True)


def to_catalog(schema: Schema, *, v1: bool) -> Catalog:
    rewrite: Callable[[str], str] = rewrite_v1_sql if v1 else _identity
    role_of: Callable[[str], str | None] = map_role if v1 else _v2_role

    def n(text: str | None) -> str:
        return "" if text is None else normalize_sql(rewrite(text))

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
        if v1 and f.name in SKIPPED_V1_FUNCTIONS:
            continue
        body = (
            "<v1, overridden in v2>" if v1 and f.name in OVERRIDDEN_FUNCTIONS else n(f.definition)
        )
        cat["functions"][f.signature] = f"{f.security_definer}|{f.volatility}|{body}"
        if f.grantees is None:
            cat["function_acl"][f.signature] = "<default>"
        else:
            mapped = {r for g in f.grantees if (r := role_of(g)) is not None}
            cat["function_acl"][f.signature] = ",".join(sorted(mapped))

    for p in s.policies:
        mapped_roles: set[str] = set()
        for r in p.roles:
            policy_role = "ricotdin_app" if v1 and r == "public" else role_of(r)
            if policy_role is not None:
                mapped_roles.add(policy_role)
        roles = sorted(mapped_roles)
        if not roles:
            continue
        cat["policies"][f"{p.table}.{p.name}"] = (
            f"{p.permissive}|{p.cmd}|{','.join(roles)}|{n(p.qual)}|{n(p.with_check)}"
        )

    for t, grants in s.table_grants.items():
        if v1:
            grants = restrict_app_grants(t, grants, s.policies)
        for grantee, privilege, column in grants:
            role = role_of(grantee)
            if role is not None:
                cat["table_grants"][f"{t}|{role}|{privilege}|{column or ''}"] = "y"
    return cat
