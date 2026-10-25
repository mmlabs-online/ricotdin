"""Read the `public` schema of a live database into plain rows (ARC-02).

Shared by the baseline generator (rows → DDL via ``ddl``) and the parity test (rows →
``catalog.Catalog``). Extension-owned objects (pgvector, pgcrypto) are excluded.
"""

import json
from dataclasses import dataclass, field
from typing import Any, LiteralString

import psycopg
from psycopg import sql

from app.db.ddl import Column, Policy


@dataclass
class Function:
    name: str
    identity_args: str
    definition: str
    grantees: list[str] | None  # None = default ACL
    security_definer: bool
    volatility: str

    @property
    def signature(self) -> str:
        return f"public.{self.name}({self.identity_args})"


# (table, name, contype, definition) / (table, name, definition) / (table, column, text)
ConstraintRow = tuple[str, str, str, str]
NamedDefRow = tuple[str, str, str]
CommentRow = tuple[str, str | None, str]
GrantRow = tuple[str, str, str | None]  # (grantee, privilege, column or None)


@dataclass
class Schema:
    extensions: list[str] = field(default_factory=list)
    enums: dict[str, list[str]] = field(default_factory=dict)
    tables: dict[str, list[Column]] = field(default_factory=dict)
    constraints: list[ConstraintRow] = field(default_factory=list)
    indexes: list[NamedDefRow] = field(default_factory=list)
    functions: list[Function] = field(default_factory=list)
    triggers: list[NamedDefRow] = field(default_factory=list)
    rls: dict[str, tuple[bool, bool]] = field(default_factory=dict)  # table -> (enabled, forced)
    policies: list[Policy] = field(default_factory=list)
    table_grants: dict[str, list[GrantRow]] = field(default_factory=dict)
    comments: list[CommentRow] = field(default_factory=list)
    seeds: dict[str, str] = field(default_factory=dict)  # table -> JSON array of rows


_EXTENSIONS: LiteralString = (
    "SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1"
)

_ENUMS: LiteralString = """
SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
GROUP BY t.typname ORDER BY t.typname"""

_COLUMNS: LiteralString = """
SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
       pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum"""

_CONSTRAINTS: LiteralString = """
SELECT c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid)
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'c', 'x', 'f')
ORDER BY c.relname, con.conname"""

_INDEXES: LiteralString = """
SELECT ct.relname, ci.relname, pg_get_indexdef(i.indexrelid)
FROM pg_index i
JOIN pg_class ci ON ci.oid = i.indexrelid
JOIN pg_class ct ON ct.oid = i.indrelid
JOIN pg_namespace n ON n.oid = ct.relnamespace
WHERE n.nspname = 'public'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                  WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x'))
ORDER BY ct.relname, ci.relname"""

_FUNCTION_ACL: LiteralString = """
SELECT p.oid,
       CASE WHEN p.proacl IS NULL THEN NULL ELSE ARRAY(
         SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END
         FROM aclexplode(p.proacl) x
         LEFT JOIN pg_roles r ON r.oid = x.grantee
         WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner
         ORDER BY 1) END
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'"""

_FUNCTIONS: LiteralString = """
SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid),
       pg_get_functiondef(p.oid), p.prosecdef, p.provolatile::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
ORDER BY p.proname, 3"""

_TRIGGERS: LiteralString = """
SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname"""

_RLS: LiteralString = """
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 1"""

_POLICIES: LiteralString = """
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname"""

_GRANTS: LiteralString = """
SELECT c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END,
       x.privilege_type, NULL::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace,
     aclexplode(c.relacl) x
LEFT JOIN pg_roles r ON r.oid = x.grantee
WHERE n.nspname = 'public' AND c.relkind = 'r' AND x.grantee <> c.relowner
UNION ALL
SELECT c.relname, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END,
       x.privilege_type, a.attname
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace,
     aclexplode(a.attacl) x
LEFT JOIN pg_roles r ON r.oid = x.grantee
WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attacl IS NOT NULL
  AND x.grantee <> c.relowner
ORDER BY 1, 2, 3, 4"""

_COMMENTS: LiteralString = """
SELECT c.relname, a.attname, d.description
FROM pg_description d
JOIN pg_class c ON c.oid = d.objoid AND d.classoid = 'pg_class'::regclass
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 1, d.objsubid"""

