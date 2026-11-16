"""AUT-05: mapping an mmlabs account to a ricotdin user (pure rules)."""

import re
import uuid

import pytest

from app.auth.linking import LinkDecision, base_username, link_decision, username_candidates

VALID = re.compile(r"^[a-z0-9_-]{3,30}$")  # profiles_username_charset + _length
SUB = "0b8f2c1e-1111-4222-8333-444455556666"
U1, U2 = uuid.uuid4(), uuid.uuid4()


@pytest.mark.parametrize(
    ("email", "expected"),
    [
        ("Owner@example.com", "owner"),
        ("first.last+tag@x.com", "first-last-tag"),
        ("a@x.com", "a00"),
        ("ab@x.com", "ab0"),
        ("Ngọc.Ánh@x.vn", "ng-c-nh"),
        ("..__@x.com", "__0"),
        ("...@x.com", "user"),
        ("x" * 40 + "@x.com", "x" * 30),
        ("we!rd#chars@x.com", "we-rd-chars"),
    ],
)
def test_base_username(email: str, expected: str) -> None:
    assert base_username(email) == expected
    assert VALID.match(base_username(email))


def test_candidates_add_a_suffix_and_stay_valid() -> None:
    got = list(username_candidates("owner@x.com", 4))
    assert got == ["owner", "owner-2", "owner-3", "owner-4"]
    long = list(username_candidates("x" * 40 + "@x.com", 3))
    assert long == ["x" * 30, "x" * 28 + "-2", "x" * 28 + "-3"]
    assert all(VALID.match(c) for c in long)


def test_already_linked_by_sub_uses_that_user() -> None:
    assert link_decision(U1, None, SUB) == LinkDecision("use", U1)
    # the email now belongs to someone else: the sub still wins (email changes at mmlabs)
    assert link_decision(U1, (U2, None), SUB) == LinkDecision("use", U1)


def test_unlinked_user_with_the_same_email_gets_linked() -> None:
    assert link_decision(None, (U2, None), SUB) == LinkDecision("link", U2)


def test_no_user_creates_one() -> None:
    assert link_decision(None, None, SUB) == LinkDecision("create", None)


def test_a_user_linked_to_another_sub_is_never_taken_over() -> None:
    assert link_decision(None, (U2, "another-sub"), SUB) == LinkDecision("conflict", None)


def test_a_user_already_linked_to_this_sub_by_email_is_used() -> None:
    # race: another request linked it between our two reads
    assert link_decision(None, (U2, SUB), SUB) == LinkDecision("use", U2)
