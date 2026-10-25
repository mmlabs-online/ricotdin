"""ARC-02: the Alembic baseline upgrades, downgrades and re-upgrades cleanly."""

import psycopg

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