_SEED: LiteralString = (
    "SELECT coalesce(jsonb_agg(jsonb_build_object({}) ORDER BY t::text), '[]'::jsonb)::text"
    " FROM {} t"
)


def canonical_order(s: Schema) -> None:
    """Sort every section by codepoint, in place.

    SQL ``ORDER BY`` follows the database collation, which differs between Neon and the CI
    container (e.g. ``meeting_id uuid`` vs ``meeting_ids uuid[]``), so the generated baseline
    would not be reproducible. Order is decided here instead.
    """
    s.extensions.sort()
    s.enums = dict(sorted(s.enums.items()))
    s.tables = dict(sorted(s.tables.items()))
    s.constraints.sort(key=lambda c: (c[0], c[1]))
    s.indexes.sort(key=lambda i: (i[0], i[1]))
    s.functions.sort(key=lambda f: (f.name, f.identity_args))
    for f in s.functions:
        if f.grantees is not None:
            f.grantees.sort()
    for p in s.policies:
        p.roles.sort()  # pg_policies lists roles in OID order, which differs per database
    s.triggers.sort(key=lambda t: (t[0], t[1]))
    s.rls = dict(sorted(s.rls.items()))
    s.policies.sort(key=lambda p: (p.table, p.name))
    s.table_grants = {
        t: sorted(g, key=lambda x: (x[0], x[1], x[2] or ""))
        for t, g in sorted(s.table_grants.items())
    }
    s.comments.sort(key=lambda c: (c[0], c[1] is not None, c[1] or ""))
    s.seeds = {
        t: json.dumps(sorted(json.loads(rows), key=lambda r: json.dumps(r, sort_keys=True)))
        for t, rows in sorted(s.seeds.items())
    }


def _rows(conn: psycopg.Connection[Any], query: LiteralString) -> list[tuple[Any, ...]]:
    return list(conn.execute(query))


def read_schema(url: str) -> Schema:
    s = Schema()
    with psycopg.connect(url) as conn:
        s.extensions = [r[0] for r in _rows(conn, _EXTENSIONS)]
        s.enums = {name: list(labels) for name, labels in _rows(conn, _ENUMS)}

        for table, col, typ, not_null, default, identity, generated in _rows(conn, _COLUMNS):
            if generated not in ("", "s"):
                # PG18 virtual generated columns: v1 has none; refuse instead of mis-rendering.
                raise ValueError(f"unsupported generated column kind {generated!r}: {table}.{col}")
            is_generated = generated == "s"
            s.tables.setdefault(table, []).append(
                Column(
                    name=col,
                    type=typ,
                    not_null=not_null,
                    default=None if is_generated else default,
                    identity=identity or "",
                    generated=default if is_generated else None,
                )
            )

        s.constraints = [(r[0], r[1], r[2], r[3]) for r in _rows(conn, _CONSTRAINTS)]
        s.indexes = [(r[0], r[1], r[2]) for r in _rows(conn, _INDEXES)]

        acl = {oid: grantees for oid, grantees in _rows(conn, _FUNCTION_ACL)}
        for oid, name, args, definition, secdef, vol in _rows(conn, _FUNCTIONS):
            s.functions.append(Function(name, args, definition, acl.get(oid), secdef, vol))

        s.triggers = [(r[0], r[1], r[2]) for r in _rows(conn, _TRIGGERS)]
        s.rls = {table: (enabled, forced) for table, enabled, forced in _rows(conn, _RLS)}
        s.policies = [
            Policy(table, name, permissive == "PERMISSIVE", cmd, list(roles), qual, check)
            for table, name, permissive, roles, cmd, qual, check in _rows(conn, _POLICIES)
        ]
        for table, grantee, privilege, column in _rows(conn, _GRANTS):
            s.table_grants.setdefault(table, []).append((grantee, privilege, column))
        s.comments = [(r[0], r[1], r[2]) for r in _rows(conn, _COMMENTS)]

        for table, cols in s.tables.items():
            # Every value as text (JSON null = SQL NULL); emit_seed casts back to the column type.
            pairs = sql.SQL(", ").join(
                sql.SQL("{}, {}::text").format(sql.Literal(c.name), sql.Identifier("t", c.name))
                for c in cols
            )
            query = sql.SQL(_SEED).format(pairs, sql.Identifier("public", table))
            row = conn.execute(query).fetchone()
            rows_json = row[0] if row else "[]"
            if rows_json != "[]":
                s.seeds[table] = rows_json
    canonical_order(s)
    return s
