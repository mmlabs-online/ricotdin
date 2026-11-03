"""ARC-10c pure admin-config rules. Ports of v1 ``tests/provider-keys.test.ts``
(``isLastActiveKey``), ``tests/admin-config.test.ts`` (``isValidConfigValue``), the generation
config checks of ``/api/admin/generation-config``, ``tests/features*.test.ts`` (create / update
bodies) and ``tests/admin-health.test.ts`` (``buildHealthReport``), plus the v2 bounds."""

from typing import Any

import pytest

from app.core.errors import BadRequest, UnprocessableEntity
from app.domain.admin_config import (
    KEY_CONFIG_KEYS,
    MAX_KEY_CHARS,
    build_health_report,
    guard_last_active_key,
    parse_config_value,
    parse_feature_create,
    parse_feature_update,
    parse_generation_config,
    parse_key_status,
    parse_new_key,
)


def _invalid(fn: Any, *args: Any) -> str:
    with pytest.raises((UnprocessableEntity, BadRequest)) as err:
        fn(*args)
    return err.value.public_message


# --- provider keys ---------------------------------------------------------------------------------


def test_key_config_keys_follow_the_catalog() -> None:
    assert {"gemini_api_key", "openai_api_key", "grok_api_key",
            "speechmatics_api_key"} <= set(KEY_CONFIG_KEYS)  # fmt: skip


def test_parse_new_key() -> None:
    k = parse_new_key(
        {"configKey": "openai_api_key", "label": " main ", "key": " sk-abcdefgh1234 "}
    )
    assert (k.config_key, k.label, k.key, k.last4) == (
        "openai_api_key", "main", "sk-abcdefgh1234", "1234",
    )  # fmt: skip
    base = {"configKey": "openai_api_key", "label": "x", "key": "sk-abcdefgh"}
    assert _invalid(parse_new_key, {**base, "configKey": "aws_key"}).startswith("configKey must be")
    assert _invalid(parse_new_key, {**base, "label": " "}) == "label is required."
    assert _invalid(parse_new_key, {**base, "label": "l" * 81}) == (
        "label must be 80 chars or fewer."
    )
    assert _invalid(parse_new_key, {**base, "key": ""}) == "key is required."
    assert _invalid(parse_new_key, {**base, "key": "short"}) == (
        "key is too short (minimum 8 characters)."
    )
    # v2: a key travels in an HTTP header — no whitespace / control characters, bounded size
    assert _invalid(parse_new_key, {**base, "key": "sk-abc def"}) == (
        "key must not contain spaces or control characters."
    )
    assert _invalid(parse_new_key, {**base, "key": "k" * (MAX_KEY_CHARS + 1)}).startswith("key is")


def test_parse_key_status() -> None:
    assert parse_key_status({"status": "disabled", "disabled_reason": " leaked "}) == (
        "disabled", "leaked",
    )  # fmt: skip
    assert parse_key_status({"status": "active", "disabled_reason": "x"}) == ("active", None)
    assert parse_key_status({"status": "disabled", "disabled_reason": "r" * 999})[1] == "r" * 200
    assert _invalid(parse_key_status, {"status": "on"}) == 'status must be "active" or "disabled".'


def test_last_active_key_guard() -> None:
    guard_last_active_key("disable", "gemini_api_key", 2)
    for action, verb in (("disable", "disable"), ("delete", "delete")):
        msg = _invalid(guard_last_active_key, action, "gemini_api_key", 1)
        assert msg.startswith(f'Cannot {verb} the last active key for "gemini_api_key".')


# --- app_config ---------------------------------------------------------------------------------------


def test_config_values() -> None:
    assert parse_config_value("anything", {"value": True}) is True
    assert parse_config_value("anything", {"value": None}) is None
    assert parse_config_value("anything", {"value": "x"}) == "x"
    assert _invalid(parse_config_value, "k", {}) == 'Request body must include a "value" field.'
    assert _invalid(parse_config_value, "k", {"value": [1]}).startswith("value must be a JSON")
    assert _invalid(parse_config_value, "k", {"value": "s" * 2001}).startswith("value is too long")
    for bad in (float("nan"), float("inf")):  # json.loads accepts NaN / Infinity / 1e400
        assert _invalid(parse_config_value, "k", {"value": bad}) == "value must be a finite number."
    # known keys are typed (v2): a wrong type would silently turn a feature off / on
    assert parse_config_value("storage.audio_retention_days", {"value": 30}) == 30
    assert parse_config_value("storage.audio_retention_days", {"value": None}) is None
    for wrong in (0, 3651, 1.5, "30", True):
        assert _invalid(
            parse_config_value, "storage.audio_retention_days", {"value": wrong}
        ).startswith("storage.audio_retention_days must be")
    assert parse_config_value("user_hack_audio_render", {"value": False}) is False
    assert _invalid(parse_config_value, "user_hack_audio_render", {"value": "true"}).startswith(
        "user_hack_audio_render must be"
    )


