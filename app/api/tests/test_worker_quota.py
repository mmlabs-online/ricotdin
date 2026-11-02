"""ARC-08 worker: quota helpers (QUO-02/04).

Owner decision 2026-11-02: dedup keys are per *job* (``gen:<job_id>:reserve|settle|refund``).
v1 keyed them by meeting (``gen:<meeting_id>:…``), so a requeue or reprocess of the same meeting
was never charged again (the reserve answered ``already_applied``). A new job row is created per
process / requeue, so each run is charged once and retries of the same job stay idempotent."""

import math
import uuid

import pytest

from app.worker.quota import (
    estimate_seconds,
    refund_due,
    refund_key,
    reserve_key,
    settle_delta,
    settle_key,
)

JOB = uuid.UUID("11111111-2222-3333-4444-555555555555")


def test_dedup_keys_are_per_job() -> None:
    assert reserve_key(JOB) == f"gen:{JOB}:reserve"
    assert settle_key(JOB) == f"gen:{JOB}:settle"
    assert refund_key(JOB) == f"gen:{JOB}:refund"
    assert reserve_key(uuid.uuid4()) != reserve_key(JOB)


@pytest.mark.parametrize(
    ("probed", "fallback", "expected"),
    [
        (79.52, None, 80),
        (60.0, 999, 60),
        (0.0, 42, 42),  # bare WebM without a duration header: client-measured duration
        (0.0, None, 0),
        (-5.0, 10, 10),
        (math.nan, 7, 7),
        (math.inf, 7, 7),
        (0.0, -3, 0),
        (0.001, None, 1),
    ],
)
def test_estimate_seconds(probed: float, fallback: int | None, expected: int) -> None:
    assert estimate_seconds(probed, fallback) == expected


@pytest.mark.parametrize(
    ("estimate", "actual", "delta"), [(80, 79.52, 0), (100, 60.1, 39), (60, 75.0, -15)]
)
def test_settle_delta_refunds_or_charges_the_difference(
    estimate: int, actual: float, delta: int
) -> None:
    assert settle_delta(estimate, actual) == delta


def test_refund_due_only_for_a_reserve_that_was_never_settled() -> None:
    user = str(uuid.uuid4())
    base = {"reserve_done": True, "estimate_seconds": 90, "user_id": user}
    assert refund_due(base) == (uuid.UUID(user), 90)
    assert refund_due({**base, "transcription_settled": True}) is None
    assert refund_due({**base, "reserve_done": False}) is None
    assert refund_due({**base, "estimate_seconds": 0}) is None
    assert refund_due({**base, "estimate_seconds": "90"}) is None
    assert refund_due({**base, "estimate_seconds": True}) is None
    assert refund_due({**base, "user_id": None}) is None
    assert refund_due({**base, "user_id": "not-a-uuid"}) is None
    assert refund_due({}) is None
