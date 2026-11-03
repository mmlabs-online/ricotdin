"""ARC-08c: provider/model catalog and the neutral JSON schema converters. Port of v1
``tests/ai-registry.test.ts``, ``aip-control-plane.test.ts`` (registry part) and the
``toOpenAIStrictSchema`` cases of ``ai-openai-adapter.test.ts``."""

from typing import Any

import pytest

from app.domain.models import REGISTERED, SYSTEM_DEFAULT, model_label
from app.services.ai.catalog import MODELS, PROVIDERS, UnknownModel, find_model
from app.services.ai.schema import to_gemini_schema, to_openai_strict_schema

# --- catalog ------------------------------------------------------------------------------------


def test_registered_models_come_from_the_catalog() -> None:
    assert REGISTERED == tuple((m.provider, m.model) for m in MODELS)
    assert set(REGISTERED) >= {
        ("gemini", "gemini-2.5-flash"), ("openai", "gpt-4o"), ("openai", "gpt-4o-mini"),
        ("grok", "grok-4"), ("grok", "grok-3-mini"),
    }  # fmt: skip
    assert SYSTEM_DEFAULT in REGISTERED


def test_every_model_has_a_known_provider_and_kind() -> None:
    for m in MODELS:
        assert m.provider in PROVIDERS
    for p in PROVIDERS.values():
        assert p.kind in {"gemini", "openai_compat"}
        assert p.base_url.startswith("https://") and not p.base_url.endswith("/")
    assert PROVIDERS["grok"].base_url == "https://api.x.ai/v1"
    assert PROVIDERS["openai"].base_url == "https://api.openai.com/v1"


def test_find_model() -> None:
    provider, model = find_model("grok", "grok-4")
    assert (provider.name, provider.kind, model.model) == ("grok", "openai_compat", "grok-4")
    with pytest.raises(UnknownModel, match="gemini:gemini-9"):
        find_model("gemini", "gemini-9")
    with pytest.raises(UnknownModel):
        find_model("nope", "gpt-4o")


def test_labels() -> None:
    assert model_label("gemini", "gemini-2.5-flash") == "Gemini — gemini-2.5-flash"
    assert model_label("openai", "gpt-4o") == "OpenAI — GPT-4o"
    assert model_label("openai", "gpt-4o-mini") == "OpenAI — GPT-4o mini"
    assert model_label("grok", "grok-4") == "Grok — grok-4"
    assert model_label("x", "y") == "x — y"


# --- schema: OpenAI strict ----------------------------------------------------------------------

LEAF = {"type": "string", "description": "d"}


def test_openai_primitives_and_description() -> None:
    assert to_openai_strict_schema({"type": "integer"}) == {"type": "integer"}
    assert to_openai_strict_schema(LEAF) == {"type": "string", "description": "d"}


def test_openai_nullable_becomes_any_of() -> None:
    got = to_openai_strict_schema({"type": "string", "nullable": True, "description": "d"})
    assert got == {"anyOf": [{"type": "string"}, {"type": "null"}], "description": "d"}
    assert to_openai_strict_schema({"type": "integer", "nullable": True})["anyOf"][0] == {
        "type": "integer"
    }
    assert "anyOf" not in to_openai_strict_schema({"type": "string"})


def test_openai_objects_are_closed_and_fully_required() -> None:
    node = {"type": "object", "properties": {"a": LEAF, "b": {"type": "integer"}}}
    got = to_openai_strict_schema(node)
    assert got["additionalProperties"] is False
    assert got["required"] == ["a", "b"]
    explicit = to_openai_strict_schema({**node, "required": ["a"]})
    assert explicit["required"] == ["a", "b"]  # strict mode: every property is required


def test_openai_nested_arrays_of_objects() -> None:
    node = {"type": "array", "items": {"type": "object", "properties": {"x": {"type": "string",
            "nullable": True}}}}  # fmt: skip
    got = to_openai_strict_schema(node)
    assert got["type"] == "array"
    assert got["items"]["additionalProperties"] is False
    assert got["items"]["properties"]["x"]["anyOf"][1] == {"type": "null"}


# --- schema: Gemini ------------------------------------------------------------------------------


def test_gemini_types_are_upper_case_and_nullable_kept() -> None:
    node: dict[str, Any] = {
        "type": "object",
        "properties": {"s": LEAF, "n": {"type": "integer", "nullable": True},
                       "l": {"type": "array", "items": {"type": "string"}}},
        "required": ["s", "n", "l"],
    }  # fmt: skip
    got = to_gemini_schema(node)
    assert got == {
        "type": "OBJECT",
        "properties": {"s": {"type": "STRING", "description": "d"},
                       "n": {"type": "INTEGER", "nullable": True},
                       "l": {"type": "ARRAY", "items": {"type": "STRING"}}},
        "required": ["s", "n", "l"],
    }  # fmt: skip


@pytest.mark.parametrize("bad", [None, 5, "x", {"type": 3}, {}])
def test_garbage_nodes_give_empty_schemas(bad: Any) -> None:
    assert to_openai_strict_schema(bad) == {}
    assert to_gemini_schema(bad) == {}


def test_a_new_catalog_provider_gets_an_env_key_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.ai import catalog
    from app.services.keys import source

    monkeypatch.setitem(
        catalog.PROVIDERS, "anthropic",
        catalog.ProviderInfo("anthropic", "anthropic", "https://api.anthropic.com/v1", "Claude"),
    )  # fmt: skip
    keys = source.env_keys("anthropic", {"ANTHROPIC_API_KEY": " sk-ant "})
    assert [k.key for k in keys] == ["sk-ant"]
    assert source.config_key_for("anthropic") == "anthropic_api_key"
    assert source.env_keys("unknown", {"UNKNOWN_API_KEY": "x"}) == []


def test_the_analysis_prompt_is_found_in_the_repository() -> None:
    from app.services.ai.prompts import load_prompt, prompt_path

    assert load_prompt().startswith("# Meeting Analysis")
    assert prompt_path(("no", "such.md")) is None
