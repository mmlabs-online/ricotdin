"""Worker policy (ARC-08). Pure: timings, retry decisions, the per-job deadline, the steps a
deployable worker needs and the environment its container may hold."""

from collections.abc import Collection, Mapping
from datetime import UTC, datetime
from typing import Any

POLL_INTERVAL_S = 1.0  # idle sleep between claims (v1)
SWEEP_INTERVAL_S = 60.0  # stuck-job sweep (v1)
STUCK_THRESHOLD_S = 15 * 60  # running with locked_at older than this = stuck (v1, ADM-04)
# One step may run this long; below the stuck threshold so the sweeper never requeues a job a
# live worker is still running. A slow provider poll belongs in a re-queued step, not a wait.
STEP_TIMEOUT_S = 12 * 60
# Whole pipeline, counted from the first `start` (payload.started_at). Bounds re-queued polling
# steps (transcribe_poll, 08b) that never finish; the job then fails with a refund.
JOB_MAX_AGE_S = 6 * 60 * 60
FIRST_POLL_DELAY_S = 5.0  # start → transcribe_poll (v1)

REQUIRED_STEPS = ("start", "transcribe_poll", "analyse", "embed")

# Only DATABASE_URL_WORKER: an RCE through ffmpeg / untrusted audio must not reach any other
# credential (ARC-04 security review). KEY_ENCRYPTION_SECRET is needed (provider keys, Drive).
FORBIDDEN_ENV = (
    "DATABASE_URL",
    "DATABASE_URL_APP",
    "DATABASE_URL_SERVICE",
    "JWT_PRIVATE_KEY",
    "JWT_PREVIOUS_PUBLIC_KEY",
    "SMTP_PASSWORD",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_URL",
    "MIGRATION_TARGET_DATABASE_URL",
)


def retry_decision(attempts: int, max_attempts: int, *, terminal: bool) -> tuple[bool, int]:
    """(retry?, new attempts) after a failed run of a job with ``attempts`` before it."""
    new_attempts = attempts + 1
    return (not terminal and new_attempts < max_attempts), new_attempts


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def deadline_exceeded(
    payload: Mapping[str, Any], now: datetime, *, max_age_s: float = JOB_MAX_AGE_S
) -> bool:
    started = _parse_time(payload.get("started_at"))
    return started is not None and (now - started).total_seconds() > max_age_s


def missing_steps(registry: Collection[str]) -> list[str]:
    return [step for step in REQUIRED_STEPS if step not in registry]


def worker_env_problems(env: Mapping[str, str]) -> list[str]:
    problems: list[str] = []
    if not env.get("DATABASE_URL_WORKER", "").strip():
        problems.append("DATABASE_URL_WORKER is not set")
    for name in FORBIDDEN_ENV:
        if env.get(name, "").strip():
            problems.append(f"{name} must not be set in the worker container")
    return problems
