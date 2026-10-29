"""Generation models a user may pick (ARC-07; legacy lib/ai/registry + config, labels from the
v1 preferences route). Pure. ARC-08 adds the adapters behind these names."""

from typing import Any

Pick = tuple[str, str]  # (provider, model)

REGISTERED: tuple[Pick, ...] = (
    ("gemini", "gemini-2.5-flash"),
    ("openai", "gpt-4o"),
    ("openai", "gpt-4o-mini"),
    ("grok", "grok-4"),
    ("grok", "grok-3-mini"),
)
SYSTEM_DEFAULT: Pick = ("gemini", "gemini-2.5-flash")
FALLBACK_ALLOWED: list[Pick] = [SYSTEM_DEFAULT]


def allowed_models(raw: Any) -> list[Pick]:
    """``app_settings['generation.allowed_models']`` → registered (provider, model) pairs.

    Not a list → the fallback list (v1). Malformed or unregistered entries are dropped.
    """
    if not isinstance(raw, list):
        return list(FALLBACK_ALLOWED)
    out: list[Pick] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        provider, model = item.get("provider"), item.get("model")
        if not isinstance(provider, str) or not isinstance(model, str):
            continue
        pick = (provider, model)
        if pick in REGISTERED and pick not in out:
            out.append(pick)
    return out


def is_model_allowed(provider: str, model: str, allowed: list[Pick]) -> bool:
    return (provider, model) in allowed and (provider, model) in REGISTERED


def model_label(provider: str, model: str) -> str:
    if provider == "gemini":
        return f"Gemini — {model}"
    if provider == "openai" and model == "gpt-4o":
        return "OpenAI — GPT-4o"
    if provider == "openai" and model == "gpt-4o-mini":
        return "OpenAI — GPT-4o mini"
    if provider == "grok":
        return f"Grok — {model}"
    return f"{provider} — {model}"
