"""ARC-04 (R1/R2): startup refuses a database login with more power than its job needs. Pure."""

from app.db.identity import LoginFacts, identity_problems


def _facts(**kw: object) -> LoginFacts:
    base: dict[str, object] = {
        "login": "ricotdin_api_login",
        "expected_group": "ricotdin_app",
        "member_of": {"ricotdin_app"},
        "is_superuser": False,
        "bypasses_rls": False,
        "inherits": False,
        "owns_public_tables": False,
    }
    base.update(kw)
    return LoginFacts(**base)  # type: ignore[arg-type]


def test_a_correct_login_has_no_problems() -> None:
    assert identity_problems(_facts()) == []


def test_owner_superuser_and_bypassrls_are_refused() -> None:
    problems = identity_problems(
        _facts(is_superuser=True, bypasses_rls=True, owns_public_tables=True)
    )
    assert len(problems) == 3
    assert any("owner" in p for p in problems)


def test_login_must_be_a_member_of_its_group() -> None:
    assert identity_problems(_facts(member_of=set())) == [
        "ricotdin_api_login is not a member of ricotdin_app"
    ]


def test_login_must_not_be_a_member_of_another_runtime_group() -> None:
    problems = identity_problems(_facts(member_of={"ricotdin_app", "ricotdin_service"}))
    assert problems == ["ricotdin_api_login is also a member of ricotdin_service"]


def test_login_must_be_noinherit() -> None:
    assert identity_problems(_facts(inherits=True)) == [
        "ricotdin_api_login must be NOINHERIT (privileges only after SET ROLE ricotdin_app)"
    ]
