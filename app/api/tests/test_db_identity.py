"""ARC-04 (R1/R2): startup refuses a database login with more power than its job needs. Pure.

Facts are about what the login can *reach*: roles it may SET ROLE to (transitively) and roles
whose privileges it inherits (per-grant INHERIT option on PG16+), not just direct memberships.
"""

from app.db.identity import LoginFacts, identity_problems


def _facts(**kw: object) -> LoginFacts:
    base: dict[str, object] = {
        "login": "ricotdin_api_login",
        "expected_group": "ricotdin_app",
        "settable_roles": {"ricotdin_app"},
        "inherited_roles": set(),
        "privileged_roles": set(),
        "is_superuser": False,
        "bypasses_rls": False,
        "can_create_roles": False,
        "owns_public_tables": False,
    }
    base.update(kw)
    return LoginFacts(**base)  # type: ignore[arg-type]


def test_a_correct_login_has_no_problems() -> None:
    assert identity_problems(_facts()) == []


def test_owner_superuser_bypassrls_and_createrole_are_refused() -> None:
    problems = identity_problems(
        _facts(is_superuser=True, bypasses_rls=True, owns_public_tables=True, can_create_roles=True)
    )
    assert len(problems) == 4
    assert any("owner" in p for p in problems)
    assert any("CREATEROLE" in p for p in problems)


def test_login_must_be_able_to_switch_to_its_group() -> None:
    assert identity_problems(_facts(settable_roles=set())) == [
        "ricotdin_api_login cannot SET ROLE ricotdin_app"
    ]


def test_any_other_reachable_role_is_refused_including_indirect_ones() -> None:
    # e.g. GRANT x TO login; GRANT ricotdin_service TO x — reachable through a chain.
    problems = identity_problems(_facts(settable_roles={"ricotdin_app", "x", "ricotdin_service"}))
    assert problems == ["ricotdin_api_login can also SET ROLE to: ricotdin_service, x"]


def test_inherited_privileges_are_refused() -> None:
    # PG16+: a membership granted WITH INHERIT TRUE survives ALTER ROLE ... NOINHERIT.
    assert identity_problems(_facts(inherited_roles={"ricotdin_app"})) == [
        "ricotdin_api_login inherits privileges of: ricotdin_app (grant must be WITH INHERIT FALSE)"
    ]


def test_reachable_privileged_role_is_refused() -> None:
    problems = identity_problems(
        _facts(settable_roles={"ricotdin_app"}, privileged_roles={"ricotdin_app"})
    )
    assert problems == [
        "ricotdin_api_login can reach a privileged role (superuser/BYPASSRLS/CREATEROLE/owner): "
        "ricotdin_app"
    ]
