"""ARC-05: opaque refresh / email tokens and the refresh decision. Pure."""

from datetime import UTC, datetime, timedelta

from app.auth.tokens import (
    ABSOLUTE_TTL,
    REUSE_GRACE,
    RefreshRow,
    hash_token,
    is_expired,
    new_opaque_token,
    refresh_expiry,
    refresh_outcome,
    should_revoke_family,
)

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)


def _row(**kw: object) -> RefreshRow:
    base: dict[str, object] = {
        "revoked_at": None,
        "expires_at": NOW + timedelta(days=1),
        "user_disabled": False,
        "rotated": False,
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


def test_only_a_rotated_token_presented_after_the_grace_window_is_reuse() -> None:
    old = NOW - REUSE_GRACE - timedelta(seconds=1)
    assert should_revoke_family(old, rotated=True, now=NOW)
    assert not should_revoke_family(NOW - timedelta(seconds=2), rotated=True, now=NOW)  # race
    assert not should_revoke_family(old, rotated=False, now=NOW)  # logout / reset / expiry
    assert not should_revoke_family(None, rotated=False, now=NOW)


def test_refresh_outcomes() -> None:
    long_ago = NOW - timedelta(minutes=5)
    assert refresh_outcome(None, NOW) == "unknown"
    assert refresh_outcome(_row(), NOW) == "ok"
    assert refresh_outcome(_row(revoked_at=long_ago, rotated=True), NOW) == "reuse"
    assert refresh_outcome(_row(revoked_at=NOW, rotated=True), NOW) == "raced"
    assert refresh_outcome(_row(revoked_at=long_ago), NOW) == "revoked"
    assert refresh_outcome(_row(expires_at=NOW), NOW) == "expired"
    assert refresh_outcome(_row(user_disabled=True), NOW) == "disabled"


def test_reuse_wins_over_disabled_and_expired() -> None:
    # A replayed token always kills its family, whatever else is true.
    old = NOW - timedelta(minutes=5)
    row = _row(revoked_at=old, rotated=True, user_disabled=True, expires_at=NOW)
    assert refresh_outcome(row, NOW) == "reuse"


def test_disabled_wins_over_expired() -> None:
    assert refresh_outcome(_row(user_disabled=True, expires_at=NOW), NOW) == "disabled"


# --- SEC-05: absolute session lifetime --------------------------------------------------------


def test_sec05_a_family_older_than_90_days_is_expired() -> None:
    start = NOW - ABSOLUTE_TTL - timedelta(seconds=1)
    assert refresh_outcome(_row(family_started_at=start), NOW) == "expired"
    assert refresh_outcome(_row(family_started_at=NOW - ABSOLUTE_TTL), NOW) == "expired"


def test_sec05_a_family_inside_90_days_still_refreshes() -> None:
    assert refresh_outcome(_row(family_started_at=NOW - timedelta(days=89)), NOW) == "ok"
    assert refresh_outcome(_row(), NOW) == "ok"  # unknown start: only the sliding expiry applies


def test_sec05_new_tokens_never_outlive_the_family() -> None:
    ttl = timedelta(days=30)
    assert refresh_expiry(NOW, ttl, family_started_at=None) == NOW + ttl
    young = NOW - timedelta(days=10)
    assert refresh_expiry(NOW, ttl, family_started_at=young) == NOW + ttl
    old = NOW - timedelta(days=80)
    assert refresh_expiry(NOW, ttl, family_started_at=old) == old + ABSOLUTE_TTL


def test_sec05_absolute_lifetime_is_90_days() -> None:
    assert ABSOLUTE_TTL == timedelta(days=90)
