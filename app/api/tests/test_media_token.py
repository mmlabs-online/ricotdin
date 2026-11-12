"""ARC-17: signed /media tokens (HMAC-SHA256 over key + expiry, key derived from the master key)."""

import pytest

from app.services.storage.media_token import (
    MAX_MEDIA_TTL_S,
    MediaTokenSigner,
    derive_media_key,
)

MASTER = bytes(range(32))
NOW = 1_800_000_000.0


def signer(master: bytes = MASTER) -> MediaTokenSigner:
    return MediaTokenSigner(derive_media_key(master))


def test_round_trip_returns_the_key() -> None:
    s = signer()
    token = s.sign("u1/m1.webm", now=NOW, ttl=600)
    assert s.verify(token, now=NOW + 599) == "u1/m1.webm"


def test_token_is_url_safe_and_does_not_contain_the_key_in_clear() -> None:
    token = signer().sign("avatars/u/x.png", now=NOW, ttl=60)
    assert all(c.isalnum() or c in "-_." for c in token)
    assert "avatars" not in token


def test_expired_token_is_rejected() -> None:
    s = signer()
    token = s.sign("k", now=NOW, ttl=60)
    assert s.verify(token, now=NOW + 60) is None
    assert s.verify(token, now=NOW + 3600) is None


def test_ttl_is_capped_at_15_minutes() -> None:
    assert MAX_MEDIA_TTL_S == 900
    with pytest.raises(ValueError):
        signer().sign("k", now=NOW, ttl=901)
    with pytest.raises(ValueError):
        signer().sign("k", now=NOW, ttl=0)


def test_token_signed_too_far_in_the_future_is_rejected() -> None:
    # Expiry beyond now + MAX (clock skew between signer and verifier, or a forged expiry with a
    # leaked key) is never accepted.
    s = signer()
    token = s.sign("k", now=NOW + 3600, ttl=60)
    assert s.verify(token, now=NOW) is None


@pytest.mark.parametrize(
    "mutate",
    [
        lambda t: t[:-1] + ("A" if t[-1] != "A" else "B"),  # signature
        lambda t: "9" + t[1:] if t[0] != "9" else "8" + t[1:],  # expiry
        lambda t: t.replace(".", "..", 1),
        lambda t: t + ".x",
        lambda t: "",
        lambda t: "a" * 5000,
        lambda t: "not-a-token",
        lambda t: "1.2.3",
    ],
)
def test_tampered_or_malformed_tokens_are_rejected(mutate) -> None:  # type: ignore[no-untyped-def]
    s = signer()
    token = s.sign("u1/m1.webm", now=NOW, ttl=600)
    assert s.verify(mutate(token), now=NOW) is None


def test_swapping_the_key_part_breaks_the_signature() -> None:
    s = signer()
    a = s.sign("u1/a.webm", now=NOW, ttl=600).split(".")
    b = s.sign("u1/b.webm", now=NOW, ttl=600).split(".")
    forged = ".".join([a[0], b[1], a[2]])
    assert s.verify(forged, now=NOW) is None


def test_other_master_key_cannot_verify() -> None:
    token = signer().sign("k", now=NOW, ttl=600)
    assert signer(bytes(32)).verify(token, now=NOW) is None


def test_derived_key_differs_from_the_master_key() -> None:
    derived = derive_media_key(MASTER)
    assert len(derived) == 32
    assert derived != MASTER


def test_derive_rejects_a_wrong_length_master_key() -> None:
    with pytest.raises(ValueError):
        derive_media_key(b"short")


def test_repr_hides_the_key() -> None:
    assert "MediaTokenSigner()" == repr(signer())
