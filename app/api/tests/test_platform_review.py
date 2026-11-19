"""ARC-06 review round 1 regressions. Pure (fake clients / connections, no network)."""

import pytest

from app.core.redact import is_secret_key
from app.services.config import parse_int_setting
from app.services.keys.pool import KeyPool, KeyWithMeta, NoUsableKeys, SpeechmaticsKeyPool
from app.services.keys.source import KeySource

U = "11111111-1111-1111-1111-111111111111"
M = "22222222-2222-2222-2222-222222222222"


def test_invalidate_lets_an_admin_bring_back_a_key_rejected_with_401() -> None:
    src = KeySource(None, {"GEMINI_API_KEYS": "a,b"})
    a = KeyWithMeta(None, "a")
    src.mark_invalid(a)
    assert [k.key for k in src.usable([a])] == []
    src.invalidate("gemini")
    assert [k.key for k in src.usable([a])] == ["a"]


def test_huge_numeric_string_fails_closed() -> None:
    assert parse_int_setting("9" * 5000, minimum=1, maximum=3650) is None


def test_no_usable_keys_is_a_typed_unavailable_error() -> None:
    with pytest.raises(NoUsableKeys) as info:
        SpeechmaticsKeyPool([])
    assert info.value.status == 503
    with pytest.raises(NoUsableKeys):
        KeyPool([], lambda _k: None, "Gemini", None)  # type: ignore[arg-type]


def test_signature_mapping_keys_are_secret() -> None:
    assert is_secret_key("signature")
    assert is_secret_key("X-Amz-Signature")
