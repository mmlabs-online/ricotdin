"""Container health check for the worker (ARC-08d): ``python -m app.worker.health``.

The worker has no HTTP port, so the image's ``/health`` probe does not apply. While the event loop
runs, ``__main__`` touches ``HEARTBEAT_FILE`` every ``HEARTBEAT_INTERVAL_S``; the check passes when
the file is younger than ``HEARTBEAT_MAX_AGE_S`` (a blocked loop or a dead process fails it).
"""

import os
import sys
import time
from pathlib import Path

HEARTBEAT_FILE = Path(os.environ.get("TMPDIR") or "/tmp") / "ricotdin-worker.heartbeat"  # noqa: S108
HEARTBEAT_INTERVAL_S = 30.0
HEARTBEAT_MAX_AGE_S = 90.0


def is_fresh(mtime: float | None, now: float, max_age_s: float = HEARTBEAT_MAX_AGE_S) -> bool:
    return mtime is not None and -5.0 <= now - mtime <= max_age_s


def beat(path: Path = HEARTBEAT_FILE) -> None:
    path.touch()


def check(path: Path = HEARTBEAT_FILE, now: float | None = None) -> bool:
    try:
        mtime: float | None = path.stat().st_mtime
    except OSError:
        mtime = None
    return is_fresh(mtime, time.time() if now is None else now)


if __name__ == "__main__":
    sys.exit(0 if check() else 1)
