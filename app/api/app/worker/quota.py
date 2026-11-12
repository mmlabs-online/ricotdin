"""Quota helpers for the pipeline (ARC-08, QUO-02/04). Pure.

Dedup keys are per **job** (owner decision 2026-11-02): ``gen:<job_id>:reserve|settle|refund``.
v1 used the meeting id, so a requeue / reprocess was never charged again. Every process or
requeue inserts a new job row, so each run is charged once and the retries and restarts of one
job stay idempotent (``already_applied``).

The worker moves quota only through the SECURITY DEFINER wrappers of migration 0005
(``pipeline_reserve`` / ``pipeline_refund`` / ``pipeline_settle``): the user is the job's meeting
owner, refund and settle amounts come from the reserve ledger row, never from ``jobs.payload``.
These builders name the keys the wrappers use."""

import math
import uuid


def reserve_key(job_id: uuid.UUID) -> str:
    return f"gen:{job_id}:reserve"


def settle_key(job_id: uuid.UUID) -> str:
    return f"gen:{job_id}:settle"


def refund_key(job_id: uuid.UUID) -> str:
    return f"gen:{job_id}:refund"


def estimate_seconds(probed: float, fallback: int | None) -> int:
    """Whole seconds to reserve: the probed duration rounded up, else the client-measured one."""
    if math.isfinite(probed) and probed > 0:
        return math.ceil(probed)
    return max(0, fallback or 0)


def settle_delta(estimate: int, actual_seconds: float) -> int:
    """Wallet delta at settle: refund (> 0) or extra charge (< 0). Quota columns are bigint."""
    return estimate - math.ceil(actual_seconds)
