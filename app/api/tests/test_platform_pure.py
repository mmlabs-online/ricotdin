"""ARC-06: pure pieces of the platform services — env key fallback, TTL cache, config coercion,
masking guards, storage-key ownership (ports of provider-keys / storage-config / avatar-key /
retention tests) and offline R2 presigning."""

import uuid
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from app.services.cache import TtlCache
from app.services.config import coerce_config_bool, parse_int_setting
from app.services.keys.guards import is_last_active_key, mask_admin_config
from app.services.keys.source import config_key_for, env_keys
from app.services.storage.config import R2Config, mask_storage_row
from app.services.storage.ownership import (
    is_owned_audio_key,
    is_owned_avatar_key,
    owned_audio_delete_items,
    owned_audio_path,
)
from app.services.storage.r2 import (
    ObjectTooLarge,
    R2Storage,
    StorageObjectNotFound,
    UnsupportedContentType,
    presign_get,
    presign_put,
    r2_client,
)

# --- env fallback -----------------------------------------------------------------------------


def test_gemini_env_keys_merge_csv_numbered_and_single_without_duplicates() -> None:
    env = {
        "GEMINI_API_KEYS": " a, b ,,a",
        "GEMINI_API_KEY_1": "c",
        "GEMINI_API_KEY_20": "d",
        "GEMINI_API_KEY_21": "ignored",
        "GEMINI_API_KEY": "b",
    }
    assert [k.key for k in env_keys("gemini", env)] == ["a", "b", "c", "d"]
    assert all(k.id is None for k in env_keys("gemini", env))


@pytest.mark.parametrize(
    ("provider", "env", "expected"),
    [
        ("speechmatics", {"SPEECHMATICS_API_KEY": " s "}, ["s"]),
        ("openai", {"OPENAI_API_KEY": "o"}, ["o"]),
        ("grok", {"GROK_API_KEY": "", "XAI_API_KEY": "x"}, ["x"]),
        ("grok", {"GROK_API_KEY": "g", "XAI_API_KEY": "x"}, ["g"]),
        ("speechmatics", {}, []),
        ("unknown", {"UNKNOWN_API_KEY": "u"}, []),
    ],
)
def test_other_env_keys(provider: str, env: dict[str, str], expected: list[str]) -> None:
    assert [k.key for k in env_keys(provider, env)] == expected


def test_config_keys_match_v1() -> None:
    assert config_key_for("gemini") == "gemini_api_key"
    assert config_key_for("speechmatics") == "speechmatics_api_key"
    assert config_key_for("openai") == "openai_api_key"
    assert config_key_for("grok") == "grok_api_key"
    assert config_key_for("other") == "other_api_key"


# --- TTL cache ------------------------------------------------------------------------------------


def test_ttl_cache_expires_and_invalidates() -> None:
    now = [0.0]
    cache: TtlCache[str, int] = TtlCache(30, clock=lambda: now[0])
    cache.put("a", 1)
    assert cache.get("a") == (True, 1)
    now[0] = 29.9
    assert cache.get("a") == (True, 1)
    now[0] = 30.0
    assert cache.get("a") == (False, None)
    cache.put("a", 2)
    cache.put("b", 3)
    cache.invalidate("a")
    assert cache.get("a") == (False, None) and cache.get("b") == (True, 3)
    cache.invalidate()
    assert cache.get("b") == (False, None)


def test_ttl_cache_stores_none_as_a_value() -> None:
    cache: TtlCache[str, None] = TtlCache(30, clock=lambda: 0.0)
    cache.put("missing", None)
    assert cache.get("missing") == (True, None)


# --- config coercion ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "fallback", "expected"),
    [
        (True, False, True),
        (False, True, False),
        (1, False, True),
        (0, True, False),
        (2, False, False),
        (2, True, True),
        (" TRUE ", False, True),
        ("false", True, False),
        ("yes", False, False),
        ("1", False, False),
        (None, False, False),
        (None, True, True),
        ({"x": 1}, False, False),
        ([True], False, False),
        (1.0, False, False),
    ],
)
def test_malformed_values_never_turn_a_flag_on(value: Any, fallback: bool, expected: bool) -> None:
    assert coerce_config_bool(value, fallback) is expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (25, 25),
        ("25", 25),
        (0, None),
        (-1, None),
        (3651, None),
        (2.5, None),
        (True, None),
        ("x", None),
        (None, None),
    ],
)
def test_int_settings_are_bounded_or_none(value: Any, expected: int | None) -> None:
    assert parse_int_setting(value, minimum=1, maximum=3650) == expected


