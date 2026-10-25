"""ARC-04 review round 1 (B1): every log line — ours, uvicorn's, SQLAlchemy's — is JSON and
redacted; access logs never carry query strings (ARC-05 verify/reset links put tokens there)."""

import json
import logging
import sys

from app.core.logging import (
    REDACTED_LOGGERS,
    AccessLogQueryFilter,
    DropDuplicateAsgiTraceback,
    JsonFormatter,
    setup_logging,
)


class _Obj:
    def __str__(self) -> str:
        return "postgresql://u:pw@h/db"


def _record(msg: str, *args: object, **extra: object) -> logging.LogRecord:
    rec = logging.LogRecord("ricotdin.t", logging.ERROR, __file__, 1, msg, args, None)
    rec.__dict__.update(extra)
    return rec


def test_message_extra_and_non_string_objects_are_redacted() -> None:
    out = json.loads(JsonFormatter().format(_record("db %s", "postgresql://u:pw@h/db", obj=_Obj())))
    assert "pw@" not in json.dumps(out)
    assert out["level"] == "ERROR" and out["logger"] == "ricotdin.t"


def test_traceback_text_is_redacted() -> None:
    try:
        raise RuntimeError("password=hunter2")
    except RuntimeError:
        rec = _record("boom")
        rec.exc_info = sys.exc_info()
    assert "hunter2" not in JsonFormatter().format(rec)


def test_timestamps_are_utc_with_milliseconds() -> None:
    ts = json.loads(JsonFormatter().format(_record("x")))["ts"]
    assert ts.endswith("Z") and "." in ts


def test_access_log_drops_query_strings() -> None:
    rec = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s %s HTTP/%s" %d', ("1.2.3.4:5", "GET", "/auth/verify?token=abc", "1.1", 200), None,
    )  # fmt: skip
    assert AccessLogQueryFilter().filter(rec)
    assert "token=abc" not in rec.getMessage()
    assert "/auth/verify" in rec.getMessage()


def test_uvicorns_duplicate_asgi_traceback_is_dropped() -> None:
    f = DropDuplicateAsgiTraceback()
    assert not f.filter(_record("Exception in ASGI application\n"))
    assert f.filter(_record("Started server process [1]"))


def test_setup_routes_third_party_loggers_through_the_json_formatter() -> None:
    setup_logging("INFO")
    for name in REDACTED_LOGGERS:
        handlers = logging.getLogger(name).handlers
        assert handlers and all(isinstance(h.formatter, JsonFormatter) for h in handlers), name
        assert not logging.getLogger(name).propagate or name == "ricotdin"
    assert {"uvicorn.error", "uvicorn.access", "sqlalchemy", "asyncpg"} <= set(REDACTED_LOGGERS)
