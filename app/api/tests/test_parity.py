"""ARC-02: turning schema snapshots into comparable catalogs (pure part of the parity test)."""

from app.db.catalog import diff_catalogs
from app.db.ddl import Column, Policy
from app.db.introspect import Function, Schema
from app.db.parity import ALLOWED, SKIPPED_V1_FUNCTIONS, to_catalog


def _v1() -> Schema:
    s = Schema()
    s.tables = {"meetings": [Column("user_id", "uuid", True)]}
    s.constraints = [
        ("meetings", "fk", "f", "FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE")
    ]
    s.policies = [
        Policy("meetings", "own", True, "ALL", ["authenticated"], "(auth.uid() = user_id)", None),
        Policy("meetings", "anon", True, "SELECT", ["anon"], "true", None),
    ]
    s.table_grants = {"meetings": [("authenticated", "SELECT", None), ("anon", "SELECT", None)]}
    s.functions = [
        Function("claim_next_job", "text", "body", ["service_role"], True, "v"),
        Function("custom_access_token_hook", "event jsonb", "hook", None, False, "s"),
    ]
    s.rls = {"meetings": (True, False)}
    return s


def _v2() -> Schema:
    s = Schema()
    s.tables = {"meetings": [Column("user_id", "uuid", True)]}
    s.constraints = [
        ("meetings", "fk", "f", "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE")
    ]
    s.policies = [
        Policy("meetings", "own", True, "ALL", ["ricotdin_app"], "(app_user_id() = user_id)", None),
        Policy("meetings", "service_all", True, "ALL", ["ricotdin_service"], "true", "true"),
    ]
    s.table_grants = {"meetings": [("ricotdin_app", "SELECT", None)]}
    s.functions = [Function("claim_next_job", "text", "body", ["ricotdin_service"], True, "v")]
    s.rls = {"meetings": (True, False)}
    return s


def test_equivalent_v1_and_v2_snapshots_have_no_unexplained_differences() -> None:
    assert diff_catalogs(to_catalog(_v1(), v1=True), to_catalog(_v2(), v1=False), ALLOWED) == []


def test_a_missing_grant_in_v2_is_reported() -> None:
    v2 = _v2()
    v2.table_grants = {}
    diffs = diff_catalogs(to_catalog(_v1(), v1=True), to_catalog(v2, v1=False), ALLOWED)
    assert [(d.kind, d.section, d.key) for d in diffs] == [
        ("missing", "table_grants", "meetings|ricotdin_app|SELECT|")
    ]


def test_a_changed_policy_expression_is_reported() -> None:
    v2 = _v2()
    v2.policies[0] = Policy("meetings", "own", True, "ALL", ["ricotdin_app"], "true", None)
    diffs = diff_catalogs(to_catalog(_v1(), v1=True), to_catalog(v2, v1=False), ALLOWED)
    assert [(d.kind, d.section, d.key) for d in diffs] == [("changed", "policies", "meetings.own")]


def test_skipped_v1_functions_are_not_expected_in_v2() -> None:
    assert "custom_access_token_hook" in SKIPPED_V1_FUNCTIONS
    assert "functions" not in to_catalog(_v1(), v1=True) or not any(
        k.startswith("public.custom_access_token_hook")
        for k in to_catalog(_v1(), v1=True)["functions"]
    )