# --- masking guards -----------------------------------------------------------------------------


def test_is_last_active_key() -> None:
    assert is_last_active_key(0) and is_last_active_key(1)
    assert not is_last_active_key(2) and not is_last_active_key(50)


SENSITIVE = {
    "value_ciphertext": "CIPHER", "value_iv": "IVIV", "value_auth_tag": "TAGTAG", "created_by": "creator",
    "secret_ciphertext": "SCIPHER", "secret_iv": "SIV", "secret_auth_tag": "STAG",
}  # fmt: skip


def test_mask_admin_config_never_exposes_ciphertext() -> None:
    row = {
        "id": "1", "created_at": "t", "config_key": "gemini_api_key", "label": "main", "last4": "abcd",
        "status": "active", "disabled_reason": None, "last_used_at": None, "health_status": "healthy",
        "health_checked_at": None, "health_detail": None, **SENSITIVE,
    }  # fmt: skip
    masked = mask_admin_config(row)
    assert masked["last4"] == "abcd" and masked["health_status"] == "healthy"
    blob = repr(masked)
    for value in SENSITIVE.values():
        assert value not in blob
    assert "created_by" not in masked


def test_mask_storage_row_keeps_display_fields_only() -> None:
    row = {
        "id": "1", "created_at": "t", "updated_at": "t", "provider": "r2", "label": "prod",
        "account_id": "acc", "access_key_id": "AKID", "bucket": "b", "secret_last4": "wxyz",
        "status": "active", "disabled_reason": None, "last_used_at": None, **SENSITIVE,
    }  # fmt: skip
    masked = mask_storage_row(row)
    assert masked["secret_last4"] == "wxyz" and masked["bucket"] == "b"
    for value in SENSITIVE.values():
        assert value not in repr(masked)


def test_r2_config_repr_hides_the_secret() -> None:
    cfg = R2Config("0" * 32, "AKID", "very-secret-value", "bucket")
    assert "very-secret-value" not in repr(cfg)


# --- storage-key ownership (BUG-002/003/004) -----------------------------------------------------

U = "11111111-1111-1111-1111-111111111111"
M = "22222222-2222-2222-2222-222222222222"


@pytest.mark.parametrize("key", [f"{U}/{M}.webm", f"{U}/{M}.mp3", f"{U}/{M}"])
def test_own_audio_keys_are_accepted(key: str) -> None:
    assert is_owned_audio_key(key, U, M)


@pytest.mark.parametrize(
    "key",
    [
        f"99999999-9999-9999-9999-999999999999/{M}.webm",
        f"{U}/33333333-3333-3333-3333-333333333333.webm",
        f"{U}/{M}x.webm",
        f"{U}/{M}/../other.webm",
        f"{U}/{M}.webm/x",
        f"../{U}/{M}.webm",
        f"/{U}/{M}.webm",
        f"{U}/{M}.",
        f"{U}/{M}.toolongextension",
        f"{U}/{M}.we-bm",
        f"{U}/{M}.webm\n",
        f"avatars/{U}/{M}.png",
    ],
)
def test_foreign_or_crafted_audio_keys_are_rejected(key: str) -> None:
    assert not is_owned_audio_key(key, U, M)


def test_empty_inputs_are_rejected() -> None:
    assert not is_owned_audio_key("", U, M)
    assert not is_owned_audio_key(f"{U}/{M}.webm", "", M)
    assert not is_owned_audio_key(f"{U}/{M}.webm", U, "")


def test_owned_audio_path_and_delete_items() -> None:
    own = {"id": M, "user_id": U, "audio_path": f"{U}/{M}.webm", "storage_provider": "r2"}
    forged = {"id": M, "user_id": U, "audio_path": "other/key.webm", "storage_provider": "r2"}
    empty = {"id": M, "user_id": U, "audio_path": None, "storage_provider": "r2"}
    assert owned_audio_path(own) == f"{U}/{M}.webm"
    assert owned_audio_path(forged) is None and owned_audio_path(empty) is None
    assert owned_audio_delete_items([own, forged, empty]) == [(f"{U}/{M}.webm", "r2")]


AV = "3333abcd-3333-4333-8333-33333333abcd"


