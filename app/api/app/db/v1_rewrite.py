"""Rewrite SQL from the replayed v1 (Supabase) catalog into v2 SQL (ARC-02). Pure, no I/O.

v1 depends on Supabase in exactly three ways (checked against legacy/schema.sql + migrations):
``auth.users`` (foreign keys), ``auth.uid()`` and ``auth.jwt()->>'user_role'``. Anything else
that references the ``auth`` schema is unexpected and must fail loudly instead of slipping into
the v2 baseline.
"""

import re


class UnsupportedV1Reference(ValueError):
    """v1 SQL references a Supabase object that has no v2 mapping."""


_REWRITES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bauth\.users\b"), "public.users"),
    # pg_policies prints the claim lookup parenthesised and cast; function bodies keep source text.
    (re.compile(r"\(auth\.jwt\(\)\s*->>\s*'user_role'::text\)"), "public.app_user_role()"),
    (re.compile(r"auth\.jwt\(\)\s*->>\s*'user_role'(?:::text)?"), "public.app_user_role()"),
    (re.compile(r"\bauth\.uid\(\)"), "public.app_user_id()"),
    # SECURITY DEFINER functions: search pg_temp last so temp tables cannot shadow public ones.
    (re.compile(r"SET search_path TO 'public'(?!,)"), "SET search_path TO 'public', 'pg_temp'"),
]
_STRING_LITERAL = re.compile(r"'(?:[^']|'')*'")
_AUTH_REF = re.compile(r"\bauth\.[a-z_]+(?:\(\))?")
_REQUEST_SETTING = re.compile(r"\brequest\.(?:jwt|headers|method|path)[a-z_.]*")


def rewrite_v1_sql(sql: str) -> str:
    """Map v1 Supabase auth references to their v2 equivalents; raise on anything unmapped."""
    out = sql
    for pattern, repl in _REWRITES:
        out = pattern.sub(repl, out)
    # PostgREST request settings (e.g. current_setting('request.jwt.claims')) live inside a
    # string literal, so check them before literals are blanked out.
    request_setting = _REQUEST_SETTING.search(out)
    if request_setting:
        raise UnsupportedV1Reference(
            f"no v2 mapping for {request_setting.group(0)!r} in: {sql[:200]}"
        )
    leftover = _AUTH_REF.search(_STRING_LITERAL.sub("''", out))
    if leftover:
        raise UnsupportedV1Reference(f"no v2 mapping for {leftover.group(0)!r} in: {sql[:200]}")
    return out


# v1 grantee → v2 role. None = the grant is dropped (role does not exist in v2, or it is the
# owner/superuser whose privileges are implicit).
_ROLE_MAP: dict[str, str | None] = {
    "authenticated": "ricotdin_app",
    "service_role": "ricotdin_service",
    "PUBLIC": "PUBLIC",
    "anon": None,
    "supabase_auth_admin": None,
    "postgres": None,
    "supabase_admin": None,
    "authenticator": None,
    "dashboard_user": None,
}


def map_role(v1_role: str) -> str | None:
    """v2 grantee for a v1 grantee. Unknown roles raise so no grant is silently lost."""
    if v1_role not in _ROLE_MAP:
        raise UnsupportedV1Reference(f"no v2 mapping for role {v1_role!r}")
    return _ROLE_MAP[v1_role]
