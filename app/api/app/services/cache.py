"""Tiny per-process TTL cache (ARC-06): the 30 s caches of v1 keys / config / storage. Pure.

Pass a monotonic clock. ``get`` returns ``(hit, value)`` so a cached ``None`` (e.g. "no storage
configured") is a hit, like v1.
"""

import time
from collections.abc import Callable, Hashable


class TtlCache[K: Hashable, V]:
    def __init__(self, ttl_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl = ttl_seconds
        self._clock = clock
        self._items: dict[K, tuple[float, V]] = {}

    def get(self, key: K) -> tuple[bool, V | None]:
        item = self._items.get(key)
        if item is None or item[0] <= self._clock():
            self._items.pop(key, None)
            return False, None
        return True, item[1]

    def put(self, key: K, value: V) -> None:
        self._items[key] = (self._clock() + self.ttl, value)

    def invalidate(self, key: K | None = None) -> None:
        if key is None:
            self._items.clear()
        else:
            self._items.pop(key, None)
