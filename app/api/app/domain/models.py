"""Generation models a user may pick (ARC-07; legacy lib/ai/registry + config, labels from the
v1 preferences route). Pure. The model list lives in ``app.services.ai.catalog`` (ARC-08c)."""

from typing import Any

from app.services.ai.catalog import MODELS

Pick = tuple[str, str]  # (provider, model)

REGISTERED: tuple[Pick, ...] = tuple((m.provider, m.model) for m in MODELS)
_LABELS = {(m.provider, m.model): m.label for m in MODELS}
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
    if (provider, model) in _LABELS:
        return _LABELS[(provider, model)]
    if provider == "gemini":
        return f"Gemini — {model}"
    if provider == "openai" and model == "gpt-4o":
        return "OpenAI — GPT-4o"
    if provider == "openai" and model == "gpt-4o-mini":
        return "OpenAI — GPT-4o mini"
    if provider == "grok":
        return f"Grok — {model}"
    return f"{provider} — {model}"


def parse_pick(raw: Any) -> Pick | None:
    """``{"provider": str, "model": str}`` → (provider, model); anything else → None."""
    if not isinstance(raw, dict):
        return None
    provider, model = raw.get("provider"), raw.get("model")
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return provider, model
    return None


def system_default(raw: Any) -> Pick:
    """``app_settings['generation.system_default']``; an unregistered value → the built-in."""
    pick = parse_pick(raw)
    return pick if pick is not None and pick in REGISTERED else SYSTEM_DEFAULT


def resolve_generation_model(
    allowed: list[Pick], default: Pick, user_pref: Pick | None, pick: Pick | None
) -> Pick:
    """v1 AIP-06 chain: the upload's pick, then the user's default (each only if allowed and
    registered), then the system default."""
    for candidate in (pick, user_pref):
        if candidate is not None and is_model_allowed(*candidate, allowed):
            return candidate
    return default
