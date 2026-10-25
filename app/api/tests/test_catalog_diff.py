"""ARC-02: pure catalog comparison used by the v1 ↔ v2 schema parity test."""

from app.db.catalog import Allowed, Difference, diff_catalogs, normalize_sql


def test_identical_catalogs_have_no_differences() -> None:
    cat = {"columns": {"meetings.title": "text|NO|"}}
    assert diff_catalogs(cat, cat) == []


def test_missing_extra_and_changed_are_reported() -> None:
    ref = {"columns": {"meetings.title": "text|NO|", "meetings.old": "int|YES|"}}
    new = {"columns": {"meetings.title": "varchar|NO|", "meetings.added": "int|YES|"}}

    assert diff_catalogs(ref, new) == [
        Difference("changed", "columns", "meetings.title", "text|NO|", "varchar|NO|"),
        Difference("extra", "columns", "meetings.added", None, "int|YES|"),
        Difference("missing", "columns", "meetings.old", "int|YES|", None),
    ]


def test_sections_present_on_one_side_only_are_compared() -> None:
    ref = {"policies": {"todos.p": "select"}}
    new: dict[str, dict[str, str]] = {}
    assert diff_catalogs(ref, new) == [
        Difference("missing", "policies", "todos.p", "select", None),
    ]


def test_allowed_rule_suppresses_only_its_kind_section_and_key_pattern() -> None:
    ref = {"tables": {"provider_keys": "t"}, "columns": {"users.email": "text"}}
    new = {"tables": {"users": "t"}, "columns": {"users.email": "citext"}}
    allowed = [
        Allowed("extra", "tables", "users", "own auth table replaces auth.users"),
        Allowed("missing", "tables", "provider_*", "dropped in v1 migration 015"),
    ]

    assert diff_catalogs(ref, new, allowed) == [
        Difference("changed", "columns", "users.email", "text", "citext"),
    ]


def test_normalize_sql_rewrites_supabase_auth_and_collapses_whitespace() -> None:
    v1 = "(auth.uid() = user_id)\n  OR ((auth.jwt() ->> 'user_role'::text) = 'admin'::text)"
    v2 = "(app_user_id() = user_id) OR (app_user_role() = 'admin'::text)"
    assert normalize_sql(v1) == normalize_sql(v2)


def test_normalize_sql_ignores_public_schema_qualification() -> None:
    a = "REFERENCES public.users(id) WHERE public.app_user_id() = x"
    b = "REFERENCES users(id) WHERE app_user_id() = x"
    assert normalize_sql(a) == normalize_sql(b)


def test_normalize_sql_keeps_unrelated_text() -> None:
    assert normalize_sql("  SELECT   1  ") == "SELECT 1"
