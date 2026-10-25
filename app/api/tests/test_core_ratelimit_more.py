"""ARC-04 review round 1: eviction must not hand a throttled key a fresh bucket, and a clock
that goes backwards must not drain tokens."""

from app.core.ratelimit import RateLimiter


def test_spraying_new_keys_does_not_reset_a_throttled_key() -> None:
    rl = RateLimiter(capacity=1, refill_per_second=0.001, max_keys=3)
    assert rl.check("victim", now=0.0).allowed
    assert not rl.check("victim", now=0.0).allowed
    for i in range(50):  # attacker fills the table with new keys
        rl.check(f"spray{i}", now=0.0)
    assert not rl.check("victim", now=0.0).allowed


def test_new_keys_are_refused_when_the_table_is_full_of_throttled_keys() -> None:
    rl = RateLimiter(capacity=1, refill_per_second=0.001, max_keys=2)
    rl.check("a", now=0.0)
    rl.check("b", now=0.0)
    assert not rl.check("c", now=0.0).allowed


def test_full_buckets_are_evicted_first() -> None:
    rl = RateLimiter(capacity=2, refill_per_second=1.0, max_keys=2)
    rl.check("idle", now=0.0)  # refills to full by t=10
    rl.check("busy", now=10.0)
    assert rl.check("new", now=10.0).allowed  # 'idle' (full again) is evicted, not 'busy'
    assert "busy" in rl and "idle" not in rl


def test_clock_going_backwards_does_not_drain_tokens() -> None:
    rl = RateLimiter(capacity=2, refill_per_second=1.0)
    assert rl.check("k", now=100.0).allowed
    assert rl.check("k", now=50.0).allowed  # 1 token left, no negative refill
