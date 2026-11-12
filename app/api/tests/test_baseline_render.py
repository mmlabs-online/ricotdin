"""ARC-02: assembling the v2 baseline from a (replayed v1) schema snapshot. Pure."""

from app.db.baseline import render_baseline
from app.db.ddl import Column, Policy
from app.db.introspect import Function, Schema


def _schema() -> Schema:
    s = Schema()
    s.extensions = ["pgcrypto", "vector"]
    s.enums = {"todo_status": ["open", "done"]}
    s.tables = {
        "meetings": [
            Column("id", "uuid", True, "gen_random_uuid()"),
            Column("user_id", "uuid", True),
        ]
    }
    s.constraints = [
        ("meetings", "meetings_user_id_fkey", "f",
         "FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE"),
        ("meetings", "meetings_pkey", "p", "PRIMARY KEY (id)"),
    ]  # fmt: skip
    s.indexes = [
        (
            "meetings",
            "idx_meetings_user_id",
            "CREATE INDEX idx_meetings_user_id ON public.meetings USING btree (user_id)",
        )
    ]
    s.functions = [
        Function("set_updated_at", "", "CREATE OR REPLACE FUNCTION public.set_updated_at()\n body", None, False, "v"),
        Function("custom_access_token_hook", "event jsonb", "CREATE FUNCTION hook", ["supabase_auth_admin"], False, "s"),
        Function("prevent_role_escalation", "", "uses current_setting('request.jwt.claims')", None, True, "v"),
        Function("claim_next_job", "text", "CREATE OR REPLACE FUNCTION public.claim_next_job(text) x", ["service_role"], True, "v"),
    ]  # fmt: skip
    s.triggers = [
        (
            "meetings",
            "trg",
            "CREATE TRIGGER trg BEFORE UPDATE ON public.meetings FOR EACH ROW EXECUTE FUNCTION set_updated_at()",
        )
    ]
    s.rls = {"meetings": (True, False)}
    s.policies = [
        Policy("meetings", "own", True, "ALL", ["authenticated"], "(auth.uid() = user_id)", None)
    ]
    s.table_grants = {"meetings": [("authenticated", "SELECT", None), ("anon", "SELECT", None)]}
    s.comments = [("meetings", None, "root"), ("meetings", "user_id", "owner")]
    s.seeds = {"meetings": "[]"}
    return s


def _render() -> str:
    return render_baseline(
        _schema(),
        prelude="-- PRELUDE",
        epilogue="-- EPILOGUE",
        overrides={
            "prevent_role_escalation": "CREATE FUNCTION public.prevent_role_escalation() v2"
        },
        skip_functions={"custom_access_token_hook"},
    )


def test_sections_are_in_dependency_order() -> None:
    out = _render()
    order = [
        "CREATE EXTENSION IF NOT EXISTS pgcrypto",
        "-- PRELUDE",
        "CREATE TYPE public.todo_status",
        "CREATE TABLE public.meetings",
        # after tables: v1 functions return table row types (e.g. SETOF jobs)
        "CREATE OR REPLACE FUNCTION public.set_updated_at()",
        "ADD CONSTRAINT meetings_pkey",
        "ADD CONSTRAINT meetings_user_id_fkey",
        "CREATE INDEX idx_meetings_user_id",
        "COMMENT ON TABLE public.meetings",
        "CREATE TRIGGER trg",
        "ENABLE ROW LEVEL SECURITY",
        "CREATE POLICY own",
        "CREATE POLICY service_all",
        "GRANT SELECT ON TABLE public.meetings TO ricotdin_app;",
        "GRANT EXECUTE ON FUNCTION public.claim_next_job(text) TO ricotdin_service;",
        "-- EPILOGUE",
    ]
    positions = [out.index(marker) for marker in order]
    assert positions == sorted(positions)


def test_check_function_bodies_is_off_for_this_migration_only() -> None:
    assert "SET LOCAL check_function_bodies = false;" in _render()


def test_app_role_never_gets_privileges_rls_does_not_govern() -> None:
    s = _schema()
    s.functions = []
    s.table_grants = {
        "meetings": [
            ("authenticated", p, None) for p in ["SELECT", "TRUNCATE", "TRIGGER", "UPDATE"]
        ]
    }
    out = render_baseline(s, prelude="", epilogue="", overrides={}, skip_functions=set())
    # policy "own" is FOR ALL TO authenticated → UPDATE stays; TRUNCATE/TRIGGER never do
    assert "GRANT SELECT, UPDATE ON TABLE public.meetings TO ricotdin_app;" in out
    assert "TRUNCATE" not in out and "TRIGGER ON" not in out


def test_supabase_references_are_rewritten() -> None:
    out = _render()
    assert "REFERENCES public.users(id) ON DELETE CASCADE" in out
    assert "public.app_user_id() = user_id" in out
    assert "auth." not in out.replace("'", "")  # nothing left outside string literals either


def test_skipped_function_and_its_acl_are_absent() -> None:
    out = _render()
    assert "custom_access_token_hook" not in out
    assert "supabase_auth_admin" not in out


def test_override_replaces_the_v1_definition() -> None:
    out = _render()
    assert "CREATE FUNCTION public.prevent_role_escalation() v2;" in out
    assert "request.jwt" not in out


def test_every_rls_table_gets_a_service_policy() -> None:
    assert (
        "CREATE POLICY service_all ON public.meetings AS PERMISSIVE FOR ALL "
        "TO ricotdin_service USING (true) WITH CHECK (true);"
    ) in _render()


def test_dropped_roles_produce_no_grants_and_empty_seeds_are_skipped() -> None:
    out = _render()
    assert " anon" not in out
    assert "INSERT INTO public.meetings" not in out


def test_seed_rows_leave_now_defaults_to_the_database_so_output_is_deterministic() -> None:
    s = _schema()
    s.tables["app_config"] = [
        Column("key", "text", True),
        Column("updated_at", "timestamp with time zone", True, "now()"),
    ]
    s.seeds = {"app_config": '[{"key": "k", "updated_at": "2026-10-25 09:07:25+00"}]'}
    s.functions = []
    out = render_baseline(s, prelude="", epilogue="", overrides={}, skip_functions=set())
    assert "INSERT INTO public.app_config (key) VALUES\n  ('k'::text);" in out
    assert "2026-10-25" not in out


def test_comments_on_table_and_column() -> None:
    out = _render()
    assert "COMMENT ON TABLE public.meetings IS 'root';" in out
    assert "COMMENT ON COLUMN public.meetings.user_id IS 'owner';" in out
