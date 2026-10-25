"""ARC-02: the Alembic baseline upgrades, downgrades and re-upgrades cleanly."""

import psycopg
import pytest

from app.db.scratch import scratch_database
from tests.conftest import alembic_downgrade, alembic_upgrade, requires_db


def _public_tables(url: str) -> set[str]:
    with psycopg.connect(url) as conn:
        return {
            r[0]
            for r in conn.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        }


@requires_db
def test_upgrade_downgrade_upgrade() -> None:
    with scratch_database("mig") as url:
        alembic_upgrade(url)
        tables = _public_tables(url)
        assert {"users", "refresh_tokens", "email_tokens", "profiles", "meetings"} <= tables
        assert "provider_keys" not in tables  # dropped by v1 migration 015

        alembic_downgrade(url)
        assert _public_tables(url) == set()

        alembic_upgrade(url)
        assert _public_tables(url) == tables


@requires_db
def test_no_object_references_supabase(v2_db: str) -> None:
    with psycopg.connect(v2_db) as conn:
        schemas = {r[0] for r in conn.execute("SELECT nspname FROM pg_namespace")}
        assert "auth" not in schemas
        defs = " ".join(
            r[0] or ""
            for r in conn.execute(
                """SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.prokind = 'f'
                     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                     WHERE d.objid = p.oid AND d.deptype = 'e')
                   UNION ALL SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '')
                   FROM pg_policies WHERE schemaname = 'public'"""
            )
        )
        for needle in ("auth.uid", "auth.jwt", "auth.users", "request.jwt"):
            assert needle not in defs
        grantees = {
            r[0]
            for r in conn.execute(
                "SELECT DISTINCT grantee FROM information_schema.role_table_grants "
                "WHERE table_schema = 'public'"
            )
        }
        assert not grantees & {"anon", "authenticated", "service_role"}


@requires_db
def test_definer_functions_are_not_executable_by_public(v2_db: str) -> None:
    # CLAUDE.md §6: every SECURITY DEFINER function revokes EXECUTE from PUBLIC, except trigger
    # functions and can_access_meeting (called by RLS policies).
    with psycopg.connect(v2_db) as conn:
        offenders = [
            r[0]
            for r in conn.execute(
                """SELECT p.proname FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.prosecdef
                     AND p.prorettype <> 'trigger'::regtype
                     AND p.proname <> 'can_access_meeting'
                     AND has_function_privilege('public', p.oid, 'EXECUTE')"""
            )
        ]
    assert offenders == []


SUPABASE_ROLES = ("anon", "authenticated", "service_role", "supabase_auth_admin")


@requires_db
def test_no_supabase_role_holds_any_privilege_or_policy(v2_db: str) -> None:
    # Roles are cluster-wide (the v1 replay creates them on the same cluster), so a `TO anon`
    # regression would not even fail at CREATE time; check every privilege source directly.
    with psycopg.connect(v2_db) as conn:
        rows = list(
            conn.execute(
                """
                SELECT 'policy ' || tablename || '.' || policyname FROM pg_policies
                WHERE schemaname = 'public' AND roles && %(roles)s::name[]
                UNION ALL
                SELECT 'table ' || c.relname FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) x
                JOIN pg_roles r ON r.oid = x.grantee
                WHERE n.nspname = 'public' AND r.rolname = ANY(%(roles)s)
                UNION ALL
                SELECT 'column ' || c.relname || '.' || a.attname FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(a.attacl) x
                JOIN pg_roles r ON r.oid = x.grantee
                WHERE n.nspname = 'public' AND r.rolname = ANY(%(roles)s)
                UNION ALL
                SELECT 'function ' || p.proname FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) x
                JOIN pg_roles r ON r.oid = x.grantee
                WHERE n.nspname = 'public' AND r.rolname = ANY(%(roles)s)
                """,
                {"roles": list(SUPABASE_ROLES)},
            )
        )
    assert rows == []


@requires_db
def test_definer_functions_are_not_executable_by_the_app_role(v2_db: str) -> None:
    # CLAUDE.md §6 in v2 terms: PUBLIC is covered above; ricotdin_app is the v2 `authenticated`.
    with psycopg.connect(v2_db) as conn:
        offenders = [
            r[0]
            for r in conn.execute(
                """SELECT p.proname FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public' AND p.prosecdef
                     AND p.prorettype <> 'trigger'::regtype
                     AND p.proname <> 'can_access_meeting'
                     AND has_function_privilege('ricotdin_app', p.oid, 'EXECUTE')"""
            )
        ]
    assert offenders == []


@requires_db
def test_public_schema_contains_only_tables_and_indexes(v2_db: str) -> None:
    # The generator and the parity test only understand tables and indexes; any other kind
    # (view, sequence, partitioned table, ...) must be added to them first.
    with psycopg.connect(v2_db) as conn:
        kinds = {
            r[0]
            for r in conn.execute(
                """SELECT c.relkind::text FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public'
                     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                     WHERE d.objid = c.oid AND d.deptype = 'e')"""
            )
        }
    assert kinds <= {"r", "i"}


@requires_db
def test_v2_roles_cannot_log_in_or_bypass_rls(v2_db: str) -> None:
    with psycopg.connect(v2_db) as conn:
        rows = list(
            conn.execute(
                "SELECT rolname, rolcanlogin, rolbypassrls, rolsuper FROM pg_roles "
                "WHERE rolname IN ('ricotdin_app', 'ricotdin_service') ORDER BY 1"
            )
        )
    assert rows == [
        ("ricotdin_app", False, False, False),
        ("ricotdin_service", False, False, False),
    ]


@requires_db
def test_downgrade_is_refused_outside_scratch_databases() -> None:
    from app.db.safety import DestructiveOperationRefused, check_destructive_allowed

    with pytest.raises(DestructiveOperationRefused):
        check_destructive_allowed("neondb", {})


@requires_db
def test_functions_created_by_later_migrations_are_not_public_executable() -> None:
    # Guards the BUG-005 class: a future SECURITY DEFINER migration that forgets its REVOKE.
    with scratch_database("defacl") as url:
        alembic_upgrade(url)
        with psycopg.connect(url) as conn:
            conn.execute("CREATE FUNCTION public.later_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'")
            row = conn.execute(
                "SELECT has_function_privilege('public', 'public.later_fn()', 'EXECUTE')"
            ).fetchone()
            conn.rollback()
    assert row == (False,)
