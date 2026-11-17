"""PRF-13 review: a deleted account leaves a tombstone (the hash of its mmlabs ``sub`` and when),
so a re-created account gets no second signup grant and a token from before the delete is refused."""

import hashlib
from datetime import UTC, datetime

from app.auth.linking import after_delete, sub_hash

DELETED = datetime(2026, 11, 17, 10, 0, tzinfo=UTC)


def test_sub_hash_is_sha256_hex() -> None:
    assert sub_hash("abc") == hashlib.sha256(b"abc").hexdigest()


def test_never_deleted_is_a_normal_signup() -> None:
    assert after_delete(None, issued_at=0) == "grant"


def test_a_token_from_before_the_delete_is_refused() -> None:
    before = int(DELETED.timestamp()) - 1
    assert after_delete(DELETED, issued_at=before) == "refuse"
    assert after_delete(DELETED, issued_at=int(DELETED.timestamp())) == "refuse"  # same second


def test_a_new_sign_in_creates_an_account_without_a_second_grant() -> None:
    assert after_delete(DELETED, issued_at=int(DELETED.timestamp()) + 1) == "no_grant"
