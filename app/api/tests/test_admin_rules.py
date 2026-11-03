"""ARC-10a pure admin rules. Ports of v1 ``tests/admin-guards.test.ts`` (self / last-admin guards,
bulk body, exclude self), ``tests/user-status.test.ts`` (3-way status) and
``tests/usage-by-user.test.ts`` (month range), plus the v2 list-parameter and quota-grant
parsing."""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest

from app.core.errors import BadRequest, UnprocessableEntity
from app.domain.admin import (
    BULK_MAX_IDS,
    MAX_GRANT_MINUTES,
    MAX_GRANT_QUERIES,
    exclude_self,
    guard_delete,
    guard_disable,
    guard_promotion,
    guard_role_change,
    like_pattern,
    month_range,
    parse_bulk,
    parse_list_params,
    parse_quota_grant,
    parse_role,
    parse_status,
    user_status,
)

ME, OTHER = uuid.uuid4(), uuid.uuid4()


# --- guards (v1 lib/admin/guards.ts) -----------------------------------------------------------


def _blocked(fn: object, *args: object) -> str:
    with pytest.raises(BadRequest) as err:
        fn(*args)  # type: ignore[operator]
    return err.value.public_message


def test_role_change_guard() -> None:
    guard_role_change(ME, OTHER, "user", "admin", 1)  # promotion always passes
    guard_role_change(ME, OTHER, "admin", "admin", 1)  # not a demotion
    guard_role_change(ME, OTHER, "admin", "user", 2)
    assert _blocked(guard_role_change, ME, ME, "admin", "user", 3) == "You cannot demote yourself."
    assert _blocked(guard_role_change, ME, OTHER, "admin", "user", 1) == (
        "Cannot demote the last remaining admin."
    )


def test_disable_guard() -> None:
    guard_disable(ME, OTHER, "user", 1)
    guard_disable(ME, OTHER, "admin", 2)
    assert _blocked(guard_disable, ME, ME, "user", 5) == "You cannot disable your own account."
    assert _blocked(guard_disable, ME, OTHER, "admin", 1) == (
        "Cannot disable the last remaining admin."
    )


def test_delete_guard() -> None:
    guard_delete(ME, OTHER, "user", 1)
    guard_delete(ME, OTHER, "admin", 2)
    assert _blocked(guard_delete, ME, ME, "admin", 5) == "You cannot delete your own account."
    assert _blocked(guard_delete, ME, OTHER, "admin", 1) == (
        "Cannot delete the last remaining admin."
    )


# --- bodies -------------------------------------------------------------------------------------


def _invalid(fn: object, body: object) -> str:
    with pytest.raises(UnprocessableEntity) as err:
        fn(body)  # type: ignore[operator]
    return err.value.public_message


def test_parse_role_and_status() -> None:
    assert parse_role({"role": "admin"}) == "admin" and parse_role({"role": "user"}) == "user"
    bad: dict[str, Any]
    for bad in ({}, {"role": "owner"}, {"role": None}, {"role": ["admin"]}):
        assert _invalid(parse_role, bad) == "role must be one of: user, admin."
    assert parse_status({"disabled": True}) is True and parse_status({"disabled": False}) is False
    for bad in ({}, {"disabled": 1}, {"disabled": "true"}):
        assert _invalid(parse_status, bad) == "disabled must be a boolean."


def test_parse_bulk() -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    assert parse_bulk({"ids": [str(a), str(b), str(a)], "action": "disable"}) == (
        [a, b], "disable", None,
    )  # fmt: skip
    assert parse_bulk({"ids": [str(a)], "action": "set_role", "role": "admin"}) == (
        [a], "set_role", "admin",
    )  # fmt: skip
    assert _invalid(parse_bulk, {"ids": [], "action": "enable"}) == "ids must be a non-empty array."
    assert (
        _invalid(parse_bulk, {"ids": "x", "action": "enable"}) == "ids must be a non-empty array."
    )
    too_many = [str(uuid.uuid4()) for _ in range(BULK_MAX_IDS + 1)]
    assert _invalid(parse_bulk, {"ids": too_many, "action": "enable"}) == (
        f"ids may not exceed {BULK_MAX_IDS} entries per request."
    )
    assert _invalid(parse_bulk, {"ids": ["nope"], "action": "enable"}) == "ids must be user ids."
    assert _invalid(parse_bulk, {"ids": [str(a)], "action": "delete"}) == (
        "action must be one of: disable, enable, set_role."
    )
    assert _invalid(parse_bulk, {"ids": [str(a)], "action": "set_role", "role": "x"}) == (
        "role must be one of: user, admin."
    )
    assert BULK_MAX_IDS == 50  # v1


