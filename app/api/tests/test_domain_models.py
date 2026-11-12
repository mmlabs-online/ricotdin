"""ARC-07: generation-model allow-list for /profile/preferences (legacy lib/ai/config + registry,
route-local labels; cases from legacy/tests/aip-control-plane.test.ts)."""

from typing import Any

from app.domain.models import (
    FALLBACK_ALLOWED,
    REGISTERED,
    allowed_models,
    is_model_allowed,
    model_label,
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
        ("gemini", "gemini-2.5-flash"),
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
    assert FALLBACK_ALLOWED == [("gemini", "gemini-2.5-flash")]


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
