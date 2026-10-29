"""ARC-06 review round 1 regressions. Pure (fake clients / connections, no network)."""

from contextlib import asynccontextmanager
from typing import Any

import anyio
import pytest
from botocore.exceptions import ClientError

from app.core.redact import is_secret_key
from app.services.config import parse_int_setting
from app.services.keys.pool import KeyPool, KeyWithMeta, NoUsableKeys, SpeechmaticsKeyPool
from app.services.keys.source import KeySource
from app.services.storage.config import R2Config, StorageConfigSource
from app.services.storage.r2 import R2Storage, UnsupportedContentType

CFG = R2Config("0123456789abcdef0123456789abcdef", "AKID", "secret", "bucket")
U = "11111111-1111-1111-1111-111111111111"
M = "22222222-2222-2222-2222-222222222222"


@pytest.mark.parametrize(
    "ct",
    ["audio/webm;codecs=opus", "audio/ogg; codecs=opus", "Audio/WebM", "video/webm;codecs=vp9"],
)
def test_recorder_mime_types_with_parameters_are_accepted(ct: str) -> None:
    # The browser recorder sends audio/webm;codecs=opus; the URL is signed with the exact string.
    assert R2Storage(CFG).upload_url(f"{U}/{M}.webm", ct).startswith("https://")


@pytest.mark.parametrize("ct", ["application/octet-stream", "text/html;x=audio/webm", ""])
def test_unsupported_upload_type_is_a_typed_4xx(ct: str) -> None:
    with pytest.raises(UnsupportedContentType) as info:
        R2Storage(CFG).upload_url(f"{U}/{M}.webm", ct)
    assert info.value.status == 415


class _MissingBucket:
    def head_bucket(self, Bucket: str) -> None:  # noqa: N803
        raise ClientError({"Error": {"Code": "404"}}, "HeadBucket")


def test_check_returns_false_for_a_missing_bucket() -> None:
    st = R2Storage(CFG)
    st._client = _MissingBucket()  # type: ignore[assignment]
    assert anyio.run(st.check) is False


class _BrokenConn:
    def __init__(self) -> None:
        self.calls = 0
        self.savepoints = 0

    @asynccontextmanager
    async def begin_nested(self) -> Any:
        self.savepoints += 1
        yield self

    async def execute(self, *_a: Any, **_k: Any) -> Any:
        self.calls += 1
        raise RuntimeError("connection reset")


def test_storage_config_db_failure_is_none_in_a_savepoint_and_not_cached_long() -> None:
    now = [0.0]
    src = StorageConfigSource(b"k" * 32, clock=lambda: now[0])
    conn = _BrokenConn()
    assert anyio.run(lambda: src.r2(conn)) is None  # type: ignore[arg-type]
    assert conn.savepoints == 1
    assert anyio.run(lambda: src.r2(conn)) is None and conn.calls == 1  # type: ignore[arg-type]
    now[0] = 6.0
    anyio.run(lambda: src.r2(conn))  # type: ignore[arg-type]
    assert conn.calls == 2  # retried well before the 30 s TTL


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
