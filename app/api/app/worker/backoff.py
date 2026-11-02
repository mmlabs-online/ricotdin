"""Retry backoff for transient job errors (ARC-08; port of v1 ``jitteredBackoff``). Pure.

2 s, 4 s, 8 s … capped at 5 min, then ±25 % jitter so retries of many jobs spread out."""

import random
from collections.abc import Callable

BASE_BACKOFF_S = 2.0
MAX_BACKOFF_S = 300.0
_MAX_EXPONENT = 30  # 2 s * 2**30 is far past the cap; avoids huge floats


def jittered_backoff(attempts: int, rand: Callable[[], float] = random.random) -> float:
    """Seconds to wait before retry number ``attempts`` (1 = first retry)."""
    exponent = min(max(attempts, 1) - 1, _MAX_EXPONENT)
    base: float = min(BASE_BACKOFF_S * float(2**exponent), MAX_BACKOFF_S)
    r = min(max(float(rand()), 0.0), 1.0)
    return base * (0.75 + r * 0.5)
