"""ARC-04: token-bucket rate limiter (pure; the clock is injected). Used by ARC-05 for login."""

from app.core.ratelimit import RateLimiter


def test_allows_up_to_capacity_then_blocks_with_retry_after() -> None:
    rl = RateLimiter(capacity=3, refill_per_second=1.0)
    assert [rl.check("k", now=0.0).allowed for _ in range(3)] == [True, True, True]
    blocked = rl.check("k", now=0.0)
    assert not blocked.allowed
    assert blocked.retry_after_seconds == 1


def test_tokens_refill_over_time() -> None:
    rl = RateLimiter(capacity=2, refill_per_second=0.5)
    rl.check("k", now=0.0)
    rl.check("k", now=0.0)
    assert not rl.check("k", now=1.0).allowed  # 0.5 token
    assert rl.check("k", now=2.0).allowed  # 1 token


def test_keys_are_independent() -> None:
    rl = RateLimiter(capacity=1, refill_per_second=0.1)
    assert rl.check("a", now=0.0).allowed
    assert rl.check("b", now=0.0).allowed
    assert not rl.check("a", now=0.0).allowed


def test_bucket_never_exceeds_capacity_after_a_long_idle() -> None:
    rl = RateLimiter(capacity=2, refill_per_second=1.0)
    rl.check("k", now=0.0)
    assert [rl.check("k", now=1000.0).allowed for _ in range(3)] == [True, True, False]


def test_idle_buckets_are_pruned() -> None:
    rl = RateLimiter(capacity=1, refill_per_second=1.0, max_keys=2)
    for i in range(5):
        rl.check(f"k{i}", now=float(i))
    assert len(rl) <= 2
