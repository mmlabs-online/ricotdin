"""Active provider keys (ARC-06; port of v1 ``lib/keys/provider.ts``). Server-only.

Active ``admin_config`` rows of the provider's config_key, decrypted, oldest first, cached 30 s
per provider; when the database has none (or none decrypts), the environment fallback is used.
Run inside ``db.role_transaction('ricotdin_service' | 'ricotdin_worker')``. Plaintext keys exist
only in memory; a row that fails to decrypt is logged by id only.
"""

import hashlib
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger
from app.services.ai.catalog import PROVIDERS
from app.services.cache import TtlCache
from app.services.crypto import DecryptError, EncryptedSecret, decrypt_with_key, encrypt_with_key
from app.services.keys.pool import KeyWithMeta

log = get_logger("keys")

CACHE_TTL_S = 30.0
FALLBACK_ENV_NAMES = frozenset(
    {"GEMINI_API_KEYS", "GEMINI_API_KEY", "SPEECHMATICS_API_KEY", "OPENAI_API_KEY", "GROK_API_KEY",
     "XAI_API_KEY"}
    | {f"GEMINI_API_KEY_{i}" for i in range(1, 21)}
    | {f"{name.upper()}_API_KEY" for name in PROVIDERS}
)  # fmt: skip
FAILURE_TTL_S = 5.0  # after a failed lookup, retry the database soon
# A key a provider rejected (401, out of credits) is skipped this long, then tried again: the
# worker never sees the API's invalidate() after an admin re-enables or tops up a key (ARC-10).
INVALID_TTL_S = 3600.0
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
    elif provider in PROVIDERS:  # any later catalog provider: <NAME>_API_KEY (ARC-08c)
        push(env.get(f"{provider.upper()}_API_KEY"))
    return out


@dataclass(frozen=True)
class StoredKey:
    id: str
    config_key: str
    key: str | None = field(repr=False)


class KeySource:
    def __init__(
        self,
        master_key: bytes | None,
        env: Mapping[str, str],
        *,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._master = master_key
        # Only the provider fallback variables: never hold DATABASE_URL, JWT keys, ... here.
        self._env = {k: v for k, v in env.items() if k in FALLBACK_ENV_NAMES}
        self._cache: TtlCache[str, list[KeyWithMeta]] = (
            TtlCache(CACHE_TTL_S, clock) if clock else TtlCache(CACHE_TTL_S)
        )
        self._failed: TtlCache[str, list[KeyWithMeta]] = (
            TtlCache(FAILURE_TTL_S, clock) if clock else TtlCache(FAILURE_TTL_S)
        )
        # sha-256 of keys a provider rejected (401) → when they may be tried again
        self._invalid: dict[str, float] = {}
        self._now: Callable[[], float] = clock or time.monotonic

    @property
    def has_master(self) -> bool:
        return self._master is not None

    def encrypt(self, plaintext: str) -> EncryptedSecret | None:
        """A new key encrypted with ``KEY_ENCRYPTION_SECRET`` (ARC-10 admin keys); None when
        the secret is not set (the caller answers 503)."""
        return encrypt_with_key(plaintext, self._master) if self._master is not None else None

    @property
    def env_names(self) -> list[str]:
        return sorted(self._env)

    @staticmethod
    def _fingerprint(key: KeyWithMeta) -> str:
        return hashlib.sha256(key.key.encode()).hexdigest()

    def mark_invalid(self, key: KeyWithMeta) -> None:
        """Pass as ``KeyPool(on_invalid_key=...)``: a key rejected with 401 is skipped by every
        later pool of this process until ``invalidate()`` runs (an admin key change in this
        process) or for ``INVALID_TTL_S`` (the worker never sees the API's invalidate)."""
        self._invalid[self._fingerprint(key)] = self._now() + INVALID_TTL_S

    def usable(self, keys: list[KeyWithMeta]) -> list[KeyWithMeta]:
        now = self._now()
        return [k for k in keys if self._invalid.get(self._fingerprint(k), 0.0) <= now]

    def __repr__(self) -> str:
        return "KeySource()"

    def invalidate(self, provider: str | None = None) -> None:
        """Call after a key is added, enabled, disabled or deleted (ARC-10). Also forgets keys
        rejected with 401, so an admin can bring a re-enabled or re-added key back."""
        name = config_key_for(provider) if provider else None
        self._cache.invalidate(name)
        self._failed.invalidate(name)
        self._invalid.clear()

    async def active_keys(self, conn: AsyncConnection, provider: str) -> list[KeyWithMeta]:
        config_key = config_key_for(provider)
        for cache in (self._cache, self._failed):
            hit, cached = cache.get(config_key)
            if hit and cached is not None:
                return self.usable(cached)
        try:
            async with conn.begin_nested():  # a failed read must not abort the caller's tx
                loaded = await self._load(conn, config_key)
        except Exception as exc:  # noqa: BLE001 - v1: a DB failure falls back to env keys
            log.error("admin_config lookup failed for %s (%s)", config_key, type(exc).__name__)
            fallback = env_keys(provider, self._env)
            self._failed.put(config_key, fallback)
            return self.usable(fallback)
        keys = loaded or env_keys(provider, self._env)
        self._cache.put(config_key, keys)
        return self.usable(keys)

    async def stored_keys(self, conn: AsyncConnection) -> list["StoredKey"]:
        """Every provider key row (active and disabled) for the health check (ARC-08e); ``key``
        is None when it does not decrypt. Not cached; never logged."""
        rows = (
            await conn.execute(
                text(
                    "SELECT id, config_key, value_ciphertext, value_iv, value_auth_tag "
                    "FROM admin_config WHERE config_key LIKE '%\\_api\\_key' ORDER BY created_at"
                )
            )
        ).all()
        out: list[StoredKey] = []
        for row in rows:
            plain: str | None = None
            if self._master is not None:
                try:
                    plain = decrypt_with_key(
                        EncryptedSecret(row.value_ciphertext, row.value_iv, row.value_auth_tag),
                        self._master,
                    )
                except DecryptError:
                    plain = None
            out.append(StoredKey(str(row.id), row.config_key, plain))
        return out

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