@pytest.mark.parametrize("ext", ["jpg", "png", "webp"])
def test_own_avatar_keys_are_accepted(ext: str) -> None:
    assert is_owned_avatar_key(f"avatars/{U}/{AV}.{ext}", U)


@pytest.mark.parametrize(
    "key",
    [
        f"{U}/{M}.webm",
        f"avatars/99999999-9999-9999-9999-999999999999/{AV}.png",
        f"avatars/{U}/{AV}.gif",
        f"avatars/{U}/{AV.upper()}.png",
        f"avatars/{U}/x/{AV}.png",
        f"avatars/{U}/../{AV}.png",
        f"avatars/{U}/{AV}.png\n",
        "",
    ],
)
def test_other_avatar_keys_are_rejected(key: str) -> None:
    assert not is_owned_avatar_key(key, U)


def test_avatar_user_id_with_slash_or_empty_is_rejected() -> None:
    assert not is_owned_avatar_key(f"avatars/a/b/{AV}.png", "a/b")
    assert not is_owned_avatar_key(f"avatars/{U}/{AV}.png", "")


# --- R2 presigning (offline: SigV4 is computed locally) ----------------------------------------


ACCOUNT = "0123456789abcdef0123456789abcdef"
CFG = R2Config(ACCOUNT, "AKIDEXAMPLE", "secret-example-value", "ricotdin-test")


def test_presigned_put_binds_bucket_key_and_content_type() -> None:
    client = r2_client(CFG)
    key = f"{U}/{uuid.uuid4()}.webm"
    url = presign_put(client, CFG.bucket, key, content_type="audio/webm", expires_in=900)
    parts = urlsplit(url)
    assert parts.scheme == "https"
    assert parts.netloc == f"{ACCOUNT}.r2.cloudflarestorage.com"
    assert parts.path == f"/ricotdin-test/{key}"
    q = parse_qs(parts.query)
    assert q["X-Amz-Expires"] == ["900"]
    assert "content-type" in q["X-Amz-SignedHeaders"][0]
    assert "secret-example-value" not in url


def test_presigned_get_expiry_is_bounded() -> None:
    client = r2_client(CFG)
    url = presign_get(client, CFG.bucket, f"{U}/{M}.webm", expires_in=3600)
    assert parse_qs(urlsplit(url).query)["X-Amz-Expires"] == ["3600"]
    with pytest.raises(ValueError):
        presign_get(client, CFG.bucket, f"{U}/{M}.webm", expires_in=8 * 24 * 3600)
    with pytest.raises(ValueError):
        presign_put(client, CFG.bucket, f"{U}/{M}.webm", content_type="audio/webm", expires_in=0)


# --- review round 1 --------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["--5", "\u00b2", "+5", " 5x", "5.5"])
def test_odd_numeric_strings_fail_closed_without_raising(value: str) -> None:
    assert parse_int_setting(value, minimum=1, maximum=3650) is None


def test_integral_json_floats_are_accepted_like_v1() -> None:
    assert parse_int_setting(30.0, minimum=1, maximum=3650) == 30
    assert parse_int_setting(30.5, minimum=1, maximum=3650) is None


@pytest.mark.parametrize(
    ("account", "bucket"),
    [
        ("evil.com/#", "b-ok"),
        ("169.254.169.254/x?", "b-ok"),
        ("A" * 32, "b-ok"),
        ("0" * 31, "b-ok"),
        ("0" * 32, "Bad_Bucket"),
        ("0" * 32, "ab"),
        ("0" * 32, "x" * 64),
        ("0" * 32, "-starts-with-dash"),
    ],
)
def test_r2_config_rejects_odd_account_ids_and_bucket_names(account: str, bucket: str) -> None:
    with pytest.raises(ValueError):
        R2Config(account, "AKID", "s", bucket)


def test_presigned_put_can_bind_the_content_length() -> None:
    client = r2_client(CFG)
    url = presign_put(
        client, CFG.bucket, f"{U}/{M}.webm", content_type="audio/webm", content_length=1234
    )
    assert "content-length" in parse_qs(urlsplit(url).query)["X-Amz-SignedHeaders"][0]


@pytest.mark.parametrize(
    "ct", ["text/html", "application/javascript", "image/svg+xml", "", "audio"]
)
def test_upload_urls_only_for_media_types(ct: str) -> None:
    with pytest.raises(UnsupportedContentType, match="content type"):
        R2Storage(CFG).upload_url(f"{U}/{M}.webm", ct)


