"""In-process token-bucket rate limiter (ARC-04). Pure: the caller passes ``now``.

Pass a monotonic clock (``time.monotonic()``); a clock that goes backwards never drains tokens.
Memory is bounded by ``max_keys``. When the table is full, only buckets that have refilled to
capacity are evicted (forgetting them changes nothing); if every bucket is still throttled, the
new key is refused — so spraying new keys can never hand a throttled key a fresh bucket.
Single process (one uvicorn per container), like v1's in-memory login limiter.
"""

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Decision:
    allowed: bool
    retry_after_seconds: int = 0


class RateLimiter:
    def __init__(self, capacity: int, refill_per_second: float, max_keys: int = 10_000) -> None:
        if capacity < 1 or refill_per_second <= 0 or max_keys < 1:
            raise ValueError("capacity >= 1, refill_per_second > 0 and max_keys >= 1 are required")
        self.capacity = capacity
        self.refill = refill_per_second
        self.max_keys = max_keys
        self._buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, ts)

    def __len__(self) -> int:
        return len(self._buckets)

    def __contains__(self, key: object) -> bool:
        return key in self._buckets

    def _tokens(self, key: str, now: float) -> float:
        tokens, last = self._buckets[key]
        return min(float(self.capacity), tokens + max(0.0, now - last) * self.refill)

    def _make_room(self, now: float) -> bool:
        full = [k for k in self._buckets if self._tokens(k, now) >= self.capacity]
        for k in full:
            del self._buckets[k]
        return len(self._buckets) < self.max_keys

    def check(self, key: str, *, now: float) -> Decision:
        if key not in self._buckets:
            if len(self._buckets) >= self.max_keys and not self._make_room(now):
                return Decision(False, retry_after_seconds=max(1, math.ceil(1.0 / self.refill)))
            self._buckets[key] = (float(self.capacity), now)
        tokens = self._tokens(key, now)
        last = max(now, self._buckets[key][1])
        if tokens >= 1.0:
            self._buckets[key] = (tokens - 1.0, last)
            return Decision(True)
        self._buckets[key] = (tokens, last)
        return Decision(False, retry_after_seconds=max(1, math.ceil((1.0 - tokens) / self.refill)))
