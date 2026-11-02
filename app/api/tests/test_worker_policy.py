"""ARC-08 worker policy (pure): retry decisions, the per-job deadline, the steps a deployable
worker needs and the environment the worker container may hold (ARC-04 security review: only
``DATABASE_URL_WORKER``)."""

from datetime import UTC, datetime, timedelta

import pytest

from app.worker.policy import (
    JOB_MAX_AGE_S,
    REQUIRED_STEPS,
    STEP_TIMEOUT_S,
    STUCK_THRESHOLD_S,
    deadline_exceeded,
    missing_steps,
    retry_decision,
    worker_env_problems,
)

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


def test_step_timeout_is_below_the_stuck_threshold() -> None:
    # A live worker gives up on a step before the sweeper would requeue it under its feet.
    assert STEP_TIMEOUT_S < STUCK_THRESHOLD_S
    assert STUCK_THRESHOLD_S == 15 * 60  # v1 / ADM-04 dashboard threshold


@pytest.mark.parametrize(
    ("attempts", "max_attempts", "terminal", "retry"),
    [
        (0, 5, False, True),
        (3, 5, False, True),
        (4, 5, False, False),  # attempts + 1 == max → exhausted
        (9, 5, False, False),
        (0, 5, True, False),  # terminal: never retried
        (0, 1, False, False),
    ],
)
def test_retry_decision(attempts: int, max_attempts: int, terminal: bool, retry: bool) -> None:
    assert retry_decision(attempts, max_attempts, terminal=terminal) == (retry, attempts + 1)


def test_deadline_counts_from_the_pipeline_start() -> None:
    started = (NOW - timedelta(seconds=JOB_MAX_AGE_S + 1)).isoformat()
    assert deadline_exceeded({"started_at": started}, NOW)
    fresh = (NOW - timedelta(seconds=JOB_MAX_AGE_S - 60)).isoformat()
    assert not deadline_exceeded({"started_at": fresh}, NOW)


@pytest.mark.parametrize(
    "payload", [{}, {"started_at": None}, {"started_at": "garbage"}, {"started_at": 5}]
)
def test_without_a_valid_start_time_there_is_no_deadline(payload: dict[str, object]) -> None:
    # A job still waiting for its first `start` (e.g. the worker was down) is never expired.
    assert not deadline_exceeded(payload, NOW)


def test_naive_start_time_is_read_as_utc() -> None:
    naive = (NOW - timedelta(seconds=JOB_MAX_AGE_S + 5)).replace(tzinfo=None).isoformat()
    assert deadline_exceeded({"started_at": naive}, NOW)


def test_custom_max_age() -> None:
    started = (NOW - timedelta(seconds=11)).isoformat()
    assert deadline_exceeded({"started_at": started}, NOW, max_age_s=10)


def test_missing_steps() -> None:
    assert REQUIRED_STEPS == ("start", "transcribe_poll", "analyse", "embed")
    assert missing_steps({"start": object()}) == ["transcribe_poll", "analyse", "embed"]
    assert missing_steps(dict.fromkeys(REQUIRED_STEPS)) == []


def test_worker_env_needs_its_own_login_only() -> None:
    assert worker_env_problems({"DATABASE_URL_WORKER": "postgresql://w"}) == []
    assert worker_env_problems({}) == ["DATABASE_URL_WORKER is not set"]


@pytest.mark.parametrize(
    "name",
    [
        "DATABASE_URL",
        "DATABASE_URL_APP",
        "DATABASE_URL_SERVICE",
        "JWT_PRIVATE_KEY",
        "SMTP_PASSWORD",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_DB_URL",
        "MIGRATION_TARGET_DATABASE_URL",
    ],
)
def test_worker_refuses_credentials_it_must_not_hold(name: str) -> None:
    problems = worker_env_problems({"DATABASE_URL_WORKER": "postgresql://w", name: "x"})
    assert problems == [f"{name} must not be set in the worker container"]


def test_empty_values_do_not_count_as_set() -> None:
    assert worker_env_problems({"DATABASE_URL_WORKER": "w", "DATABASE_URL_APP": ""}) == []
    assert worker_env_problems({"DATABASE_URL_WORKER": " "}) == ["DATABASE_URL_WORKER is not set"]