@pytest.mark.parametrize(
    "ct", ["audio/webm", "audio/mpeg", "video/mp4", "image/png", "image/jpeg", "image/webp"]
)
def test_media_upload_types_are_allowed(ct: str) -> None:
    assert R2Storage(CFG).upload_url(f"{U}/{M}.bin", ct).startswith("https://")


class _FakeBody:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            out, self.data = self.data, b""
        else:
            out, self.data = self.data[:n], self.data[n:]
        return out

    def close(self) -> None:
        pass


class _FakeS3:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        from botocore.exceptions import ClientError

        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": len(self.objects[Key])}

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        from botocore.exceptions import ClientError

        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": _FakeBody(self.objects[Key])}


def _storage(objects: dict[str, bytes]) -> R2Storage:
    st = R2Storage(CFG)
    st._client = _FakeS3(objects)  # type: ignore[assignment]
    return st


def test_get_bytes_refuses_objects_over_the_limit() -> None:
    import anyio

    st = _storage({"k": b"x" * 100})
    assert anyio.run(lambda: st.get_bytes("k", "r2", max_bytes=100)) == b"x" * 100
    with pytest.raises(ObjectTooLarge):
        anyio.run(lambda: st.get_bytes("k", "r2", max_bytes=99))


def test_missing_objects_raise_not_found_not_unavailable() -> None:
    import anyio

    with pytest.raises(StorageObjectNotFound):
        anyio.run(lambda: _storage({}).get_bytes("nope", "r2", max_bytes=10))


def test_download_to_file_streams_and_respects_the_limit(tmp_path: Any) -> None:
    import anyio

    st = _storage({"k": b"abc" * 1000})
    target = tmp_path / "audio.webm"
    assert anyio.run(lambda: st.download_to_file("k", "r2", target, max_bytes=3000)) == 3000
    assert target.read_bytes() == b"abc" * 1000
    with pytest.raises(ObjectTooLarge):
        anyio.run(lambda: st.download_to_file("k", "r2", tmp_path / "b", max_bytes=10))
    assert not (tmp_path / "b").exists()


def test_key_source_skips_keys_reported_invalid() -> None:
    from app.services.keys.pool import KeyWithMeta
    from app.services.keys.source import KeySource

    src = KeySource(None, {"GEMINI_API_KEYS": "a,b"})
    src.mark_invalid(KeyWithMeta(None, "a"))
    assert [k.key for k in src.usable(env_keys("gemini", {"GEMINI_API_KEYS": "a,b"}))] == ["b"]


def test_a_rejected_key_is_retried_after_an_hour() -> None:
    """ARC-10c: the worker never sees the API's invalidate() after an admin re-enables or tops
    up a key, so a 401 mark expires on its own."""
    from app.services.keys.pool import KeyWithMeta
    from app.services.keys.source import INVALID_TTL_S, KeySource

    now = [1000.0]
    src = KeySource(None, {"GEMINI_API_KEYS": "a,b"}, clock=lambda: now[0])
    src.mark_invalid(KeyWithMeta(None, "a"))
    keys = env_keys("gemini", {"GEMINI_API_KEYS": "a,b"})
    assert [k.key for k in src.usable(keys)] == ["b"]
    now[0] += INVALID_TTL_S + 1
    assert [k.key for k in src.usable(keys)] == ["a", "b"]


def test_platform_keeps_only_provider_fallback_variables() -> None:
    from app.core.settings import Settings
    from app.services.platform import Platform

    env = {
        "GEMINI_API_KEY_3": "g", "OPENAI_API_KEY": "o", "DATABASE_URL": "postgres://x",
        "JWT_PRIVATE_KEY": "pem",
    }  # fmt: skip
    p = Platform.from_settings(Settings.model_validate({}), env=env)
    assert set(p.keys.env_names) == {"GEMINI_API_KEY_3", "OPENAI_API_KEY"}


@pytest.mark.parametrize(
    "text",
    [
        "https://a.r2.cloudflarestorage.com/b/k?X-Amz-Credential=AKID%2F20261029&X-Amz-Signature=abcdef0123",
        "x-amz-signature: abcdef0123",
    ],
)
def test_presigned_url_credentials_are_redacted(text: str) -> None:
    from app.core.redact import redact

    out = redact(text)
    assert "abcdef0123" not in out and "AKID%2F20261029" not in out
