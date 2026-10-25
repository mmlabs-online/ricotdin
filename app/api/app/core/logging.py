"""Structured JSON logging with secret redaction (ARC-04, v1 OBS-02).

Every record — message, extra fields and formatted traceback — goes through ``redact`` before it
is written, so a DSN or API key inside an exception never reaches the log stream.
"""

import json
import logging
import sys
from typing import Any

from app.core.redact import redact

LOGGER_NAME = "ricotdin"
_STANDARD = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        extra = {k: v for k, v in record.__dict__.items() if k not in _STANDARD}
        if extra:
            payload["extra"] = extra
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(redact(payload), default=str)


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger(LOGGER_NAME)
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    root.propagate = True  # keep pytest caplog working; uvicorn's root has no handlers of ours


def get_logger(name: str = "") -> logging.Logger:
    return logging.getLogger(f"{LOGGER_NAME}.{name}" if name else LOGGER_NAME)
