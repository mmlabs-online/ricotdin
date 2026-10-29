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
from app.services.storage.r2 import presign_get, presign_put, r2_client

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
    cfg = R2Config("acc", "AKID", "very-secret-value", "bucket")
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


CFG = R2Config("acct123", "AKIDEXAMPLE", "secret-example-value", "ricotdin-test")


def test_presigned_put_binds_bucket_key_and_content_type() -> None:
    client = r2_client(CFG)
    key = f"{U}/{uuid.uuid4()}.webm"
    url = presign_put(client, CFG.bucket, key, content_type="audio/webm", expires_in=900)
    parts = urlsplit(url)
    assert parts.scheme == "https"
    assert parts.netloc == "acct123.r2.cloudflarestorage.com"
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
