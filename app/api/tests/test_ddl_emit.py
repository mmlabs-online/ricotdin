"""ARC-02: pure DDL emitters used to turn the replayed v1 catalog into the v2 baseline."""

from app.db.ddl import (
    Column,
    Policy,
    emit_enum,
    emit_function_acl,
    emit_policy,
    emit_seed,
    emit_table,
    emit_table_grants,
)


def test_emit_enum_keeps_label_order_and_quotes() -> None:
    assert emit_enum("meeting_status", ["pending", "done", "it's"]) == (
        "CREATE TYPE public.meeting_status AS ENUM ('pending', 'done', 'it''s');"
    )


def test_emit_table_columns_defaults_not_null_and_identity() -> None:
    cols = [
        Column("id", "uuid", not_null=True, default="gen_random_uuid()"),
        Column("seq", "bigint", not_null=True, identity="a"),
        Column("title", "text", not_null=False),
    ]
    assert emit_table("meetings", cols) == (
        "CREATE TABLE public.meetings (\n"
        "  id uuid NOT NULL DEFAULT gen_random_uuid(),\n"
        "  seq bigint NOT NULL GENERATED ALWAYS AS IDENTITY,\n"
        "  title text\n"
        ");"
    )


def test_emit_table_quotes_reserved_identifiers() -> None:
    sql = emit_table("todos", [Column("user", "text", not_null=False)])
    assert '  "user" text' in sql


def test_emit_policy_maps_roles_and_rewrites_auth() -> None:
    p = Policy(
        table="meetings",
        name="own meetings",
        permissive=True,
        cmd="SELECT",
        roles=["authenticated"],
        qual="(auth.uid() = user_id)",
        with_check=None,
    )
    assert emit_policy(p) == (
        'CREATE POLICY "own meetings" ON public.meetings AS PERMISSIVE FOR SELECT '
        "TO ricotdin_app USING ((public.app_user_id() = user_id));"
    )


def test_emit_policy_public_role_and_with_check() -> None:
    p = Policy("todos", "w", False, "ALL", ["public"], None, "(auth.uid() IS NOT NULL)")
    assert emit_policy(p) == (
        "CREATE POLICY w ON public.todos AS RESTRICTIVE FOR ALL TO PUBLIC "
        "WITH CHECK ((public.app_user_id() IS NOT NULL));"
    )


def test_emit_policy_only_for_dropped_roles_is_skipped() -> None:
    p = Policy("meetings", "anon read", True, "SELECT", ["anon"], "true", None)
    assert emit_policy(p) is None


def test_emit_table_grants_maps_roles_and_columns() -> None:
    grants = [
        ("authenticated", "SELECT", None),
        ("anon", "SELECT", None),
        ("service_role", "INSERT", None),
        ("service_role", "SELECT", None),
        ("authenticated", "UPDATE", "username"),
    ]
    assert emit_table_grants("profiles", grants) == [
        "GRANT SELECT ON TABLE public.profiles TO ricotdin_app;",
        "GRANT UPDATE (username) ON TABLE public.profiles TO ricotdin_app;",
        "GRANT INSERT, SELECT ON TABLE public.profiles TO ricotdin_service;",
    ]


def test_emit_function_acl_revokes_public_and_grants_mapped_roles() -> None:
    sig = "public.claim_next_job(text)"
    assert emit_function_acl(sig, ["service_role", "postgres"]) == [
        f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC;",
        f"GRANT EXECUTE ON FUNCTION {sig} TO ricotdin_service;",
    ]


def test_emit_function_acl_none_means_default_public_execute() -> None:
    assert emit_function_acl("public.set_updated_at()", None) == []


def test_emit_function_acl_public_kept() -> None:
    sig = "public.can_access_meeting(uuid, text)"
    assert emit_function_acl(sig, ["PUBLIC", "authenticated"]) == [
        f"REVOKE ALL ON FUNCTION {sig} FROM PUBLIC;",
        f"GRANT EXECUTE ON FUNCTION {sig} TO PUBLIC;",
        f"GRANT EXECUTE ON FUNCTION {sig} TO ricotdin_app;",
    ]


def test_emit_seed_uses_dollar_quoted_json_recordset() -> None:
    sql = emit_seed("app_config", '[{"key": "a", "value": "it\'s"}]')
    assert sql == (
        "INSERT INTO public.app_config SELECT * FROM jsonb_populate_recordset("
        'NULL::public.app_config, $seed$[{"key": "a", "value": "it\'s"}]$seed$::jsonb);'
    )