def test_exclude_self() -> None:
    assert exclude_self(ME, [OTHER, ME]) == ([OTHER], True)
    assert exclude_self(ME, [OTHER]) == ([OTHER], False)


def test_parse_quota_grant() -> None:
    assert parse_quota_grant({"audio_minutes": 1.5, "agent_queries": 3, "note": " hi "}) == (
        90, 3, "hi",
    )  # fmt: skip
    assert parse_quota_grant({"agent_queries": 2}) == (0, 2, None)
    assert parse_quota_grant({"audio_minutes": 1, "note": "x" * 600})[2] == "x" * 500

    def bad(body: dict[str, Any]) -> str:
        with pytest.raises(BadRequest) as err:
            parse_quota_grant(body)
        return err.value.public_message

    assert bad({"audio_minutes": -1}) == "Values must be non-negative."
    assert bad({}) == "Provide at least one positive value."
    assert bad({"audio_minutes": 0, "agent_queries": 0}) == "Provide at least one positive value."
    for body in ({"audio_minutes": float("nan")}, {"audio_minutes": float("inf")},
                 {"agent_queries": 1.5}, {"agent_queries": True}, {"audio_minutes": "5"},
                 {"audio_minutes": MAX_GRANT_MINUTES + 1},
                 {"agent_queries": MAX_GRANT_QUERIES + 1}):  # fmt: skip
        assert bad(body) == "Values must be finite numbers within the grant limits."


# --- status + list (v1 user-status / usage-by-user) ------------------------------------------------


def test_user_status() -> None:
    now = datetime(2026, 11, 3, tzinfo=UTC)
    assert user_status(disabled_at=now, email_verified_at=now) == "disabled"  # wins
    assert user_status(disabled_at=now, email_verified_at=None) == "disabled"
    assert user_status(disabled_at=None, email_verified_at=None) == "unverified"
    assert user_status(disabled_at=None, email_verified_at=now) == "active"


def test_month_range() -> None:
    now = datetime(2026, 11, 3, 10, tzinfo=UTC)
    assert month_range("2026-02", now) == (
        "2026-02", datetime(2026, 2, 1, tzinfo=UTC), datetime(2026, 3, 1, tzinfo=UTC),
    )  # fmt: skip
    assert month_range("2025-12", now)[2] == datetime(2026, 1, 1, tzinfo=UTC)  # December rolls
    for bad in (None, "", "2026-13", "2026-1", "garbage", "2026-00"):
        assert month_range(bad, now)[0] == "2026-11"  # current month


def test_parse_list_params() -> None:
    p = parse_list_params({"page": "3", "perPage": "50", "search": "  Ann%_ "})
    assert (p.page, p.per_page, p.search) == (3, 50, "ann%_")
    p = parse_list_params({})
    assert (p.page, p.per_page, p.search) == (1, 20, "")
    p = parse_list_params({"page": "-4", "perPage": "1000"})
    assert (p.page, p.per_page) == (1, 100)  # v1 clamps
    p = parse_list_params({"page": "x", "perPage": "0"})
    assert (p.page, p.per_page) == (1, 1)
    assert parse_list_params({"search": "y" * 500}).search == "y" * 200


def test_like_pattern_escapes_wildcards() -> None:
    assert like_pattern("ann") == "%ann%"
    assert like_pattern("50%_a\\b") == "%50\\%\\_a\\\\b%"


def test_promotion_needs_an_active_verified_account() -> None:
    guard_promotion("admin", "active")
    guard_promotion("user", "unverified")  # demotion / no change: always fine
    for status in ("unverified", "disabled"):
        with pytest.raises(BadRequest):
            guard_promotion("admin", status)


def test_review_edge_inputs() -> None:
    now = datetime(2026, 11, 3, tzinfo=UTC)
    for bad in ("0000-05", "9999-12", "1969-12", "2101-01"):
        assert month_range(bad, now)[0] == "2026-11"
    assert month_range("2100-12", now)[2] == datetime(2101, 1, 1, tzinfo=UTC)
    assert parse_list_params({"page": "99999999999999999999"}).page == 10_000
    with pytest.raises(BadRequest):
        parse_quota_grant({"audio_minutes": 0.001})  # rounds to 0 seconds
