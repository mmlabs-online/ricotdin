"""ARC-02 security review: what ricotdin_app may keep from v1's Supabase `authenticated` grants.

v1 only exposed tables through PostgREST, so Supabase's default GRANT ALL was harmless. In v2 the
API runs SQL as ricotdin_app, so privileges RLS does not govern (TRUNCATE, TRIGGER, REFERENCES,
MAINTAIN) are dropped, and write privileges are kept only where a policy can allow the command.
"""

from app.db.ddl import Policy
from app.db.grants import restrict_app_grants


def _p(cmd: str, roles: list[str] | None = None) -> Policy:
    return Policy("t", f"p_{cmd}", True, cmd, roles or ["authenticated"], "true", None)


def test_privileges_rls_does_not_govern_are_dropped_for_the_app() -> None:
    grants = [
        ("authenticated", p, None)
        for p in ["SELECT", "TRUNCATE", "TRIGGER", "REFERENCES", "MAINTAIN"]
    ]
    assert restrict_app_grants("t", grants, [_p("ALL")]) == [("authenticated", "SELECT", None)]


def test_writes_need_a_policy_for_that_command() -> None:
    grants = [("authenticated", p, None) for p in ["SELECT", "INSERT", "UPDATE", "DELETE"]]
    kept = restrict_app_grants("t", grants, [_p("SELECT"), _p("INSERT")])
    assert kept == [("authenticated", "SELECT", None), ("authenticated", "INSERT", None)]


def test_all_policy_and_public_policy_allow_every_dml_command() -> None:
    grants = [("authenticated", p, None) for p in ["SELECT", "INSERT", "UPDATE", "DELETE"]]
    assert restrict_app_grants("t", grants, [_p("ALL", ["public"])]) == grants


def test_policies_on_other_tables_or_for_other_roles_do_not_count() -> None:
    grants = [("authenticated", "UPDATE", None)]
    other_table = Policy("x", "p", True, "UPDATE", ["authenticated"], "true", None)
    service_only = Policy("t", "p", True, "UPDATE", ["service_role"], "true", None)
    assert restrict_app_grants("t", grants, [other_table, service_only]) == []


def test_column_level_update_follows_the_update_policy() -> None:
    grants = [("authenticated", "UPDATE", "username")]
    assert restrict_app_grants("t", grants, [_p("UPDATE")]) == grants


def test_service_role_and_other_grantees_are_untouched() -> None:
    grants = [("service_role", "TRUNCATE", None), ("anon", "SELECT", None)]
    assert restrict_app_grants("t", grants, []) == grants
