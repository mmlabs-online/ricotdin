"""ARC-05: opaque refresh / email tokens and the refresh decision. Pure."""

from datetime import UTC, datetime, timedelta

from app.auth.tokens import (
    RefreshRow,
    hash_token,
    is_expired,
    new_opaque_token,
    refresh_outcome,
    should_revoke_family,
)

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)


def _row(**kw: object) -> RefreshRow:
    base: dict[str, object] = {
        "revoked_at": None,
        "expires_at": NOW + timedelta(days=1),
        "user_disabled": False,
    }
    base.update(kw)
    return RefreshRow(**base)  # type: ignore[arg-type]


def test_tokens_are_long_random_and_url_safe() -> None:
    a, b = new_opaque_token(), new_opaque_token()
    assert a != b and len(a) >= 43
    assert all(c.isalnum() or c in "-_" for c in a)


def test_only_the_hash_is_stored_and_it_is_stable() -> None:
    t = new_opaque_token()
    assert hash_token(t) == hash_token(t) != t
    assert len(hash_token(t)) == 64


def test_expiry_is_inclusive_of_the_boundary() -> None:
    assert is_expired(NOW, NOW)
    assert not is_expired(NOW + timedelta(seconds=1), NOW)


def test_a_revoked_token_presented_again_is_reuse() -> None:
    assert should_revoke_family(NOW - timedelta(minutes=1))
    assert not should_revoke_family(None)


def test_refresh_outcomes() -> None:
    assert refresh_outcome(None, NOW) == "unknown"
    assert refresh_outcome(_row(), NOW) == "ok"
    assert refresh_outcome(_row(revoked_at=NOW), NOW) == "reuse"
    assert refresh_outcome(_row(expires_at=NOW), NOW) == "expired"
    assert refresh_outcome(_row(user_disabled=True), NOW) == "disabled"


def test_reuse_wins_over_disabled_and_expired() -> None:
    # A replayed token always kills its family, whatever else is true.
    assert refresh_outcome(_row(revoked_at=NOW, user_disabled=True, expires_at=NOW), NOW) == "reuse"


def test_disabled_wins_over_expired() -> None:
    assert refresh_outcome(_row(user_disabled=True, expires_at=NOW), NOW) == "disabled"
