"""In-process token-bucket rate limiter (ARC-04). Pure: the caller passes ``now``.

Single process (one `uvicorn` per container), like v1's in-memory login limiter; a shared store
is only needed once the API runs as several instances.
"""

import math
from collections import OrderedDict
from dataclasses import dataclass


@dataclass(frozen=True)
class Decision:
    allowed: bool
    retry_after_seconds: int = 0


class RateLimiter:
    def __init__(self, capacity: int, refill_per_second: float, max_keys: int = 10_000) -> None:
        if capacity < 1 or refill_per_second <= 0:
            raise ValueError("capacity must be >= 1 and refill_per_second > 0")
        self.capacity = capacity
        self.refill = refill_per_second
        self.max_keys = max_keys
        self._buckets: OrderedDict[str, tuple[float, float]] = OrderedDict()  # key -> (tokens, ts)

    def __len__(self) -> int:
        return len(self._buckets)

    def check(self, key: str, *, now: float) -> Decision:
        tokens, last = self._buckets.pop(key, (float(self.capacity), now))
        tokens = min(float(self.capacity), tokens + (now - last) * self.refill)
        if tokens >= 1.0:
            self._store(key, tokens - 1.0, now)
            return Decision(True)
        self._store(key, tokens, now)
        return Decision(False, retry_after_seconds=max(1, math.ceil((1.0 - tokens) / self.refill)))

    def _store(self, key: str, tokens: float, now: float) -> None:
        self._buckets[key] = (tokens, now)
        while len(self._buckets) > self.max_keys:
            self._buckets.popitem(last=False)  # least recently used
