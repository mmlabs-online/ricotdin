"""Structured JSON logging with secret redaction (ARC-04, v1 OBS-02).

Every record of our logger and of uvicorn / SQLAlchemy / asyncpg — message, extra fields,
stringified objects and formatted traceback — goes through ``redact`` before it is written.
Access logs drop query strings; uvicorn's duplicate "Exception in ASGI application" traceback
is dropped (our catch-all already logged it, redacted).
"""

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from app.core.redact import redact

LOGGER_NAME = "ricotdin"
REDACTED_LOGGERS = (
    LOGGER_NAME,
    "uvicorn",
    "uvicorn.error",
    "uvicorn.access",
    "sqlalchemy",
    "asyncpg",
)
_STANDARD = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


def _default(obj: object) -> str:
    return str(redact(str(obj)))


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds")
        payload: dict[str, Any] = {
            "ts": ts.replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        extra = {k: v for k, v in record.__dict__.items() if k not in _STANDARD}
        if extra:
            payload["extra"] = extra
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(redact(payload), default=_default)


class AccessLogQueryFilter(logging.Filter):
    """uvicorn.access args are (client, method, full_path, http_version, status)."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            record.args = (*args[:2], args[2].split("?", 1)[0], *args[3:])
        return True


class DropDuplicateAsgiTraceback(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not str(record.msg).startswith("Exception in ASGI application")


def setup_logging(level: str = "INFO") -> None:
    formatter = JsonFormatter()
    for name in REDACTED_LOGGERS:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(formatter)
        if name == "uvicorn.access":
            handler.addFilter(AccessLogQueryFilter())
        if name == "uvicorn.error":
            handler.addFilter(DropDuplicateAsgiTraceback())
        logger = logging.getLogger(name)
        logger.handlers[:] = [handler]
        # Our logger propagates (pytest caplog); third-party ones must not reach an unredacted root.
        logger.propagate = name == LOGGER_NAME
        if name == LOGGER_NAME:
            logger.setLevel(level.upper())
    logging.getLogger("sqlalchemy").setLevel(logging.WARNING)
    logging.getLogger("asyncpg").setLevel(logging.WARNING)


def get_logger(name: str = "") -> logging.Logger:
    return logging.getLogger(f"{LOGGER_NAME}.{name}" if name else LOGGER_NAME)
