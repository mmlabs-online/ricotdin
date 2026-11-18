"""Generation providers and models (ARC-08c; v1 ``lib/ai/registry.ts``). Pure data.

To add a model of an existing provider: one ``ModelInfo`` line. To add an OpenAI-compatible
provider (DeepSeek, Mistral, Kimi, …): one ``ProviderInfo`` with ``kind="openai_compat"`` plus its
models; keys come from ``admin_config`` (``<name>_api_key``) or ``<NAME>_API_KEY``. A provider with
its own API (e.g. Anthropic) also needs an adapter in ``adapters/`` and a ``kind`` in
``registry.ADAPTERS``. Allowing a model for users is an admin setting (``app_settings``).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderInfo:
    name: str  # also the key provider name (KeySource) and the usage_log provider
    kind: str  # which adapter speaks its API
    base_url: str
    label: str
    # Key health check (08e): when set, probe with a 1-token chat call on this model instead of
    # listing models (xAI keys usually lack the "list models" permission, v1 §9i).
    probe_model: str | None = None


@dataclass(frozen=True)
class ModelInfo:
    provider: str
    model: str
    label: str


@dataclass(frozen=True)
class EmbeddingModel:
    provider: str
    model: str
    dimensions: int  # must equal transcript_chunks.embedding vector(768) (CLAUDE.md §6)
    usage_provider: str  # usage_log.provider label (v1: 'gemini-embedding')


class UnknownModel(LookupError):
    pass


# The system default generation model (``domain.models.SYSTEM_DEFAULT``) and the model the Gemini
# key health check generates with (BUG-022).
GEMINI_DEFAULT = "gemini-3.8-flash"

PROVIDERS: dict[str, ProviderInfo] = {
    p.name: p
    for p in (
        ProviderInfo(
            "gemini",
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "Gemini",
            GEMINI_DEFAULT,
        ),  # fmt: skip
        ProviderInfo("openai", "openai_compat", "https://api.openai.com/v1", "OpenAI"),
        ProviderInfo("grok", "openai_compat", "https://api.x.ai/v1", "Grok", "grok-3-mini"),
        ProviderInfo("anthropic", "anthropic", "https://api.anthropic.com", "Anthropic"),
    )
}

MODELS: tuple[ModelInfo, ...] = (
    ModelInfo("gemini", GEMINI_DEFAULT, f"Gemini — {GEMINI_DEFAULT}"),
    ModelInfo("gemini", "gemini-2.5-flash", "Gemini — gemini-2.5-flash"),
    ModelInfo("openai", "gpt-4o", "OpenAI — GPT-4o"),
    ModelInfo("openai", "gpt-4o-mini", "OpenAI — GPT-4o mini"),
    ModelInfo("grok", "grok-4", "Grok — grok-4"),
    ModelInfo("grok", "grok-3-mini", "Grok — grok-3-mini"),
    ModelInfo("anthropic", "claude-opus-5-5", "Anthropic — Claude Opus 5.5"),
    ModelInfo("anthropic", "claude-sonnet-5-5", "Anthropic — Claude Sonnet 5.5"),
    ModelInfo("anthropic", "claude-haiku-5-5", "Anthropic — Claude Haiku 5.5"),
)


# Embeddings are pinned (the stored vectors and every query must use the same model): changing it
# means re-embedding every meeting, a migration of its own.
EMBEDDING = EmbeddingModel("gemini", "gemini-embedding-001", 768, "gemini-embedding")


# Models the provider no longer serves (to new projects), called as their replacement. They stay in
# MODELS because stored rows name them: meeting locks, profile defaults, app_settings (BUG-022:
# Google answers gemini-2.5-flash with 404 for new projects since 2026-09-18).
RETIRED: dict[tuple[str, str], str] = {("gemini", "gemini-2.5-flash"): GEMINI_DEFAULT}


def api_model(provider: str, model: str) -> str:
    """The model id sent to the provider for a stored (provider, model) pair."""
    return RETIRED.get((provider, model), model)


def find_model(provider: str, model: str) -> tuple[ProviderInfo, ModelInfo]:
    for m in MODELS:
        if m.provider == provider and m.model == model and provider in PROVIDERS:
            return PROVIDERS[provider], m
    raise UnknownModel(f"unknown generation model {provider}:{model}")
