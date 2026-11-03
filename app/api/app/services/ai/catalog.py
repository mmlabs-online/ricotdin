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


PROVIDERS: dict[str, ProviderInfo] = {
    p.name: p
    for p in (
        ProviderInfo(
            "gemini", "gemini", "https://generativelanguage.googleapis.com/v1beta", "Gemini"
        ),
        ProviderInfo("openai", "openai_compat", "https://api.openai.com/v1", "OpenAI"),
        ProviderInfo("grok", "openai_compat", "https://api.x.ai/v1", "Grok"),
    )
}

MODELS: tuple[ModelInfo, ...] = (
    ModelInfo("gemini", "gemini-2.5-flash", "Gemini — gemini-2.5-flash"),
    ModelInfo("openai", "gpt-4o", "OpenAI — GPT-4o"),
    ModelInfo("openai", "gpt-4o-mini", "OpenAI — GPT-4o mini"),
    ModelInfo("grok", "grok-4", "Grok — grok-4"),
    ModelInfo("grok", "grok-3-mini", "Grok — grok-3-mini"),
)


# Embeddings are pinned (the stored vectors and every query must use the same model): changing it
# means re-embedding every meeting, a migration of its own.
EMBEDDING = EmbeddingModel("gemini", "gemini-embedding-001", 768, "gemini-embedding")


def find_model(provider: str, model: str) -> tuple[ProviderInfo, ModelInfo]:
    for m in MODELS:
        if m.provider == provider and m.model == model and provider in PROVIDERS:
            return PROVIDERS[provider], m
    raise UnknownModel(f"unknown generation model {provider}:{model}")
