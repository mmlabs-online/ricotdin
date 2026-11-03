"""ARC-10b pure admin-ops rules. Ports of v1 ``tests/activity-log.test.ts``
(``parseActivityQueryParams``), ``tests/audit-query.test.ts`` (``parseAuditQueryParams``),
``tests/admin-pipeline.test.ts`` (stuck rule, requeue eligibility) and the ai-usage date range,
plus the v2 bounds (uuid filters, date-only ``to`` is inclusive, range cap, scheduler staleness)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.core.errors import BadRequest
from app.domain.admin_ops import (
    MAX_USAGE_RANGE_DAYS,
    PIPELINE_FILTERS,
    STUCK_MINUTES,
    is_stale_task,
    is_stuck,
    parse_activity_filters,
    parse_audit_filters,
    parse_pipeline_filter,
    parse_usage_range,
)

NOW = datetime(2026, 11, 3, 12, tzinfo=UTC)


# --- pipeline ---------------------------------------------------------------------------------------


def test_pipeline_filter() -> None:
    assert PIPELINE_FILTERS == ("pending", "processing", "done", "failed", "stuck")
    assert parse_pipeline_filter(None) is None and parse_pipeline_filter("") is None
    assert parse_pipeline_filter(" Stuck ") == "stuck"
    with pytest.raises(BadRequest):
        parse_pipeline_filter("deleted")


def test_stuck_rule() -> None:
    assert STUCK_MINUTES == 15  # v1
    old = NOW - timedelta(minutes=16)
    assert is_stuck("processing", old, NOW)
    assert not is_stuck("processing", NOW - timedelta(minutes=14), NOW)
    assert not is_stuck("failed", old, NOW)


def test_task_staleness() -> None:
    every = 300
    assert is_stale_task(None, every, NOW)  # never finished
    assert not is_stale_task(NOW - timedelta(seconds=every * 2), every, NOW)
    assert is_stale_task(NOW - timedelta(seconds=every * 2 + 1), every, NOW)


# --- activity / audit (v1 parsers) ---------------------------------------------------------------


def test_activity_filters() -> None:
    uid = uuid.uuid4()
    f = parse_activity_filters({"page": "2", "perPage": "500", "userId": str(uid),
                                "eventType": "login", "from": "2026-10-01",
                                "to": "2026-10-31"})  # fmt: skip
    assert (f.page, f.per_page, f.user_id, f.event_type) == (2, 100, uid, "login")
    assert f.start == datetime(2026, 10, 1, tzinfo=UTC)
    assert f.end == datetime(2026, 11, 1, tzinfo=UTC)  # a date-only `to` covers that whole day
    f = parse_activity_filters({})
    assert (f.page, f.per_page, f.user_id, f.event_type, f.start, f.end) == (
        1, 20, None, None, None, None,
    )  # fmt: skip
    # an ISO datetime `to` is taken as is (exclusive bound just after it)
    f = parse_activity_filters({"to": "2026-10-31T10:00:00Z"})
    assert f.end == datetime(2026, 10, 31, 10, 0, 0, 1, tzinfo=UTC)
    # invalid dates are ignored (v1 audit parser); a bad user id is a 400 (v1 crashed with a 500)
    assert parse_activity_filters({"from": "nope"}).start is None
    with pytest.raises(BadRequest):
        parse_activity_filters({"userId": "x"})
    assert parse_activity_filters({"eventType": "e" * 200}).event_type == "e" * 64


def test_audit_filters() -> None:
    uid = uuid.uuid4()
    f = parse_audit_filters({"actor": str(uid), "action": "user.", "page": "abc"})
    assert (f.actor, f.action, f.page) == (uid, "user.", 1)
    assert parse_audit_filters({"actor": ""}).actor is None
    with pytest.raises(BadRequest):
        parse_audit_filters({"actor": "admin@example.com"})


# --- ai usage --------------------------------------------------------------------------------------


def test_usage_range() -> None:
    start, end = parse_usage_range(None, None, NOW)
    assert (start, end) == (NOW - timedelta(days=30), NOW)  # v1 default: last 30 days
    start, end = parse_usage_range("2026-10-01", "2026-10-02", NOW)
    assert (start, end) == (datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 10, 2, tzinfo=UTC))
    assert parse_usage_range("garbage", None, NOW)[0] == NOW - timedelta(days=30)
    with pytest.raises(BadRequest) as err:
        parse_usage_range("2026-10-02", "2026-10-01", NOW)
    assert err.value.public_message == '"from" must be earlier than "to".'
    with pytest.raises(BadRequest):
        parse_usage_range("2020-01-01", "2026-01-01", NOW)
    assert MAX_USAGE_RANGE_DAYS == 400
