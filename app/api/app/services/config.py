"""``app_config`` flags and settings (ARC-06; port of v1 ``lib/config/appConfig.ts`` and
``coerceConfigBool``). Server-only reader, pure coercion.

Values are cached 30 s per key (a flag flipped in the admin UI applies within 30 s; ARC-10 calls
``invalidate`` for immediate effect). A failed lookup or a malformed value returns the caller's
fallback — a bad value never turns a flag on.
"""

import re
from collections.abc import Callable
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.logging import get_logger
from app.services.cache import TtlCache

log = get_logger("config")
CACHE_TTL_S = 30.0


def coerce_config_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return {1: True, 0: False}.get(value, fallback)
    if isinstance(value, str):
        return {"true": True, "false": False}.get(value.strip().lower(), fallback)
    return fallback


def parse_int_setting(value: Any, *, minimum: int, maximum: int) -> int | None:
    """A whole number within bounds (JSON number or numeric string), else None (fails closed)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():  # v1: Number.isInteger(30.0)
        value = int(value)
    elif isinstance(value, str):
        text = value.strip()
        value = int(text) if re.fullmatch(r"[0-9]{1,18}", text, re.ASCII) else None
    if isinstance(value, int) and minimum <= value <= maximum:
        return value
    return None


class AppConfigReader:
    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        self._cache: TtlCache[str, Any] = (
            TtlCache(CACHE_TTL_S, clock) if clock else TtlCache(CACHE_TTL_S)
        )

    def invalidate(self, key: str | None = None) -> None:
        self._cache.invalidate(key)

    async def value(self, conn: AsyncConnection, key: str) -> Any:
        """Raw jsonb value, or None when the row is missing or the lookup fails."""
        hit, cached = self._cache.get(key)
        if hit:
            return cached
        try:
            async with conn.begin_nested():  # a failed read must not poison the caller's tx
                value = (
                    await conn.execute(
                        text("SELECT value FROM app_config WHERE key = :k"), {"k": key}
                    )
                ).scalar_one_or_none()
        except Exception as exc:  # noqa: BLE001 - fall back to the caller's default
            log.warning(
                "app_config lookup failed for %s (%s): using default", key, type(exc).__name__
            )
            value = None
        self._cache.put(key, value)
        return value

    async def flag(self, conn: AsyncConnection, key: str, fallback: bool) -> bool:
        return coerce_config_bool(await self.value(conn, key), fallback)
