"""ARC-08 worker: jittered retry backoff (port of v1 ``jitteredBackoff``, legacy/lib/jobs/worker.ts).

2 s, 4 s, 8 s ... capped at 5 min, then ±25 % jitter from an injectable random source."""

import pytest

from app.worker.backoff import BASE_BACKOFF_S, MAX_BACKOFF_S, jittered_backoff


@pytest.mark.parametrize(("attempts", "expected"), [(1, 2.0), (2, 4.0), (3, 8.0), (8, 256.0)])
def test_doubles_from_two_seconds_without_jitter(attempts: int, expected: float) -> None:
    assert jittered_backoff(attempts, rand=lambda: 0.5) == pytest.approx(expected)


def test_is_capped_at_five_minutes() -> None:
    assert jittered_backoff(9, rand=lambda: 0.5) == pytest.approx(MAX_BACKOFF_S)
    assert jittered_backoff(10_000, rand=lambda: 0.5) == pytest.approx(MAX_BACKOFF_S)


def test_jitter_spans_plus_minus_25_percent() -> None:
    assert jittered_backoff(1, rand=lambda: 0.0) == pytest.approx(BASE_BACKOFF_S * 0.75)
    assert jittered_backoff(1, rand=lambda: 1.0) == pytest.approx(BASE_BACKOFF_S * 1.25)
    assert jittered_backoff(50, rand=lambda: 1.0) == pytest.approx(MAX_BACKOFF_S * 1.25)


@pytest.mark.parametrize("attempts", [0, -3])
def test_attempts_below_one_count_as_the_first_retry(attempts: int) -> None:
    assert jittered_backoff(attempts, rand=lambda: 0.5) == pytest.approx(BASE_BACKOFF_S)


def test_out_of_range_random_values_are_clamped() -> None:
    assert jittered_backoff(1, rand=lambda: 7.0) == pytest.approx(BASE_BACKOFF_S * 1.25)
    assert jittered_backoff(1, rand=lambda: -1.0) == pytest.approx(BASE_BACKOFF_S * 0.75)


def test_default_random_source_stays_in_range() -> None:
    for _ in range(200):
        assert BASE_BACKOFF_S * 0.75 <= jittered_backoff(1) <= BASE_BACKOFF_S * 1.25
