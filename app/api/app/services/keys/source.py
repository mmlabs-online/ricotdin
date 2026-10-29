"""Active provider keys (ARC-06; port of v1 ``lib/keys/provider.ts``). Server-only.

Active ``admin_config`` rows of the provider's config_key, decrypted, oldest first, cached 30 s
per provider; when the database has none (or none decrypts), the environment fallback is used.
Run inside ``db.role_transaction('ricotdin_service' | 'ricotdin_worker')``. Plaintext keys exist
only in memory; a row that fails to decrypt is logged by id only.
"""

from collections.abc import Callable, Mapping

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger
from app.services.cache import TtlCache
from app.services.crypto import DecryptError, EncryptedSecret, decrypt_with_key
from app.services.keys.pool import KeyWithMeta

log = get_logger("keys")

CACHE_TTL_S = 30.0
_CONFIG_KEYS = {
    "gemini": "gemini_api_key",
    "speechmatics": "speechmatics_api_key",
    "openai": "openai_api_key",
    "grok": "grok_api_key",
}


def config_key_for(provider: str) -> str:
    return _CONFIG_KEYS.get(provider, f"{provider}_api_key")


def env_keys(provider: str, env: Mapping[str, str]) -> list[KeyWithMeta]:
    """v1 fallback order. Gemini: GEMINI_API_KEYS (csv), GEMINI_API_KEY_1..20, GEMINI_API_KEY."""
    out: list[KeyWithMeta] = []
    seen: set[str] = set()

    def push(raw: str | None) -> None:
        value = (raw or "").strip()
        if value and value not in seen:
            seen.add(value)
            out.append(KeyWithMeta(None, value))

    if provider == "gemini":
        for part in (env.get("GEMINI_API_KEYS") or "").split(","):
            push(part)
        for i in range(1, 21):
            push(env.get(f"GEMINI_API_KEY_{i}"))
        push(env.get("GEMINI_API_KEY"))
    elif provider == "speechmatics":
        push(env.get("SPEECHMATICS_API_KEY"))
    elif provider == "openai":
        push(env.get("OPENAI_API_KEY"))
    elif provider == "grok":
        push((env.get("GROK_API_KEY") or "").strip() or env.get("XAI_API_KEY"))
    return out


class KeySource:
    def __init__(
        self,
        master_key: bytes | None,
        env: Mapping[str, str],
        *,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._master = master_key
        self._env = env
        self._cache: TtlCache[str, list[KeyWithMeta]] = (
            TtlCache(CACHE_TTL_S, clock) if clock else TtlCache(CACHE_TTL_S)
        )

    def __repr__(self) -> str:
        return "KeySource()"

    def invalidate(self, provider: str | None = None) -> None:
        """Call after a key is added, disabled or deleted (ARC-10)."""
        self._cache.invalidate(config_key_for(provider) if provider else None)

    async def active_keys(self, conn: AsyncConnection, provider: str) -> list[KeyWithMeta]:
        config_key = config_key_for(provider)
        hit, cached = self._cache.get(config_key)
        if hit and cached is not None:
            return cached
        keys = await self._load(conn, config_key) or env_keys(provider, self._env)
        self._cache.put(config_key, keys)
        return keys

    async def _load(self, conn: AsyncConnection, config_key: str) -> list[KeyWithMeta]:
        rows = (
            await conn.execute(
                text(
                    "SELECT id, value_ciphertext, value_iv, value_auth_tag FROM admin_config "
                    "WHERE config_key = :k AND status = 'active' ORDER BY created_at ASC"
                ),
                {"k": config_key},
            )
        ).all()
        if rows and self._master is None:
            log.error("KEY_ENCRYPTION_SECRET is not set: stored %s keys are unusable", config_key)
            return []
        out: list[KeyWithMeta] = []
        for row in rows:
            assert self._master is not None  # noqa: S101 - checked above
            try:
                plain = decrypt_with_key(
                    EncryptedSecret(row.value_ciphertext, row.value_iv, row.value_auth_tag),
                    self._master,
                )
            except DecryptError:
                log.error("admin_config row %s does not decrypt (%s)", row.id, config_key)
                continue
            out.append(KeyWithMeta(str(row.id), plain))
        return out
