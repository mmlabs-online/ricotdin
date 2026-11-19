"""ARC-07: generation-model allow-list for /profile/preferences (legacy lib/ai/config + registry,
route-local labels; cases from legacy/tests/aip-control-plane.test.ts)."""

from typing import Any

from app.domain.models import (
    FALLBACK_ALLOWED,
    REGISTERED,
    SELECTABLE,
    allowed_models,
    current_pick,
    is_model_allowed,
    lock_is_valid,
    model_label,
    resolve_generation_model,
    system_default,
)

SEED = [
    {"provider": "gemini", "model": "gemini-2.5-flash"},
    {"provider": "openai", "model": "gpt-4o"},
    {"provider": "openai", "model": "gpt-4o-mini"},
]


def test_registry_has_the_v1_models() -> None:
    assert ("gemini", "gemini-2.5-flash") in REGISTERED
    assert ("openai", "gpt-4o") in REGISTERED
    assert ("openai", "gpt-4o-mini") in REGISTERED
    assert ("grok", "grok-4") in REGISTERED
    assert ("grok", "grok-3-mini") in REGISTERED


def test_allowed_models_from_config() -> None:
    assert allowed_models(SEED) == [
        ("gemini", "gemini-3.8-flash"),  # the seeded retired model reads as its replacement
        ("openai", "gpt-4o"),
        ("openai", "gpt-4o-mini"),
    ]


def test_allowed_models_drops_unregistered_and_malformed() -> None:
    raw: Any = [
        {"provider": "openai", "model": "gpt-9"},
        {"provider": "gemini"},
        "gemini:gemini-2.5-flash",
        {"provider": "grok", "model": "grok-4", "extra": 1},
    ]
    assert allowed_models(raw) == [("grok", "grok-4")]


def test_allowed_models_falls_back_when_not_a_list() -> None:
    assert allowed_models(None) == FALLBACK_ALLOWED
    assert allowed_models({"a": 1}) == FALLBACK_ALLOWED
    assert FALLBACK_ALLOWED == [("gemini", "gemini-3.8-flash")]


def test_is_model_allowed() -> None:
    allowed = allowed_models(SEED)
    assert is_model_allowed("openai", "gpt-4o", allowed)
    assert not is_model_allowed("grok", "grok-4", allowed)  # registered but not allowed
    assert not is_model_allowed("openai", "gpt-4o", [])
    assert not is_model_allowed("nope", "x", allowed)


def test_model_label() -> None:
    assert model_label("gemini", "gemini-2.5-flash") == "Gemini — gemini-2.5-flash"
    assert model_label("openai", "gpt-4o") == "OpenAI — GPT-4o"
    assert model_label("openai", "gpt-4o-mini") == "OpenAI — GPT-4o mini"
    assert model_label("grok", "grok-4") == "Grok — grok-4"
    assert model_label("openai", "gpt-5") == "openai — gpt-5"


# --- ARC-08d: regenerate is charged like one generation (owner decision 2026-11-03) ---------------


def test_regenerate_charge_is_the_transcribed_length() -> None:
    from app.domain.models import regenerate_charge_seconds

    assert regenerate_charge_seconds(2600, None) == 3  # ceil, like the transcription settle
    assert regenerate_charge_seconds(60_000, 75) == 60  # the transcript wins
    assert regenerate_charge_seconds(None, 75) == 75  # fallback: the recorded length
    assert regenerate_charge_seconds(0, 0) == 1  # never free
    assert regenerate_charge_seconds(None, None) == 1
    assert regenerate_charge_seconds(10**12, None) == 86_400  # quota wrapper bound


def test_bug_023_a_lock_on_a_model_no_longer_allowed_is_not_valid() -> None:
    # The admin switched to Gemini and stopped allowing GPT: a meeting locked to GPT must not
    # keep calling OpenAI (NoUsableKeys openai on every reprocess, regenerate and chat).
    gemini = ("gemini", "gemini-3.8-flash")
    allowed = [gemini]
    assert lock_is_valid(("openai", "gpt-4o"), allowed, gemini) is False
    assert lock_is_valid(gemini, allowed, gemini) is True


def test_bug_023_an_allowed_lock_or_the_system_default_stays() -> None:
    gemini = ("gemini", "gemini-3.8-flash")
    gpt = ("openai", "gpt-4o")
    assert lock_is_valid(gpt, [gemini, gpt], gemini) is True  # still allowed: unchanged
    assert lock_is_valid(gemini, [gpt], gemini) is True  # the system default is always usable
    assert (
        lock_is_valid(("openai", "not-registered"), [("openai", "not-registered")], gemini) is False
    )


def test_bug_024_a_retired_model_is_not_offered() -> None:
    assert ("gemini", "gemini-2.5-flash") not in SELECTABLE
    assert ("gemini", "gemini-3.8-flash") in SELECTABLE
    assert current_pick(("gemini", "gemini-2.5-flash")) == ("gemini", "gemini-3.8-flash")
    assert current_pick(("openai", "gpt-4o")) == ("openai", "gpt-4o")


def test_bug_024_stored_settings_read_the_retired_model_as_its_replacement() -> None:
    seeded = [{"provider": "gemini", "model": "gemini-2.5-flash"},
              {"provider": "gemini", "model": "gemini-3.8-flash"},
              {"provider": "openai", "model": "gpt-4o"}]  # fmt: skip
    assert allowed_models(seeded) == [("gemini", "gemini-3.8-flash"), ("openai", "gpt-4o")]
    assert system_default({"provider": "gemini", "model": "gemini-2.5-flash"}) == (
        "gemini", "gemini-3.8-flash",
    )  # fmt: skip


def test_bug_024_a_retired_preference_still_counts_as_its_replacement() -> None:
    gemini, gpt = ("gemini", "gemini-3.8-flash"), ("openai", "gpt-4o")
    retired = ("gemini", "gemini-2.5-flash")
    # a profile default or an upload pick stored as 2.5 is the user's choice of 3.8, not "none"
    assert resolve_generation_model([gemini, gpt], gpt, retired, None) == gemini
    assert resolve_generation_model([gemini, gpt], gpt, None, retired) == gemini


def test_bug_024_a_meeting_locked_to_the_retired_model_keeps_its_lock() -> None:
    # 2.5 is the old default, so most meetings hold it: it means 3.8, it must not be re-resolved
    # to another provider (e.g. the user's GPT default) just because the settings now read as 3.8.
    gemini, gpt = ("gemini", "gemini-3.8-flash"), ("openai", "gpt-4o")
    assert lock_is_valid(("gemini", "gemini-2.5-flash"), [gemini, gpt], gpt) is True
    assert lock_is_valid(("gemini", "gemini-2.5-flash"), [gpt], gemini) is True
