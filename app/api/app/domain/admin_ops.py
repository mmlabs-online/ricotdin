"""Admin operations rules (ARC-10b; port of v1 ``lib/activity/parse.ts``,
``lib/admin/audit-query.ts``, the pipeline stuck rule and the ai-usage date range). Pure.

v2 differences: ``userId`` / ``actor`` must be uuids (400; v1 sent them to Postgres and crashed),
a date-only ``to`` covers that whole day (v1 appended ``T23:59:59Z``), the usage range is capped.
"""

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.core.errors import BadRequest
from app.domain.admin import parse_list_params

PIPELINE_FILTERS = ("pending", "processing", "done", "failed", "stuck")
STUCK_MINUTES = 15  # v1: processing and not updated for 15 min
MAX_USAGE_RANGE_DAYS = 400
DEFAULT_USAGE_DAYS = 30  # v1
MAX_FILTER_CHARS = 64


def parse_pipeline_filter(raw: str | None) -> str | None:
    value = (raw or "").strip().lower()
    if not value:
        return None
    if value not in PIPELINE_FILTERS:
        raise BadRequest(f"status must be one of: {', '.join(PIPELINE_FILTERS)}.")
    return value


def is_stuck(status: str, updated_at: datetime, now: datetime) -> bool:
    return status == "processing" and updated_at < now - timedelta(minutes=STUCK_MINUTES)


def is_stale_task(last_finished_at: datetime | None, every_s: int, now: datetime) -> bool:
    """A scheduler task that has not finished for two intervals is stale (CLAUDE.md §0.7: a
    poisoned lease or a stopped worker)."""
    return last_finished_at is None or last_finished_at < now - timedelta(seconds=2 * every_s)


# --- dates ----------------------------------------------------------------------------------------


def _instant(raw: Any) -> tuple[datetime, bool] | None:
    """(UTC instant, date-only?) or None when not a date (ignored, v1)."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    try:
        if len(text) == 10:
            d = date.fromisoformat(text)
            return datetime(d.year, d.month, d.day, tzinfo=UTC), True
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    if not 1970 <= value.year <= 2100:
        return None
    return value.astimezone(UTC), False


def _range(query: Mapping[str, Any]) -> tuple[datetime | None, datetime | None]:
    start = _instant(query.get("from"))
    end = _instant(query.get("to"))
    upper = None
    if end is not None:
        # exclusive bound: the whole day for a date, just after the instant otherwise
        upper = end[0] + (timedelta(days=1) if end[1] else timedelta(microseconds=1))
    return (start[0] if start else None), upper


def _uuid(raw: Any, name: str) -> uuid.UUID | None:
    if raw is None or raw == "":
        return None
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise BadRequest(f"{name} must be a user id.") from None


def _text(raw: Any) -> str | None:
    value = str(raw).strip()[:MAX_FILTER_CHARS] if raw is not None else ""
    return value or None


# --- activity / audit -----------------------------------------------------------------------------


@dataclass(frozen=True)
class ActivityFilters:
    page: int
    per_page: int
    user_id: uuid.UUID | None
    event_type: str | None
    start: datetime | None
    end: datetime | None


def parse_activity_filters(query: Mapping[str, Any]) -> ActivityFilters:
    paging = parse_list_params(query)
    start, end = _range(query)
    return ActivityFilters(
        paging.page,
        paging.per_page,
        _uuid(query.get("userId"), "userId"),
        _text(query.get("eventType")),
        start,
        end,
    )


@dataclass(frozen=True)
class AuditFilters:
    page: int
    per_page: int
    actor: uuid.UUID | None
    action: str | None  # prefix
    start: datetime | None
    end: datetime | None


def parse_audit_filters(query: Mapping[str, Any]) -> AuditFilters:
    paging = parse_list_params(query)
    start, end = _range(query)
    return AuditFilters(
        paging.page,
        paging.per_page,
        _uuid(query.get("actor"), "actor"),
        _text(query.get("action")),
        start,
        end,
    )


# --- ai usage -------------------------------------------------------------------------------------


def parse_usage_range(
    raw_from: str | None, raw_to: str | None, now: datetime
) -> tuple[datetime, datetime]:
    """``from`` / ``to`` instants (a date = its midnight, v1); defaults last 30 days → now."""
    start = _instant(raw_from)
    end = _instant(raw_to)
    lower = start[0] if start else now - timedelta(days=DEFAULT_USAGE_DAYS)
    upper = end[0] if end else now
    if lower >= upper:
        raise BadRequest('"from" must be earlier than "to".')
    if upper - lower > timedelta(days=MAX_USAGE_RANGE_DAYS):
        raise BadRequest(f"The range may span at most {MAX_USAGE_RANGE_DAYS} days.")
    return lower, upper