# --- generation config --------------------------------------------------------------------------------

REGISTERED = [("gemini", "gemini-2.5-flash"), ("openai", "gpt-4o")]


def test_generation_config() -> None:
    allowed, default = parse_generation_config(
        {"allowedModels": [{"provider": "openai", "model": "gpt-4o"}],
         "systemDefault": {"provider": "openai", "model": "gpt-4o"}},
        REGISTERED, current_allowed=[("gemini", "gemini-2.5-flash")],
    )  # fmt: skip
    assert allowed == [("openai", "gpt-4o")] and default == ("openai", "gpt-4o")
    # only the default: checked against the current allow-list
    allowed, default = parse_generation_config(
        {"systemDefault": {"provider": "gemini", "model": "gemini-2.5-flash"}}, REGISTERED,
        current_allowed=[("gemini", "gemini-2.5-flash")],
    )  # fmt: skip
    assert allowed is None and default == ("gemini", "gemini-2.5-flash")
    cur = [("gemini", "gemini-2.5-flash")]
    assert _invalid(parse_generation_config, {"allowedModels": []}, REGISTERED, cur) == (
        "allowedModels must be a non-empty array."
    )
    assert _invalid(parse_generation_config, {"allowedModels": [{"provider": "x"}]}, REGISTERED,
                    cur) == "Each entry in allowedModels must have provider and model."  # fmt: skip
    assert _invalid(parse_generation_config,
                    {"allowedModels": [{"provider": "grok", "model": "grok-9"}]}, REGISTERED,
                    cur) == "grok:grok-9 is not in the provider registry."  # fmt: skip
    assert _invalid(parse_generation_config,
                    {"systemDefault": {"provider": "openai", "model": "gpt-4o"}}, REGISTERED,
                    cur).startswith("systemDefault (openai:gpt-4o) must be in the allow-list")  # fmt: skip
    assert _invalid(parse_generation_config, {}, REGISTERED, cur) == "Nothing to update."


# --- features ------------------------------------------------------------------------------------------


def test_feature_create() -> None:
    f = parse_feature_create({"key": " arc-99 ", "module_prefix": "arc", "module_name": "Arch",
                              "title": "T", "note_tags": ["a", 3], "priority": "high"})  # fmt: skip
    assert (f["key"], f["module_prefix"], f["status"], f["priority"]) == (
        "ARC-99", "ARC", "not_started", "high",
    )  # fmt: skip
    assert f["note_tags"] == ["a"] and f["depends_on"] == []  # non-strings dropped
    base = {"key": "ARC-1", "module_prefix": "ARC", "module_name": "A", "title": "T"}
    for missing in ("key", "module_prefix", "module_name", "title"):
        assert _invalid(parse_feature_create, {**base, missing: ""}) == f"{missing} is required."
    assert _invalid(parse_feature_create, {**base, "status": "wip"}) == (
        "status must be done, partial, or not_started."
    )
    assert _invalid(parse_feature_create, {**base, "priority": "urgent"}) == (
        "priority must be high, medium, low, or null."
    )
    assert _invalid(parse_feature_create, {**base, "key": "ARC 1; DROP"}).startswith("key must")


def test_feature_update() -> None:
    fields = parse_feature_update(
        {"status": "done", "title": "New", "ignored": 1, "blocks": ["X-1"]}
    )
    assert fields == {"status": "done", "title": "New", "blocks": ["X-1"]}
    assert _invalid(parse_feature_update, {"ignored": 1}) == "No editable fields provided."
    assert _invalid(parse_feature_update, {"status": "x"}).startswith("status must be")
    assert _invalid(parse_feature_update, {"title": ""}) == "title must not be empty."
    assert _invalid(parse_feature_update, {"content": "c" * 200_001}).startswith(
        "content is too long"
    )
    assert parse_feature_update({"priority": None}) == {"priority": None}
    assert _invalid(parse_feature_update, {"note_tags": "a,b"}) == (
        "note_tags must be a list of strings."
    )  # never silently wiped
    assert parse_feature_update({"note_tags": None}) == {"note_tags": []}


# --- health -----------------------------------------------------------------------------------------


def test_health_report() -> None:
    ok = build_health_report({"database": {"status": "ok"}, "storage": {"status": "ok"}}, "t")
    assert ok == {"status": "ok", "ts": "t", "checks": {"database": {"status": "ok"},
                                                        "storage": {"status": "ok"}}}  # fmt: skip
    bad = build_health_report({"database": {"status": "ok"},
                               "storage": {"status": "error", "message": "x"}}, "t")  # fmt: skip
    assert bad["status"] == "degraded"
